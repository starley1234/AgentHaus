"""MCP integration catalog loaded from the OpenHands extensions repository.

The frontend bundles an MCP "marketplace" (known MCP servers with connection
options) compiled from the `OpenHands/extensions` repository into the
`@openhands/extensions/integrations` npm package. This backend module exposes
the same catalog to the agent-server by reading the repository directly, so
backend and UI stay consistent without duplicating the catalog in code.

The repository is cached under ``~/.openhands/cache/skills`` (shared with the
public skills cache) and refreshed like skills are. Catalog entries are read
from the ``integrations/`` directory of the repo; each entry is a JSON file
describing one integration (provider ``mcp``, connection options, auth, etc.).

This is intentionally resilient: any load failure returns an empty list and
logs a warning, so a missing/unreachable catalog never breaks the agent.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from openhands.sdk.logger import get_logger
from openhands.sdk.skills.utils import (
    get_skills_cache_dir,
    update_skills_repository,
)

logger = get_logger(__name__)

# Relative directory in the extensions repo that holds MCP integration entries.
_INTEGRATIONS_DIR = "integrations"

# Repository / ref, matching the public skills source so both share one clone.
# Overridable via EXTENSIONS_REPO / EXTENSIONS_REF (see skills/skill.py).
_PUBLIC_EXTENSIONS_REPO = "https://github.com/OpenHands/extensions"


def load_mcp_integration_catalog(
    repo_url: str = _PUBLIC_EXTENSIONS_REPO,
    ref: str | None = None,
) -> list[dict[str, Any]]:
    """Load the MCP integration catalog from the extensions repository.

    Args:
        repo_url: URL of the extensions repository.
        ref: Branch/tag/commit. Defaults to EXTENSIONS_REF env or "main".

    Returns:
        A list of integration dicts, or an empty list on any failure.
    """
    import os

    if ref is None:
        ref = os.environ.get("EXTENSIONS_REF", "main")

    cache_dir = get_skills_cache_dir()
    repo_path = update_skills_repository(repo_url, ref, cache_dir)
    if repo_path is None:
        logger.warning(
            "Could not fetch extensions repository %s (ref=%s) for the MCP "
            "integration catalog. Check the proxy / network and credentials.",
            repo_url,
            ref,
        )
        return []

    integrations_dir = repo_path / _INTEGRATIONS_DIR
    if not integrations_dir.is_dir():
        logger.warning(
            "No '%s' directory found in %s; MCP integration catalog is empty. "
            "The extensions repository layout may have changed.",
            _INTEGRATIONS_DIR,
            repo_url,
        )
        return []

    entries: list[dict[str, Any]] = []
    for path in sorted(integrations_dir.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Skipping unreadable integration file %s: %s", path, exc)
            continue
        # A single file may contain a list of integrations or one integration.
        if isinstance(data, list):
            entries.extend(x for x in data if isinstance(x, dict))
        elif isinstance(data, dict):
            entries.append(data)

    logger.info("Loaded %d MCP integration(s) from %s", len(entries), repo_url)
    return entries
