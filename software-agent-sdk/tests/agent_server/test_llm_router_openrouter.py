"""Tests for the live OpenRouter catalog endpoint (`/api/llm/openrouter/models`)."""

from typing import Any

import pytest

from openhands.agent_server.llm_router import (
    _OPENROUTER_CATALOG,
    _OPENROUTER_CATALOG_FETCHED_AT_MONOTONIC,
    _OPENROUTER_CATALOG_FETCHED_AT_WALL,
    _fetch_openrouter_catalog_sync,
    list_openrouter_models,
)


@pytest.fixture(autouse=True)
def reset_catalog_cache():
    """Reset the module-level cache around each test."""
    global _OPENROUTER_CATALOG
    global _OPENROUTER_CATALOG_FETCHED_AT_MONOTONIC
    global _OPENROUTER_CATALOG_FETCHED_AT_WALL
    import openhands.agent_server.llm_router as llm_router_module

    llm_router_module._OPENROUTER_CATALOG = None
    llm_router_module._OPENROUTER_CATALOG_FETCHED_AT_MONOTONIC = 0.0
    llm_router_module._OPENROUTER_CATALOG_FETCHED_AT_WALL = None
    yield
    llm_router_module._OPENROUTER_CATALOG = None
    llm_router_module._OPENROUTER_CATALOG_FETCHED_AT_MONOTONIC = 0.0
    llm_router_module._OPENROUTER_CATALOG_FETCHED_AT_WALL = None


def test_parse_openrouter_payload():
    payload = {
        "data": [
            {
                "id": "google/gemini-3.8-flash",
                "name": "Gemini 3.8 Flash",
                "context_length": 1_048_576,
                "pricing": {"prompt": "0.000001", "completion": "0.000004"},
            },
            {
                "id": "broken-entry",
            },
            "not-a-dict",
        ]
    }
    with pytest.MonkeyPatch.context() as mp:
        import httpx

        def fake_get(*args: Any, **kwargs: Any):
            class Resp:
                def raise_for_status(self) -> None: ...

                def json(self) -> dict[str, Any]:
                    return payload

            return Resp()

        mp.setattr(httpx, "get", fake_get)
        models = _fetch_openrouter_catalog_sync()

    assert [m.id for m in models] == ["google/gemini-3.8-flash"]
    info = models[0]
    assert info.context_length == 1_048_576
    assert info.prompt_price_per_token == 0.000001
    assert info.completion_price_per_token == 0.000004


@pytest.mark.asyncio
async def test_endpoint_serves_live_then_cached(monkeypatch: pytest.MonkeyPatch):
    import openhands.agent_server.llm_router as llm_router_module

    calls: list[int] = []

    def fake_fetch() -> list:
        from openhands.agent_server.llm_router import OpenRouterModelInfo

        calls.append(1)
        return [
            OpenRouterModelInfo(
                id="openrouter/auto",
                context_length=1_000_000,
                prompt_price_per_token=0.0,
                completion_price_per_token=0.0,
            )
        ]

    monkeypatch.setattr(
        llm_router_module, "_fetch_openrouter_catalog_sync", fake_fetch
    )

    first = await list_openrouter_models()
    assert first.source == "live"
    assert [m.id for m in first.models] == ["openrouter/auto"]
    assert first.fetched_at is not None
    assert len(calls) == 1

    second = await list_openrouter_models()
    assert second.source == "cache"
    assert len(calls) == 1  # served from the in-memory cache
    assert [m.id for m in second.models] == ["openrouter/auto"]


@pytest.mark.asyncio
async def test_endpoint_serves_stale_cache_on_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    import openhands.agent_server.llm_router as llm_router_module
    from openhands.agent_server.llm_router import OpenRouterModelInfo

    llm_router_module._OPENROUTER_CATALOG = [
        OpenRouterModelInfo(id="cached/model", context_length=8_192)
    ]
    llm_router_module._OPENROUTER_CATALOG_FETCHED_AT_MONOTONIC = (
        llm_router_module.time.monotonic() - 10_000.0  # long expired
    )
    llm_router_module._OPENROUTER_CATALOG_FETCHED_AT_WALL = 123

    def broken_fetch() -> list:
        raise RuntimeError("openrouter unreachable")

    monkeypatch.setattr(
        llm_router_module, "_fetch_openrouter_catalog_sync", broken_fetch
    )

    response = await list_openrouter_models()
    assert response.source == "cache"
    assert [m.id for m in response.models] == ["cached/model"]
