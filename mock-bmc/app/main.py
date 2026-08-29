"""FastAPI app assembling Redfish + chaos routers over the Fleet simulator."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI

from app.chaos import build_chaos_router
from app.redfish import build_router as build_redfish_router
from app.state import Fleet

logger = logging.getLogger("mock-bmc")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run fleet tick loop in background; cancel on shutdown."""
    fleet: Fleet = app.state.fleet
    interval: float = app.state.tick_interval_s

    async def tick_loop() -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                fleet.tick(interval)
            except Exception:
                logger.exception("fleet tick failed")

    task = asyncio.create_task(tick_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


def create_app(node_ids: list[str] | None = None, tick_interval_s: float = 1.0) -> FastAPI:
    """Build the mock-BMC FastAPI application."""
    if node_ids is None:
        node_ids = [f"R4-N{i:02d}" for i in range(1, 13)]
    fleet = Fleet(node_ids)

    app = FastAPI(title="mock-bmc", lifespan=lifespan)
    app.state.fleet = fleet
    app.state.tick_interval_s = tick_interval_s

    app.include_router(build_redfish_router(fleet))
    app.include_router(build_chaos_router(fleet))

    @app.get("/")
    def root() -> dict[str, Any]:
        return {
            "service": "mock-bmc",
            "nodes": len(node_ids),
            "redfish": "/redfish/v1/",
            "chaos": "/chaos/status",
        }

    return app


app = create_app()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8100)
