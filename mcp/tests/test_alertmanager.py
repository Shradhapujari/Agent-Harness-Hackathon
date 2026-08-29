"""Alertmanager tools: schema mapping, matcher parsing, and the error envelope.

The server is exercised through httpx.MockTransport so the tests pin the exact
requests Alertmanager will receive without needing it running.
"""
from __future__ import annotations

import functools
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from hush_mcp import alertmanager, common

Handler = Any


@pytest.fixture(autouse=True)
def _fresh_idempotency_store() -> None:
    common._IDEMPOTENT.clear()


def _mock(monkeypatch: pytest.MonkeyPatch, handler: Handler) -> list[httpx.Request]:
    """Route the server's HTTP calls to `handler`; return the recorded requests."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(
        alertmanager,
        "_client",
        lambda: httpx.Client(transport=httpx.MockTransport(record), base_url="http://am"),
    )
    return seen


def _raw_alert(fingerprint: str, ends_in_s: int = 600, **labels: str) -> dict[str, Any]:
    now = datetime.now(UTC)
    return {
        "fingerprint": fingerprint,
        "labels": {"alertname": "InletTempHigh", "severity": "warning", **labels},
        "startsAt": now.isoformat(),
        "endsAt": (now + timedelta(seconds=ends_in_s)).isoformat(),
        "status": {"state": "active"},
    }


def test_list_alerts_maps_alertmanager_json_onto_the_alert_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=[_raw_alert("f001", rack="R4", layer="bmc")]))
    alert = alertmanager.list_alerts()["alerts"][0]
    assert alert["fingerprint"] == "f001"
    assert alert["name"] == "InletTempHigh"
    assert alert["severity"] == "warning"
    assert alert["labels"]["rack"] == "R4"
    assert alert["status"] == "firing"


def test_an_alert_whose_end_has_passed_is_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=[_raw_alert("f001", ends_in_s=-30)]))
    assert alertmanager.list_alerts()["alerts"][0]["status"] == "resolved"


def test_unknown_severity_falls_back_to_info(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = _raw_alert("f001")
    raw["labels"]["severity"] = "page"
    _mock(monkeypatch, lambda r: httpx.Response(200, json=[raw]))
    assert alertmanager.list_alerts()["alerts"][0]["severity"] == "info"


def test_filters_are_passed_through_as_repeated_matchers(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json=[]))
    alertmanager.list_alerts(filter=["rack=R4", "severity=critical"])
    assert seen[0].url.params.get_list("filter") == ["rack=R4", "severity=critical"]
    assert seen[0].url.params["active"] == "true"


def test_a_storm_is_truncated_to_the_evidence_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = [_raw_alert(f"f{i:04d}") for i in range(alertmanager.MAX_ALERTS + 5)]
    _mock(monkeypatch, lambda r: httpx.Response(200, json=raw))
    result = alertmanager.list_alerts()
    assert len(result["alerts"]) == alertmanager.MAX_ALERTS
    assert result["total"] == alertmanager.MAX_ALERTS + 5
    assert result["truncated"] is True


def test_a_dead_alertmanager_returns_the_error_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(503, text="unavailable"))
    result = alertmanager.list_alerts()
    assert result["error"]["code"] == "HTTPStatusError"
    assert "alerts" not in result


def test_alert_groups_are_reduced_to_labels_and_fingerprints(monkeypatch: pytest.MonkeyPatch) -> None:
    groups = [{"labels": {"rack": "R4"}, "alerts": [{"fingerprint": "f001"}, {"fingerprint": "f002"}]}]
    _mock(monkeypatch, lambda r: httpx.Response(200, json=groups))
    expected = [{"labels": {"rack": "R4"}, "alerts": ["f001", "f002"]}]
    assert alertmanager.get_alert_groups() == {"groups": expected}


@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ("rack=R4", {"name": "rack", "value": "R4", "isRegex": False, "isEqual": True}),
        ("rack!=R4", {"name": "rack", "value": "R4", "isRegex": False, "isEqual": False}),
        ("pod=~web-.*", {"name": "pod", "value": "web-.*", "isRegex": True, "isEqual": True}),
        ("pod!~web-.*", {"name": "pod", "value": "web-.*", "isRegex": True, "isEqual": False}),
    ],
)
def test_matchers_parse_all_four_alertmanager_operators(expr: str, expected: dict[str, Any]) -> None:
    assert alertmanager._matcher(expr) == expected


def test_an_unparsable_matcher_is_reported_not_raised(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json={"silenceID": "s1"}))
    result = alertmanager.silence_alerts(
        matchers=["rack"], duration_s=60, comment="x", idempotency_key="k1"
    )
    assert result["error"]["code"] == "ValueError"
    assert seen == []


def test_silence_posts_a_bounded_window_and_returns_its_id(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json={"silenceID": "sil-1"}))
    result = alertmanager.silence_alerts(
        matchers=["rack=R4"], duration_s=1800, comment="recovered", idempotency_key="k1"
    )
    assert result == {"ok": True, "silence_id": "sil-1", "matchers": ["rack=R4"]}
    body = seen[0].read().decode()
    assert '"createdBy":"hush"' in body.replace(" ", "")


def test_repeating_a_silence_key_replays_instead_of_re_silencing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json={"silenceID": "sil-1"}))
    silence = functools.partial(
        alertmanager.silence_alerts, matchers=["rack=R4"], duration_s=60, comment="c"
    )
    first = silence(idempotency_key="k1")
    second = silence(idempotency_key="k1")
    assert "replayed" not in first
    assert second["replayed"] is True
    assert second["silence_id"] == first["silence_id"]
    assert len(seen) == 1


def test_a_failed_silence_is_not_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """A retry after Alertmanager was down must really retry."""
    responses = [httpx.Response(503), httpx.Response(200, json={"silenceID": "sil-2"})]
    seen = _mock(monkeypatch, lambda r: responses.pop(0))
    silence = functools.partial(
        alertmanager.silence_alerts, matchers=["rack=R4"], duration_s=60, comment="c"
    )
    assert "error" in silence(idempotency_key="k2")
    assert silence(idempotency_key="k2")["ok"]
    assert len(seen) == 2


def test_correlate_tool_returns_the_pure_functions_answer() -> None:
    alerts = [
        {
            "fingerprint": "f1",
            "name": "FacilityAmbientHigh",
            "severity": "critical",
            "labels": {"layer": "facility", "rack": "R4"},
            "startsAt": "2026-08-29T12:00:00Z",
            "status": "firing",
        }
    ]
    result = alertmanager.correlate_alerts(alerts=alerts)
    assert result["clusters"][0]["leading_alert"] == "f1"
    assert result["noise"] == []


def test_the_run_id_reaches_the_log_line(monkeypatch: pytest.MonkeyPatch, caplog: Any) -> None:
    """Cheap correlation: one grep joins a harness trace to the tool calls it made."""
    _mock(monkeypatch, lambda r: httpx.Response(200, json=[]))
    with caplog.at_level("INFO", logger="hush-mcp"):
        alertmanager.list_alerts(run_id="inc-42")
    assert '"run_id": "inc-42"' in caplog.text


def test_a_call_without_a_run_id_logs_no_empty_field(
    monkeypatch: pytest.MonkeyPatch, caplog: Any
) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=[]))
    with caplog.at_level("INFO", logger="hush-mcp"):
        alertmanager.list_alerts()
    assert "run_id" not in caplog.text
