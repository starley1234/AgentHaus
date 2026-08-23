"""Optional GitHub App integration for deterministic PR-only publishing.

This router intentionally does not replace the agent's existing git workflow.
It only reports whether an installation-based GitHub App is configured; the
PR creation endpoint is added separately once the workspace change-set contract
is complete. Keeping configuration and token minting server-side prevents a
GitHub App private key from ever reaching the browser or an agent workspace.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from openhands.sdk.logger import get_logger

logger = get_logger(__name__)
github_app_router = APIRouter(prefix="/github-app", tags=["GitHub App"])

_GITHUB_API = "https://api.github.com"


class GitHubAppStatus(BaseModel):
    enabled: bool
    mode: str = "pr-only"
    reason: str | None = None


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
                private_key = open(private_key_file, encoding="utf-8").read().strip()
            except OSError as error:
                logger.warning("github_app_private_key_file_unreadable: %s", error)
        if not app_id or not installation_id or not private_key:
            return None
        return cls(app_id=app_id, installation_id=installation_id, private_key=private_key)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _app_jwt(config: GitHubAppConfig) -> str:
    """Create the short-lived RS256 JWT required by the GitHub App API."""
    now = int(time.time())
    header = _base64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _base64url(json.dumps({"iat": now - 30, "exp": now + 540, "iss": config.app_id}, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode("ascii")
    key = serialization.load_pem_private_key(config.private_key.encode(), password=None)
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_base64url(signature)}"


async def mint_installation_token(config: GitHubAppConfig) -> str:
    """Mint a short-lived installation token. Never return it to the browser."""
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{_GITHUB_API}/app/installations/{config.installation_id}/access_tokens",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {_app_jwt(config)}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    if response.is_error:
        logger.warning("github_app_token_mint_failed: status=%s", response.status_code)
        raise HTTPException(status_code=502, detail="GitHub App token request failed")
    token = response.json().get("token")
    if not isinstance(token, str) or not token:
        raise HTTPException(status_code=502, detail="GitHub App returned no installation token")
    return token


@github_app_router.get("/status")
async def github_app_status() -> GitHubAppStatus:
    """Return capability only; no credentials, installation ID or token leak."""
    config = GitHubAppConfig.from_env()
    return GitHubAppStatus(
        enabled=config is not None,
        reason=None if config else "GitHub App is not configured",
    )
