"""Prometheus MCP server (port 9104): read-only access to the metric history.

Prometheus answers the questions Redfish cannot: not "how hot is this machine"
but "how fast did it get there, and which of its neighbours followed". Results
are trimmed hard — a rack-wide query can return thousands of samples, and the
agent needs a shape, not a data set.
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from hush_mcp.common import env, guarded, make_server

PORT = 9104
mcp = make_server("prometheus")

#: Trim limits (specs/graph.md §5): enough to see a trend, small enough to read.
MAX_SERIES = 50
MAX_RANGE_SERIES = 20
MAX_POINTS = 40


def _client() -> httpx.Client:
    """HTTP client for the local Prometheus (patched in tests)."""
    return httpx.Client(base_url=env("HUSH_PROMETHEUS_URL", "http://127.0.0.1:9090"), timeout=5.0)


def _data(path: str, params: dict[str, Any]) -> dict[str, Any]:
    with _client() as http:
        response = http.get(path, params=params)
        response.raise_for_status()
        payload = response.json()
    if payload.get("status") != "success":
        raise RuntimeError(payload.get("error", "prometheus returned a non-success status"))
    data: dict[str, Any] = payload.get("data") or {}
    return data


@mcp.tool()
@guarded
def query(promql: str) -> dict[str, Any]:
    """Evaluate `promql` now. Returns one value per matching series.

    Example: `hush_cpu_temp_celsius{rack="R4"}` — the current CPU temperature of
    every machine in rack R4.
    """
    data = _data("/api/v1/query", {"query": promql})
    result = data.get("result") or []
    series = [
        {"metric": r.get("metric", {}), "value": (r.get("value") or [None, None])[1]}
        for r in result[:MAX_SERIES]
    ]
    return {"result_type": data.get("resultType", ""), "series": series, "total": len(result),
            "truncated": len(result) > MAX_SERIES}


@mcp.tool()
@guarded
def query_range(promql: str, minutes: int = 10, step_s: int = 30) -> dict[str, Any]:
    """Evaluate `promql` over the last `minutes`, one point every `step_s` seconds.

    Only the most recent points are returned when a series is longer than the
    limit — the end of a temperature ramp is what decides an action.
    """
    end = time.time()
    data = _data(
        "/api/v1/query_range",
        {"query": promql, "start": end - minutes * 60, "end": end, "step": step_s},
    )
    result = data.get("result") or []
    series = [
        {
            "metric": r.get("metric", {}),
            "points": [[p[0], p[1]] for p in (r.get("values") or [])[-MAX_POINTS:]],
        }
        for r in result[:MAX_RANGE_SERIES]
    ]
    return {"series": series, "total": len(result), "truncated": len(result) > MAX_RANGE_SERIES}


@mcp.tool()
@guarded
def list_rules() -> dict[str, Any]:
    """List the alerting rules Prometheus is evaluating, with their current state."""
    groups = _data("/api/v1/rules", {}).get("groups") or []
    return {
        "rules": [
            {
                "name": rule.get("name", ""),
                "group": group.get("name", ""),
                "state": rule.get("state", ""),
                "health": rule.get("health", ""),
            }
            for group in groups
            for rule in (group.get("rules") or [])
        ]
    }
