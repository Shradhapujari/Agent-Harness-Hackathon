"""Prometheus tools: response shaping and the trim limits that protect the context."""
from __future__ import annotations

from typing import Any

import httpx
import pytest

from hush_mcp import prometheus


def _mock(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(
        prometheus,
        "_client",
        lambda: httpx.Client(transport=httpx.MockTransport(record), base_url="http://prom"),
    )
    return seen


def _vector(count: int) -> dict[str, Any]:
    return {
        "status": "success",
        "data": {
            "resultType": "vector",
            "result": [
                {"metric": {"system": f"R4-N{i:02d}"}, "value": [1788000000, f"{60 + i}"]}
                for i in range(count)
            ],
        },
    }


def _matrix(series: int, points: int) -> dict[str, Any]:
    return {
        "status": "success",
        "data": {
            "resultType": "matrix",
            "result": [
                {
                    "metric": {"system": f"R4-N{i:02d}"},
                    "values": [[1788000000 + p * 30, f"{p}"] for p in range(points)],
                }
                for i in range(series)
            ],
        },
    }


def test_query_returns_one_value_per_series(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_vector(3)))
    result = prometheus.query("hush_cpu_temp_celsius")
    assert result["result_type"] == "vector"
    assert result["series"][0] == {"metric": {"system": "R4-N00"}, "value": "60"}
    assert result["truncated"] is False


def test_a_rack_wide_query_is_trimmed(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_vector(prometheus.MAX_SERIES + 10)))
    result = prometheus.query("up")
    assert len(result["series"]) == prometheus.MAX_SERIES
    assert result["total"] == prometheus.MAX_SERIES + 10
    assert result["truncated"] is True


def test_query_range_asks_for_the_window_it_was_given(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json=_matrix(1, 5)))
    prometheus.query_range("hush_inlet_temp_celsius", minutes=10, step_s=30)
    params = seen[0].url.params
    assert params["step"] == "30"
    assert float(params["end"]) - float(params["start"]) == pytest.approx(600, abs=1)


def test_query_range_keeps_the_most_recent_points(monkeypatch: pytest.MonkeyPatch) -> None:
    """The end of a temperature ramp is the part that decides an action."""
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_matrix(1, prometheus.MAX_POINTS + 5)))
    points = prometheus.query_range("hush_cpu_temp_celsius")["series"][0]["points"]
    assert len(points) == prometheus.MAX_POINTS
    assert points[-1][1] == str(prometheus.MAX_POINTS + 4)


def test_query_range_trims_series_harder_than_instant_queries(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_matrix(prometheus.MAX_RANGE_SERIES + 3, 2)))
    result = prometheus.query_range("up")
    assert len(result["series"]) == prometheus.MAX_RANGE_SERIES
    assert result["truncated"] is True


def test_a_scalar_answer_is_an_answer_not_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """`count(up)` and friends return one [ts, value] pair, not a list of series."""
    body = {"status": "success", "data": {"resultType": "scalar", "result": [1788000000, "12"]}}
    _mock(monkeypatch, lambda r: httpx.Response(200, json=body))
    result = prometheus.query("scalar(count(hush_power_on))")
    assert result["result_type"] == "scalar"
    assert result["value"] == "12"
    assert "error" not in result


def test_dropped_range_points_are_declared(monkeypatch: pytest.MonkeyPatch) -> None:
    """A trend read from 40 of 400 points is a different claim than one read from all."""
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_matrix(1, prometheus.MAX_POINTS + 12)))
    series = prometheus.query_range("hush_cpu_temp_celsius")["series"][0]
    assert series["points_total"] == prometheus.MAX_POINTS + 12
    assert series["points_dropped"] == 12


def test_a_promql_error_comes_back_as_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    body = {"status": "error", "errorType": "bad_data", "error": "parse error at char 5"}
    _mock(monkeypatch, lambda r: httpx.Response(200, json=body))
    result = prometheus.query("hush_cpu_temp_celsius{")
    assert result["error"]["code"] == "RuntimeError"
    assert "parse error" in result["error"]["message"]


def test_a_dead_prometheus_comes_back_as_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(503))
    assert prometheus.query("up")["error"]["code"] == "HTTPStatusError"


def test_rules_are_flattened_across_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    body = {
        "status": "success",
        "data": {
            "groups": [
                {
                    "name": "hush-hardware",
                    "rules": [
                        {"name": "InletTempHigh", "state": "firing", "health": "ok"},
                        {"name": "ThermalTrip", "state": "inactive", "health": "ok"},
                    ],
                }
            ]
        },
    }
    _mock(monkeypatch, lambda r: httpx.Response(200, json=body))
    rules = prometheus.list_rules()["rules"]
    assert rules[0] == {"name": "InletTempHigh", "group": "hush-hardware", "state": "firing", "health": "ok"}
    assert len(rules) == 2
