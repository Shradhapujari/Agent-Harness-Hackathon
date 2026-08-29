"""Scenario orchestration, with the BMC, Alertmanager and the cluster stubbed out.

What matters here is the sequence — what gets called, in what order, with what —
because that sequence is what the correlator later has to reconstruct.
"""
from __future__ import annotations

from typing import Any

import pytest

from hush_chaos import cluster, scenarios

NODES = {"hush-control-plane": "R4-N01", "hush-worker": "R4-N04", "hush-worker2": "R4-N07"}


class FakeBmc:
    def __init__(self, machines: list[dict[str, Any]] | None = None, ambient_offset_c: float = 0.0) -> None:
        self.ambient_offset_c = ambient_offset_c
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.resets: list[tuple[str, str]] = []
        default = [
            {"system_id": s, "power": "On", "thermal_trip": False, "hung": False}
            for s in ("R4-N01", "R4-N04")
        ]
        self.machines = machines if machines is not None else default

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((path, body))
        return {"result": "ok"}

    def status(self) -> dict[str, Any]:
        return {"ambient_c": 22.0, "ambient_offset_c": self.ambient_offset_c, "nodes": self.machines}

    def reset(self, system_id: str, reset_type: str) -> None:
        self.resets.append((system_id, reset_type))


class FakeAm:
    def __init__(self, active: list[dict[str, Any]] | None = None) -> None:
        self.posted: list[list[dict[str, Any]]] = []
        self.silences: list[tuple[list[str], int]] = []
        self.expired_authors: list[str] = []
        self.active = active or []

    def post_alerts(self, alerts: list[dict[str, Any]]) -> None:
        self.posted.append(alerts)

    def list_alerts(self, filters: list[str] | None = None, silenced: bool = True) -> list[dict[str, Any]]:
        return self.active if silenced else [a for a in self.active if not a.get("silenced")]

    def silence(self, matchers: list[str], duration_s: int, comment: str) -> str:
        self.silences.append((matchers, duration_s))
        return "sil-1"

    def expire_silences(self, created_by: str) -> list[str]:
        self.expired_authors.append(created_by)
        return ["sil-0"]


@pytest.fixture(autouse=True)
def no_docker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing in these tests may touch a real container or cluster."""
    monkeypatch.setattr(cluster, "pause", lambda node: True)
    monkeypatch.setattr(cluster, "unpause", lambda node: True)
    monkeypatch.setattr(cluster, "uncordon", lambda node: True)
    monkeypatch.setattr(cluster, "node_map", lambda: NODES)


def test_crac_heats_the_rack_before_it_spikes_two_machines() -> None:
    bmc, am = FakeBmc(), FakeAm()
    result = scenarios.crac(bmc, am, NODES, lead_s=0)
    paths = [path for path, _ in bmc.calls]
    assert paths[0] == "/chaos/crac-failure"
    assert bmc.calls[0][1]["delta_c"] == scenarios.CRAC_DELTA_C
    assert [body["system"] for path, body in bmc.calls if path == "/chaos/thermal-spike"] == list(
        scenarios.SPIKE_SYSTEMS
    )
    assert result["synthetic_alerts"] == len(am.posted[0])


def test_crac_waits_for_the_hardware_alerts_before_posting_symptoms(monkeypatch: pytest.MonkeyPatch) -> None:
    """The correlator's leading alert is the earliest one in the lowest layer."""
    slept: list[float] = []
    monkeypatch.setattr(scenarios.time, "sleep", lambda s: slept.append(s))
    bmc, am = FakeBmc(), FakeAm()
    scenarios.crac(bmc, am, NODES)
    assert slept == [scenarios.HARDWARE_LEAD_S]


def test_a_scenario_clears_the_silence_the_last_clear_left(monkeypatch: pytest.MonkeyPatch) -> None:
    """Otherwise a rerun's alerts match the old silence and never show as firing."""
    monkeypatch.setattr(scenarios.time, "sleep", lambda s: None)
    am = FakeAm()
    scenarios.crac(FakeBmc(), am, NODES)
    scenarios.hang(FakeBmc(), am)
    assert am.expired_authors == [scenarios.SILENCE_AUTHOR, scenarios.SILENCE_AUTHOR]


def test_hang_refuses_a_node_and_machine_that_are_not_a_pair() -> None:
    with pytest.raises(ValueError, match="hush-worker runs on R4-N04"):
        scenarios.hang(FakeBmc(), FakeAm(), k8s_node="hush-worker", system="R4-N07")


def test_hang_posts_no_symptoms_when_the_node_will_not_freeze(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """NotReady alerts for a healthy node would describe an incident that is not happening."""
    monkeypatch.setattr(cluster, "pause", lambda node: False)
    bmc, am = FakeBmc(), FakeAm()
    with pytest.raises(RuntimeError, match="could not pause"):
        scenarios.hang(bmc, am)
    assert am.posted == []
    assert ("/chaos/unhang", {"system": "R4-N04"}) in bmc.calls


def test_hang_wedges_the_machine_and_freezes_its_node() -> None:
    bmc, am = FakeBmc(), FakeAm()
    result = scenarios.hang(bmc, am, k8s_node="hush-worker", system="R4-N04")
    assert bmc.calls == [("/chaos/hang", {"system": "R4-N04"})]
    assert result["paused"] is True
    assert {a["labels"]["k8s_node"] for a in am.posted[0] if "k8s_node" in a["labels"]} == {"hush-worker"}


def test_clear_powers_on_what_the_chaos_left_off() -> None:
    """`/chaos/clear` leaves a thermal trip standing: that is a real fault."""
    bmc = FakeBmc([
        {"system_id": "R4-N01", "power": "On", "thermal_trip": False},
        {"system_id": "R4-N04", "power": "Off", "thermal_trip": True},
        {"system_id": "R4-N07", "power": "Off", "thermal_trip": False},
    ])
    result = scenarios.clear(bmc, FakeAm(), NODES)
    assert bmc.calls[0] == ("/chaos/clear", {})
    assert bmc.resets == [("R4-N04", "On"), ("R4-N07", "On")]
    assert result["powered_on"] == ["R4-N04", "R4-N07"]


def test_clear_silences_only_the_alerts_chaos_created() -> None:
    """Alertmanager will not let a pushed alert be shortened into resolution."""
    stale = [
        {
            "labels": {"alertname": "KubeNodeNotReady", "origin": "hush-chaos"},
            "startsAt": "2026-08-29T12:00:00Z",
        }
    ]
    am = FakeAm(active=stale)
    result = scenarios.clear(FakeBmc(), am, NODES)
    assert result["silenced_alerts"] == 1
    assert result["silence_id"] == "sil-1"
    assert am.silences == [([f"origin={scenarios.alerts.ORIGIN}"], scenarios.SILENCE_S)]


def test_clear_creates_no_silence_when_chaos_left_nothing_behind() -> None:
    am = FakeAm(active=[])
    result = scenarios.clear(FakeBmc(), am, NODES)
    assert am.silences == []
    assert result["silence_id"] == ""


def test_clear_thaws_and_uncordons_every_node(monkeypatch: pytest.MonkeyPatch) -> None:
    thawed: list[str] = []
    uncordoned: list[str] = []
    monkeypatch.setattr(cluster, "unpause", lambda node: bool(thawed.append(node)) or True)
    monkeypatch.setattr(cluster, "uncordon", lambda node: bool(uncordoned.append(node)) or True)
    scenarios.clear(FakeBmc(), FakeAm(), NODES)
    assert thawed == list(NODES)
    assert uncordoned == list(NODES)


def test_clear_reports_a_node_it_could_not_uncordon(monkeypatch: pytest.MonkeyPatch) -> None:
    """A node left cordoned never gets its workload back; saying "cleared" would be a lie."""
    monkeypatch.setattr(cluster, "uncordon", lambda node: node != "hush-worker")
    result = scenarios.clear(FakeBmc(), FakeAm(), NODES)
    assert result["failed_nodes"] == ["hush-worker"]


def test_status_counts_the_storm_by_layer() -> None:
    am = FakeAm(active=[
        {"labels": {"layer": "bmc"}},
        {"labels": {"layer": "bmc"}},
        {"labels": {"layer": "app"}},
        {"labels": {}},
        {"labels": {"layer": "app"}, "silenced": True},
    ])
    bmc = FakeBmc(
        [
            {"system_id": "R4-N04", "power": "Off", "thermal_trip": True, "hung": False},
            {"system_id": "R4-N07", "power": "On", "thermal_trip": False, "hung": True},
        ],
        ambient_offset_c=14.0,
    )
    result = scenarios.status(bmc, am)
    assert result["firing"] == 4
    assert result["silenced"] == 1
    assert result["by_layer"] == {"app": 1, "bmc": 2, "unknown": 1}
    assert result["hung"] == ["R4-N07"]
    assert result["tripped"] == ["R4-N04"]
    assert result["powered_off"] == ["R4-N04"]
    assert result["ambient_c"] == 36.0  # nominal 22 plus the CRAC offset
