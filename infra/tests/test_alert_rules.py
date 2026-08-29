"""The alert rules and the simulation physics have to agree.

Prometheus itself is exercised by `make up` (A1 definition of done). These tests
cover the half that can silently rot without Docker: if someone retunes the fan
curve or the ambient model, the CRAC storm must still cross the thresholds this
rule file declares.
"""
from pathlib import Path

import pytest
import yaml

from app.state import Fleet

RULES = Path(__file__).resolve().parents[1] / "prometheus" / "rules" / "hush.yml"
PROM = Path(__file__).resolve().parents[1] / "prometheus" / "prometheus.yml"
ALERTMANAGER = Path(__file__).resolve().parents[1] / "alertmanager" / "alertmanager.yml"


@pytest.fixture(scope="module")
def rules() -> dict[str, dict]:
    groups = yaml.safe_load(RULES.read_text())["groups"]
    return {r["alert"]: r for g in groups for r in g["rules"]}


def _threshold(rules: dict[str, dict], alert: str) -> float:
    """Pull the numeric bound out of a `metric > N` expression."""
    return float(rules[alert]["expr"].rsplit(">", 1)[1])


def _storm_fleet(delta_c: float = 14.0, seconds: int = 120) -> Fleet:
    fleet = Fleet([f"R4-N{i:02d}" for i in range(1, 13)])
    fleet.crac_fail(delta_c)
    for _ in range(seconds):
        fleet.tick(1.0)
    return fleet


def test_every_rule_carries_the_labels_the_correlator_keys_on(rules):
    for name, rule in rules.items():
        assert rule["labels"]["layer"] in {"bmc", "facility"}, name
        assert rule["labels"]["rack"] == "R4", name
        assert rule["labels"]["severity"] in {"warning", "critical"}, name
    # Only the facility-wide rule may omit a node: everything else is per-node.
    assert "node" not in rules["FacilityAmbientHigh"]["labels"]
    for name in set(rules) - {"FacilityAmbientHigh"}:
        assert rules[name]["labels"]["node"] == "{{ $labels.system }}", name


def test_crac_failure_reaches_the_definition_of_done(rules):
    """12 InletTempHigh + 1 FacilityAmbientHigh is the >= 13 the DoD asks for."""
    snap = _storm_fleet().snapshot()
    ambient = snap["ambient_c"] + snap["ambient_offset_c"]

    inlet_firing = [n for n in snap["nodes"] if n["inlet_temp_c"] > _threshold(rules, "InletTempHigh")]
    facility_firing = ambient > _threshold(rules, "FacilityAmbientHigh")

    assert len(inlet_firing) == 12
    assert facility_firing
    assert len(inlet_firing) + int(facility_firing) >= 13


def test_crac_restore_drops_everything_back_under_threshold(rules):
    fleet = _storm_fleet()
    fleet.crac_restore()
    for _ in range(300):
        fleet.tick(1.0)

    snap = fleet.snapshot()
    ambient = snap["ambient_c"] + snap["ambient_offset_c"]
    assert ambient <= _threshold(rules, "FacilityAmbientHigh")
    assert not [n for n in snap["nodes"] if n["inlet_temp_c"] > _threshold(rules, "InletTempHigh")]


def test_a_quiet_fleet_fires_nothing(rules):
    """No false positives at rest, or the storm means nothing."""
    fleet = Fleet([f"R4-N{i:02d}" for i in range(1, 13)])
    for _ in range(60):
        fleet.tick(1.0)

    snap = fleet.snapshot()
    ambient = snap["ambient_c"] + snap["ambient_offset_c"]
    assert ambient <= _threshold(rules, "FacilityAmbientHigh")
    for n in snap["nodes"]:
        assert n["inlet_temp_c"] <= _threshold(rules, "InletTempHigh")
        assert n["cpu_temp_c"] <= _threshold(rules, "CpuTempCritical")
        assert not n["thermal_trip"]
        assert n["psu1_ok"] and n["psu2_ok"]
        assert not n["hung"]


def test_prometheus_scrapes_the_bmc_and_talks_to_alertmanager():
    cfg = yaml.safe_load(PROM.read_text())
    assert cfg["global"]["scrape_interval"] == "5s"
    assert cfg["rule_files"] == ["rules/*.yml"]
    targets = cfg["scrape_configs"][0]["static_configs"][0]["targets"]
    assert targets == ["mock-bmc:8100"]
    am = cfg["alerting"]["alertmanagers"][0]["static_configs"][0]["targets"]
    assert am == ["alertmanager:9093"]


def test_alertmanager_grouping_stays_coarse_enough_to_show_a_storm():
    cfg = yaml.safe_load(ALERTMANAGER.read_text())
    route = cfg["route"]
    assert route["group_by"] == ["alertname", "node"]
    assert route["group_wait"] == "5s"
    assert route["group_interval"] == "10s"
    assert route["repeat_interval"] == "1h"
    assert [r["name"] for r in cfg["receivers"]] == [route["receiver"]]
