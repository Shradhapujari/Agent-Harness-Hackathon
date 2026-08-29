"""Alertmanager MCP server (port 9101): read the storm, correlate it, silence it.

Correlation is served by this process on purpose (specs/graph.md §5): it takes
the alert list this server already speaks, so the agent never has to shuttle a
200-item array between two servers.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from hush_mcp.common import env, guarded, idempotent, make_server
from hush_mcp.correlate import Alert, correlate

PORT = 9101
mcp = make_server("alertmanager")

#: The agent's evidence budget, not Alertmanager's: a storm is summarised by
#: correlation, not by pasting every alert into the context window.
MAX_ALERTS = 200
_SEVERITIES = {"critical", "warning", "info"}


def _client() -> httpx.Client:
    """HTTP client for the local Alertmanager (patched in tests)."""
    return httpx.Client(base_url=env("HUSH_ALERTMANAGER_URL", "http://127.0.0.1:9093"), timeout=5.0)


def _to_alert(raw: dict[str, Any]) -> Alert:
    """Map one Alertmanager v2 alert onto the Alert schema in specs/graph.md §2."""
    labels = {str(k): str(v) for k, v in (raw.get("labels") or {}).items()}
    severity = labels.get("severity", "info")
    ends_at = str(raw.get("endsAt") or "")
    return {
        "fingerprint": str(raw.get("fingerprint", "")),
        "name": labels.get("alertname", ""),
        "severity": severity if severity in _SEVERITIES else "info",
        "labels": labels,
        "startsAt": str(raw.get("startsAt", "")),
        "status": "resolved" if _has_ended(ends_at) else "firing",
    }


def _has_ended(ends_at: str) -> bool:
    """Alertmanager keeps a resolved alert briefly, with endsAt in the past."""
    if not ends_at:
        return False
    try:
        return datetime.fromisoformat(ends_at.replace("Z", "+00:00")) <= datetime.now(UTC)
    except ValueError:
        return False


def _matcher(expr: str) -> dict[str, Any]:
    """Parse a matcher string (`rack=R4`, `node!=R4-N01`, `pod=~web-.*`)."""
    operators = (("=~", True, True), ("!~", True, False), ("!=", False, False), ("=", False, True))
    for op, is_regex, is_equal in operators:
        name, sep, value = expr.partition(op)
        if sep and name:
            return {"name": name.strip(), "value": value.strip(), "isRegex": is_regex, "isEqual": is_equal}
    raise ValueError(f"unparsable matcher: {expr!r}")


@mcp.tool()
@guarded
def list_alerts(  # noqa: A002 - `filter` is the contract name
    active: bool = True, filter: list[str] | None = None, run_id: str = ""
) -> dict[str, Any]:
    """List alerts from Alertmanager, optionally narrowed by label matchers.

    Args:
        active: only currently firing alerts (False also returns silenced ones).
        filter: Alertmanager matchers, e.g. ["rack=R4", "severity=critical"].
        run_id: the incident run this call belongs to; logged, never acted on.
    """
    params: list[tuple[str, str | int | float | bool | None]] = [
        ("active", active),
        ("silenced", not active),
    ]
    params += [("filter", f) for f in (filter or [])]
    with _client() as http:
        response = http.get("/api/v2/alerts", params=params)
        response.raise_for_status()
        raw = response.json()
    alerts = [_to_alert(a) for a in raw[:MAX_ALERTS]]
    return {"alerts": alerts, "total": len(raw), "truncated": len(raw) > MAX_ALERTS}


@mcp.tool()
@guarded
def get_alert_groups(run_id: str = "") -> dict[str, Any]:
    """List Alertmanager's own grouping of the firing alerts (labels + fingerprints)."""
    with _client() as http:
        response = http.get("/api/v2/alerts/groups")
        response.raise_for_status()
        raw = response.json()
    groups = [
        {
            "labels": {str(k): str(v) for k, v in (g.get("labels") or {}).items()},
            "alerts": [str(a.get("fingerprint", "")) for a in (g.get("alerts") or [])],
        }
        for g in raw
    ]
    return {"groups": groups}


@mcp.tool()
@guarded
def correlate_alerts(alerts: list[Alert], window_s: int = 120, run_id: str = "") -> dict[str, Any]:
    """Cluster alerts by rack and time window; returns clusters (biggest first) and noise.

    The leading alert of a cluster is its earliest, lowest-layer alert:
    facility before bmc before kubernetes/app.
    """
    return dict(correlate(alerts, window_s))


@mcp.tool()
@idempotent
def silence_alerts(
    matchers: list[str], duration_s: int, comment: str, idempotency_key: str, run_id: str = ""
) -> dict[str, Any]:
    """Silence every alert matching `matchers` for `duration_s` seconds.

    Used after a fix has been verified, so the residual storm stops paging.
    """
    now = datetime.now(UTC)
    body = {
        "matchers": [_matcher(m) for m in matchers],
        "startsAt": now.isoformat(),
        "endsAt": (now + timedelta(seconds=duration_s)).isoformat(),
        "createdBy": "hush",
        "comment": comment,
    }
    with _client() as http:
        response = http.post("/api/v2/silences", json=body)
        response.raise_for_status()
        payload = response.json()
    return {"ok": True, "silence_id": str(payload.get("silenceID", "")), "matchers": matchers}
