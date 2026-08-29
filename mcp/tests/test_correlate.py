"""Correlation is the one piece of triage logic that must be deterministic."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hush_mcp.correlate import Alert, correlate

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> list[Alert]:
    alerts: list[Alert] = json.loads((FIXTURES / name).read_text())
    return alerts


def _by_fp(alerts: list[Alert]) -> dict[str, Alert]:
    return {a["fingerprint"]: a for a in alerts}


@pytest.fixture
def crac() -> list[Alert]:
    return _load("alerts_crac.json")


@pytest.fixture
def hang() -> list[Alert]:
    return _load("alerts_hang.json")


def _alert(fp: str, offset_s: int, layer: str, **labels: str) -> Alert:
    minute, second = divmod(offset_s, 60)
    return {
        "fingerprint": fp,
        "name": fp,
        "severity": "warning",
        "labels": {"layer": layer, **labels},
        "startsAt": f"2026-08-29T12:{minute:02d}:{second:02d}Z",
        "status": "firing",
    }


def test_no_alerts_is_not_an_incident() -> None:
    assert correlate([]) == {"clusters": [], "noise": []}


def test_resolved_alerts_are_ignored(crac: list[Alert]) -> None:
    resolved = [a["fingerprint"] for a in crac if a["status"] == "resolved"]
    assert resolved, "fixture must contain a resolved alert"
    clustered = {fp for c in correlate(crac)["clusters"] for fp in c["fingerprints"]}
    assert clustered.isdisjoint(resolved)


def test_crac_storm_leads_with_the_facility_alert(crac: list[Alert]) -> None:
    """Scenario A: the whole rack is hot; the CRAC alert fired first and lowest."""
    result = correlate(crac)
    lead = result["clusters"][0]
    assert lead["key"] == {"rack": "R4"}
    assert _by_fp(crac)[lead["leading_alert"]]["name"] == "FacilityAmbientHigh"


def test_crac_cluster_spans_every_layer(crac: list[Alert]) -> None:
    counts = correlate(crac)["clusters"][0]["layer_counts"]
    assert counts["facility"] == 1
    assert counts["bmc"] == 14  # 12 inlet warnings + 2 thermal trips
    assert counts["kubernetes"] == 2
    assert counts["app"] == 1


def test_alerts_after_the_window_are_noise(crac: list[Alert]) -> None:
    """A storm is what fires together; a disk filling up five minutes later is not."""
    assert correlate(crac)["noise"] == ["f020"]


def test_other_racks_cluster_separately_and_rank_below(crac: list[Alert]) -> None:
    result = correlate(crac)
    racks = [c["key"]["rack"] for c in result["clusters"]]
    assert racks == ["R4", "R2"]
    assert result["clusters"][1]["fingerprints"] == ["f019"]


def test_hang_storm_leads_with_host_hung(hang: list[Alert]) -> None:
    """Scenario B: one machine wedged; k8s and the apps noticed afterwards."""
    result = correlate(hang)
    lead = result["clusters"][0]
    leading = _by_fp(hang)[lead["leading_alert"]]
    assert leading["name"] == "HostHung"
    assert leading["labels"]["node"] == "R4-N04"


def test_unlocated_single_alert_is_noise(hang: list[Alert]) -> None:
    result = correlate(hang)
    assert result["noise"] == ["h007"]
    assert [c["key"]["rack"] for c in result["clusters"]] == ["R4"]


def test_clusters_are_ordered_by_size_then_first_seen() -> None:
    alerts = [
        _alert("a1", 0, "bmc", rack="R1"),
        _alert("b1", 1, "bmc", rack="R2"),
        _alert("b2", 2, "bmc", rack="R2"),
        _alert("c1", 3, "bmc", rack="R3"),
    ]
    clusters = correlate(alerts)["clusters"]
    assert [c["key"]["rack"] for c in clusters] == ["R2", "R1", "R3"]


def test_lowest_layer_wins_when_alerts_start_together() -> None:
    alerts = [
        _alert("k", 0, "kubernetes", rack="R4"),
        _alert("f", 0, "facility", rack="R4"),
        _alert("b", 0, "bmc", rack="R4"),
    ]
    assert correlate(alerts)["clusters"][0]["leading_alert"] == "f"


def test_window_is_measured_from_the_first_firing_alert() -> None:
    alerts = [_alert("first", 0, "bmc", rack="R4"), _alert("later", 90, "bmc", rack="R4")]
    assert correlate(alerts, window_s=120)["noise"] == []
    assert correlate(alerts, window_s=60)["noise"] == ["later"]


def test_cluster_bounds_report_first_and_last_alert(crac: list[Alert]) -> None:
    lead = correlate(crac)["clusters"][0]
    assert lead["first_seen"] == "2026-08-29T12:00:00Z"
    assert lead["last_seen"] == "2026-08-29T12:01:10Z"


def test_correlation_does_not_mutate_its_input(crac: list[Alert]) -> None:
    before: list[dict[str, Any]] = json.loads(json.dumps(crac))
    correlate(crac)
    assert json.loads(json.dumps(crac)) == before


def test_stale_alerts_do_not_hijack_the_window() -> None:
    """I1: leftovers from an earlier scenario must not turn a live storm into noise.

    Alertmanager keeps the original ``startsAt`` when a fingerprint is re-posted,
    so `hush-chaos hang` symptoms resurface inside a later `crac` storm carrying
    twenty-minute-old timestamps.
    """
    stale = [_alert(f"old{i}", i, "kubernetes", rack="R4") for i in range(8)]
    storm = [_alert(f"new{i}", 1200 + i, "bmc", rack="R4") for i in range(40)]
    result = correlate(stale + storm)
    assert [c["key"]["rack"] for c in result["clusters"]] == ["R4"]
    assert len(result["clusters"][0]["fingerprints"]) == 40
    assert result["noise"] == [a["fingerprint"] for a in stale]


def test_lowest_layer_leads_even_when_a_higher_layer_fired_first() -> None:
    """The rack cooked the machine, so the CRAC alert leads the trip it caused.

    FacilityAmbientHigh carries `for: 10s` and ThermalTrip carries none, so the
    facility alert is always the later of the two on the live bus (found at I1).
    """
    alerts = [
        _alert("trip", 0, "bmc", rack="R4"),
        _alert("ambient", 10, "facility", rack="R4"),
        _alert("notready", 30, "kubernetes", rack="R4"),
    ]
    assert correlate(alerts)["clusters"][0]["leading_alert"] == "ambient"
