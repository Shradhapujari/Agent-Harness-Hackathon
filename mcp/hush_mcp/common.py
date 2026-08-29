"""Shared MCP plumbing: server factory, JSON logging, idempotency, error envelope.

Every tool in this package returns JSON and never raises at the model boundary:
a failure comes back as ``{"error": {"code", "message"}}`` (specs/graph.md §5)
so the agent can reason about it instead of losing the turn to a transport error.
"""
from __future__ import annotations

import functools
import json
import logging
import os
import sys
from collections.abc import Callable
from typing import Any

from mcp.server.mcpserver import MCPServer

#: Servers bind to loopback only; the harness reaches them from the same laptop.
HOST = "127.0.0.1"
MCP_PATH = "/mcp"

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(message)s")
log = logging.getLogger("hush-mcp")


def make_server(name: str) -> MCPServer:
    """An MCP server named for its layer; the port is supplied at run time."""
    return MCPServer(name)


def run_server(server: MCPServer, port: int) -> None:
    """Serve one MCP server over streamable-http at http://127.0.0.1:<port>/mcp."""
    server.run(transport="streamable-http", host=HOST, port=port, streamable_http_path=MCP_PATH)


def env(name: str, default: str) -> str:
    return os.getenv(name, default)


def guarded[**P](fn: Callable[P, dict[str, Any]]) -> Callable[P, dict[str, Any]]:
    """Log the call and turn any exception into the error envelope."""

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> dict[str, Any]:
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - tool boundary
            log.error(json.dumps({"tool": fn.__name__, "error": str(exc), "code": type(exc).__name__}))
            return {"error": {"code": type(exc).__name__, "message": str(exc)}}
        log.info(json.dumps({"tool": fn.__name__, "ok": "error" not in result}))
        return result

    return wrapper


_IDEMPOTENT: dict[str, dict[str, Any]] = {}


def idempotent[**P](fn: Callable[P, dict[str, Any]]) -> Callable[P, dict[str, Any]]:
    """Return the first successful result for a repeated ``idempotency_key``.

    A replan or an approval retry must not power-cycle a machine twice, so the
    side effect happens once per key and later calls get ``replayed: true``.
    Failures are not cached: a retry after an error is a genuine retry.
    """
    inner = guarded(fn)

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> dict[str, Any]:
        key = str(kwargs.get("idempotency_key", ""))
        if key and key in _IDEMPOTENT:
            log.info(json.dumps({"tool": fn.__name__, "key": key, "replayed": True}))
            return {**_IDEMPOTENT[key], "replayed": True}
        result = inner(*args, **kwargs)
        if key and "error" not in result:
            _IDEMPOTENT[key] = result
        return result

    return wrapper
