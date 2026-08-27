"""VNC reverse proxy for agent server.

Proxies noVNC HTTP requests and WebSocket connections through the agent server,
so the frontend can access VNC without needing direct access to the VNC port.
This solves port accessibility issues in containerized/sandbox environments.

All heavy imports (httpx, websockets) are lazy-loaded inside route handlers
so the module can be imported without those packages being installed.
"""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from starlette.websockets import WebSocketState

from openhands.sdk.logger import get_logger


logger = get_logger(__name__)

vnc_proxy_router = APIRouter(prefix="/desktop/vnc-proxy", tags=["Desktop VNC Proxy"])

# VNC server configuration
VNC_HOST = os.getenv("VNC_HOST", "127.0.0.1")
NOVNC_PORT = int(os.getenv("NOVNC_PORT", "8002"))
NOVNC_BASE_URL = f"http://{VNC_HOST}:{NOVNC_PORT}"


@vnc_proxy_router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_http_request(request: Request, path: str = ""):
    """Proxy HTTP requests to the noVNC server."""
    try:
        import httpx
    except ImportError:
        logger.warning("httpx not installed — VNC proxy unavailable")
        return Response(content="VNC proxy unavailable (httpx not installed)", status_code=503)

    target_url = f"{NOVNC_BASE_URL}/{path}"

    # Preserve query parameters
    if request.query_params:
        target_url = f"{target_url}?{request.query_params}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Forward the request
            headers = dict(request.headers)
            # Remove hop-by-hop headers
            for header in ["host", "connection", "transfer-encoding"]:
                headers.pop(header, None)

            body = await request.body()

            response = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
            )

            # Filter response headers
            response_headers = dict(response.headers)
            for header in ["transfer-encoding", "connection", "content-encoding"]:
                response_headers.pop(header, None)

            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=response_headers,
            )

    except httpx.ConnectError:
        logger.error(f"Cannot connect to VNC server at {NOVNC_BASE_URL}")
        return Response(
            content="VNC server not available",
            status_code=503,
        )
    except Exception as e:
        logger.error(f"VNC proxy error: {e}")
        return Response(
            content=f"Proxy error: {str(e)}",
            status_code=502,
        )


@vnc_proxy_router.websocket("/websockify")
async def proxy_websocket(websocket: WebSocket):
    """Proxy WebSocket connections to the VNC server."""
    await websocket.accept()

    try:
        import websockets
    except ImportError:
        logger.warning("websockets not installed — VNC WebSocket proxy unavailable")
        await websocket.close(code=1011, reason="websockets not installed")
        return

    target_ws_url = f"ws://{VNC_HOST}:{NOVNC_PORT}/websockify"

    try:
        async with websockets.connect(target_ws_url) as target_ws:
            async def forward_client_to_target():
                try:
                    while True:
                        data = await websocket.receive_bytes()
                        await target_ws.send(data)
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    logger.debug(f"Client to target error: {e}")

            async def forward_target_to_client():
                try:
                    async for message in target_ws:
                        if websocket.client_state == WebSocketState.CONNECTED:
                            if isinstance(message, bytes):
                                await websocket.send_bytes(message)
                            else:
                                await websocket.send_text(message)
                except Exception as e:
                    logger.debug(f"Target to client error: {e}")

            await asyncio.gather(
                forward_client_to_target(),
                forward_target_to_client(),
            )

    except Exception as e:
        logger.error(f"WebSocket proxy error: {e}")
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.close(code=1011, reason=f"Proxy error: {str(e)}")
