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
import threading
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


def _line(fn_name: str, kwargs: dict[str, Any], **fields: Any) -> str:
    """One JSON log line, carrying the run id when the caller passed one.

    Person B's prompts include `run_id` in the tool arguments, so a tool log and
    a harness trace can be lined up afterwards without any extra plumbing.
    """
    run_id = kwargs.get("run_id")
    entry: dict[str, Any] = {"tool": fn_name, **fields}
    if run_id:
        entry["run_id"] = str(run_id)
    return json.dumps(entry)


def guarded[**P](fn: Callable[P, dict[str, Any]]) -> Callable[P, dict[str, Any]]:
    """Log the call and turn any exception into the error envelope."""

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> dict[str, Any]:
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - tool boundary
            log.error(_line(fn.__name__, kwargs, error=str(exc), code=type(exc).__name__))
            return {"error": {"code": type(exc).__name__, "message": str(exc)}}
        log.info(_line(fn.__name__, kwargs, ok="error" not in result))
        return result

    return wrapper


_IDEMPOTENT: dict[str, dict[str, Any]] = {}
_REGISTRY_LOCK = threading.Lock()
_KEY_LOCKS: dict[str, threading.Lock] = {}


def _key_lock(key: str) -> threading.Lock:
    """One lock per cache key, created once."""
    with _REGISTRY_LOCK:
        return _KEY_LOCKS.setdefault(key, threading.Lock())


def idempotent[**P](fn: Callable[P, dict[str, Any]]) -> Callable[P, dict[str, Any]]:
    """Return the first successful result for a repeated ``idempotency_key``.

    A replan or an approval retry must not power-cycle a machine twice, so the
    side effect happens once per key and later calls get ``replayed: true``.
    Failures are not cached: a retry after an error is a genuine retry.

    Two details that are easy to get wrong and expensive to get wrong here:

    * the key is scoped to the tool, so reusing one key across ``cordon_node``
      and ``uncordon_node`` cannot replay the cordon and leave the node cordoned;
    * the check and the side effect happen under a per-key lock, so two
      concurrent calls with the same key cannot both miss the cache and both
      reset a machine.
    """
    inner = guarded(fn)

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> dict[str, Any]:
        raw_key = str(kwargs.get("idempotency_key", ""))
        if not raw_key:
            return inner(*args, **kwargs)
        key = f"{fn.__name__}:{raw_key}"
        with _key_lock(key):
            if key in _IDEMPOTENT:
                log.info(_line(fn.__name__, kwargs, key=raw_key, replayed=True))
                return {**_IDEMPOTENT[key], "replayed": True}
            result = inner(*args, **kwargs)
            if "error" not in result:
                _IDEMPOTENT[key] = result
        return result

    return wrapper
