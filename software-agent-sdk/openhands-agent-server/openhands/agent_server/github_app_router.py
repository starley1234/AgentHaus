"""Optional, deterministic GitHub App PR publishing.

The existing agent-driven git/PAT/SSH workflow is deliberately untouched. This
router is enabled only when a GitHub App installation is configured and creates
one feature branch, one commit, and one pull request from the current working
tree. The App private key and short-lived installation token never leave the
agent-server process.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import stat
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from openhands.sdk.logger import get_logger

logger = get_logger(__name__)
github_app_router = APIRouter(prefix="/github-app", tags=["GitHub App"])

_GITHUB_API = "https://api.github.com"
_MAX_CHANGED_FILES = 200
_MAX_TOTAL_BYTES = 10 * 1024 * 1024
_BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$")
_GITHUB_REMOTE_RE = re.compile(
    r"^(?:git@github\.com:|https?://github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$"
)


class GitHubAppStatus(BaseModel):
    enabled: bool
    mode: str = "pr-only"
    reason: str | None = None


class CreatePullRequest(BaseModel):
    path: str = Field(description="Absolute workspace or repository path")
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=65_000)
    branch: str | None = Field(default=None, max_length=120)
    base_branch: str | None = Field(default=None, max_length=255)


class CreatedPullRequest(BaseModel):
    url: str
    number: int
    branch: str
    commit_sha: str
    changed_files: int


@dataclass(frozen=True)
class GitHubAppConfig:
    app_id: str
    installation_id: str
    private_key: str

    @classmethod
    def from_env(cls) -> "GitHubAppConfig | None":
        app_id = os.getenv("GITHUB_APP_ID", "").strip()
        installation_id = os.getenv("GITHUB_APP_INSTALLATION_ID", "").strip()
        private_key = os.getenv("GITHUB_APP_PRIVATE_KEY", "").replace("\\n", "\n").strip()
        private_key_file = os.getenv("GITHUB_APP_PRIVATE_KEY_FILE", "").strip()
        if private_key_file and not private_key:
            try:
                private_key = Path(private_key_file).read_text(encoding="utf-8").strip()
            except OSError as error:
                logger.warning("github_app_private_key_file_unreadable: %s", error)
        if not app_id or not installation_id or not private_key:
            return None
        return cls(app_id=app_id, installation_id=installation_id, private_key=private_key)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _app_jwt(config: GitHubAppConfig) -> str:
    now = int(time.time())
    header = _base64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _base64url(json.dumps({"iat": now - 30, "exp": now + 540, "iss": config.app_id}, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode("ascii")
    key = serialization.load_pem_private_key(config.private_key.encode(), password=None)
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_base64url(signature)}"


async def mint_installation_token(config: GitHubAppConfig) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{_GITHUB_API}/app/installations/{config.installation_id}/access_tokens",
            headers={"Accept": "application/vnd.github+json", "Authorization": f"Bearer {_app_jwt(config)}", "X-GitHub-Api-Version": "2022-11-28"},
        )
    if response.is_error:
        logger.warning("github_app_token_mint_failed: status=%s", response.status_code)
        raise HTTPException(status_code=502, detail="GitHub App token request failed")
    token = response.json().get("token")
    if not isinstance(token, str) or not token:
        raise HTTPException(status_code=502, detail="GitHub App returned no installation token")
    return token


def _git(root: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=True, timeout=30).stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ValueError("Workspace is not a usable git repository") from error


def _repo_context(path: str, requested_base: str | None) -> tuple[Path, str, str, str, str]:
    target = Path(path)
    if not target.is_absolute() or not target.is_dir():
        raise ValueError("path must be an existing absolute directory")
    root = Path(_git(target, "rev-parse", "--show-toplevel"))
    remote = _git(root, "remote", "get-url", "origin")
    match = _GITHUB_REMOTE_RE.fullmatch(remote)
    if not match:
        raise ValueError("origin must be a github.com repository")
    owner, repository = match.groups()
    base = requested_base or _git(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").removeprefix("origin/")
    if not base:
        raise ValueError("base branch could not be determined")
    base_sha = _git(root, "rev-parse", f"origin/{base}")
    return root, owner, repository.removesuffix(".git"), base, base_sha


def _changed_paths(root: Path, base_sha: str) -> tuple[set[str], set[str]]:
    # NUL separators preserve unusual but valid file names. Renames need an
    # explicit old-path deletion because the GitHub tree API starts from base.
    raw = subprocess.run(["git", "diff", "--name-status", "-z", base_sha, "--"], cwd=root, capture_output=True, check=True, timeout=30).stdout.decode("utf-8", "surrogateescape").split("\0")
    current: set[str] = set()
    deleted: set[str] = set()
    index = 0
    while index < len(raw) and raw[index]:
        status = raw[index]; index += 1
        if status.startswith("R") or status.startswith("C"):
            old, new = raw[index], raw[index + 1]; index += 2
            if status.startswith("R"):
                deleted.add(old)
            current.add(new)
        else:
            name = raw[index]; index += 1
            (deleted if status.startswith("D") else current).add(name)
    untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    current.update(item for item in untracked if item)
    return current, deleted


def _safe_relative(path: str) -> str:
    relative = PurePosixPath(path)
    if relative.is_absolute() or ".." in relative.parts or not path or "\x00" in path:
        raise ValueError("unsafe repository path")
    return relative.as_posix()


async def _github(client: httpx.AsyncClient, method: str, path: str, token: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    response = await client.request(method, f"{_GITHUB_API}{path}", headers={"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28"}, json=payload)
    if response.is_error:
        logger.warning("github_app_api_failed: method=%s path=%s status=%s", method, path, response.status_code)
        raise HTTPException(status_code=502, detail="GitHub API request failed")
    return response.json()


async def _append_audit(event: dict[str, Any]) -> None:
    persistence = Path(os.getenv("OH_PERSISTENCE_DIR", str(Path.home() / ".openhands")))
    audit = persistence / "github_app_audit.jsonl"
    def write() -> None:
        audit.parent.mkdir(parents=True, exist_ok=True)
        with open(audit, "a", encoding="utf-8") as file:
            file.write(json.dumps(event, sort_keys=True) + "\n")
        os.chmod(audit, 0o600)
    await asyncio.to_thread(write)


@github_app_router.get("/status")
async def github_app_status() -> GitHubAppStatus:
    config = GitHubAppConfig.from_env()
    return GitHubAppStatus(enabled=config is not None, reason=None if config else "GitHub App is not configured")


@github_app_router.post("/pull-requests", response_model=CreatedPullRequest)
async def create_pull_request(request: CreatePullRequest) -> CreatedPullRequest:
    """Create one App-authored branch, commit and PR from working-tree changes."""
    config = GitHubAppConfig.from_env()
    if config is None:
        raise HTTPException(status_code=503, detail="GitHub App is not configured")
    try:
        root, owner, repository, base, base_sha = await asyncio.to_thread(_repo_context, request.path, request.base_branch)
        current, deleted = await asyncio.to_thread(_changed_paths, root, base_sha)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if not current and not deleted:
        raise HTTPException(status_code=422, detail="Workspace has no changes to publish")
    if len(current) + len(deleted) > _MAX_CHANGED_FILES:
        raise HTTPException(status_code=422, detail=f"Too many changed files (limit {_MAX_CHANGED_FILES})")
    branch = request.branch or f"agenthaus/{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}"
    if not _BRANCH_RE.fullmatch(branch) or branch.startswith("-") or ".." in branch or branch.endswith("/"):
        raise HTTPException(status_code=422, detail="Invalid feature branch name")

    token = await mint_installation_token(config)
    entries: list[dict[str, Any]] = []
    total_bytes = 0
    async with httpx.AsyncClient(timeout=30) as client:
        base_commit = await _github(client, "GET", f"/repos/{owner}/{repository}/git/commits/{base_sha}", token)
        base_tree = base_commit["tree"]["sha"]
        for raw_path in sorted(current):
            relative = _safe_relative(raw_path)
            file_path = root / relative
            try:
                file_stat = file_path.lstat()
                if not stat.S_ISREG(file_stat.st_mode) or file_path.is_symlink():
                    raise ValueError(f"Only regular files can be published: {relative}")
                data = file_path.read_bytes()
            except OSError as error:
                raise HTTPException(status_code=422, detail=f"Cannot read changed file: {relative}") from error
            total_bytes += len(data)
            if total_bytes > _MAX_TOTAL_BYTES:
                raise HTTPException(status_code=422, detail="Changed files exceed 10 MiB limit")
            blob = await _github(client, "POST", f"/repos/{owner}/{repository}/git/blobs", token, {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
            entries.append({"path": relative, "mode": "100755" if file_stat.st_mode & stat.S_IXUSR else "100644", "type": "blob", "sha": blob["sha"]})
        entries.extend({"path": _safe_relative(path), "mode": "100644", "type": "blob", "sha": None} for path in sorted(deleted))
        tree = await _github(client, "POST", f"/repos/{owner}/{repository}/git/trees", token, {"base_tree": base_tree, "tree": entries})
        commit = await _github(client, "POST", f"/repos/{owner}/{repository}/git/commits", token, {"message": request.title, "tree": tree["sha"], "parents": [base_sha]})
        await _github(client, "POST", f"/repos/{owner}/{repository}/git/refs", token, {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
        pull = await _github(client, "POST", f"/repos/{owner}/{repository}/pulls", token, {"title": request.title, "body": request.body, "head": branch, "base": base})
    result = CreatedPullRequest(url=pull["html_url"], number=pull["number"], branch=branch, commit_sha=commit["sha"], changed_files=len(entries))
    await _append_audit({"at": datetime.now(UTC).isoformat(), "event": "github_app_pr_created", "repository": f"{owner}/{repository}", "base": base, "branch": branch, "commit": commit["sha"], "pr": pull["html_url"], "files": len(entries)})
    logger.info("github_app_pr_created: repository=%s/%s branch=%s pr=%s", owner, repository, branch, pull["html_url"])
    return result
