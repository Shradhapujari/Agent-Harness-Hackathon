"""Redfish tools, exercised against the real mock BMC over an in-process ASGI transport.

Mocking the Redfish payloads here would only test the mock: the point of these
tests is that the projections stay true to what mock-bmc actually serves, so a
change to either side breaks a test instead of the demo.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from hush_mcp import common, redfish

SYSTEM = "R4-N04"


@pytest.fixture(autouse=True)
def bmc(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Point the redfish server at an in-process mock BMC with a fresh fleet.

    The simulation ticker is parked (an hour between ticks) so a temperature
    only moves when a test moves it.
    """
    common._IDEMPOTENT.clear()
    app = create_app(tick_interval_s=3600.0)

    def connect() -> TestClient:
        client = TestClient(app)
        client.auth = ("root", "password0")
        return client

    monkeypatch.setattr(redfish, "_client", connect)
    # No cluster and no docker in a unit test: a machine maps to no kind node
    # unless a test says otherwise.
    monkeypatch.setattr(redfish, "_kind_node", lambda system_id: None)
    return connect()


def test_list_systems_returns_the_whole_rack() -> None:
    systems = redfish.list_systems()["systems"]
    assert len(systems) == 12
    assert SYSTEM in systems


def test_get_system_projects_the_five_fields_an_action_depends_on() -> None:
    system = redfish.get_system(SYSTEM)
    assert system["id"] == SYSTEM
    assert system["power_state"] == "On"
    assert system["health"] == "OK"
    assert system["hung"] is False
    assert system["rack"] == "R4"


def test_a_hung_host_is_visible_over_redfish(bmc: TestClient) -> None:
    """The BMC answers even when the host does not — that is the whole point of it."""
    bmc.post("/chaos/hang", json={"system": SYSTEM}).raise_for_status()
    assert redfish.get_system(SYSTEM)["hung"] is True
    assert redfish.get_system(SYSTEM)["power_state"] == "On"


def test_thermal_reports_inlet_cpu_and_fan() -> None:
    thermal = redfish.get_thermal(SYSTEM)
    assert isinstance(thermal["inlet_c"], float)
    assert isinstance(thermal["cpu_c"], float)
    assert thermal["fan_rpm"] > 0
    assert thermal["cpu_health"] == "OK"


def test_power_reports_both_supplies(bmc: TestClient) -> None:
    bmc.post("/chaos/psu-fail", json={"system": SYSTEM, "psu": 2}).raise_for_status()
    power = redfish.get_power(SYSTEM)
    assert power["watts"] > 0
    assert [psu["ok"] for psu in power["psu"]] == [True, False]


def test_sel_returns_the_newest_entries(bmc: TestClient) -> None:
    for i in range(3):
        bmc.post("/chaos/sel", json={"system": SYSTEM, "message": f"entry {i}"}).raise_for_status()
    entries = redfish.get_sel(SYSTEM, last=2)["entries"]
    assert [e["message"] for e in entries] == ["entry 1", "entry 2"]
    assert entries[0]["id"] < entries[1]["id"]


def test_fleet_summary_is_one_line_per_machine(bmc: TestClient) -> None:
    bmc.post("/chaos/crac-failure", json={"delta_c": 14}).raise_for_status()
    summary = redfish.get_fleet_summary()
    assert len(summary["nodes"]) == 12
    node = next(n for n in summary["nodes"] if n["id"] == SYSTEM)
    assert set(node) == {"id", "power_state", "hung", "inlet_c", "cpu_c", "health"}
    assert summary["ambient_c"] > 0


def test_an_unknown_system_is_an_error_not_a_crash() -> None:
    result = redfish.get_system("R9-N99")
    assert result["error"]["code"] == "HTTPStatusError"


def test_reset_type_is_validated_before_the_bmc_is_touched() -> None:
    result = redfish.reset_system(
        system_id=SYSTEM, reset_type="Reboot", reason="typo", idempotency_key="k1"
    )
    assert result["error"]["code"] == "ValueError"
    assert redfish.get_system(SYSTEM)["power_state"] == "On"


def test_reset_powers_the_machine_and_records_a_sel_entry() -> None:
    result = redfish.reset_system(
        system_id=SYSTEM, reset_type="ForceOff", reason="thermal runaway", idempotency_key="k1"
    )
    assert result["ok"] is True
    assert result["reset_type"] == "ForceOff"
    assert isinstance(result["sel_entry_id"], int)
    assert redfish.get_system(SYSTEM)["power_state"] == "Off"


def test_replaying_a_reset_key_does_not_power_cycle_twice(bmc: TestClient) -> None:
    """An approval retry or a replan must not hit the machine a second time."""
    args = {"system_id": SYSTEM, "reset_type": "ForceRestart", "reason": "hung", "idempotency_key": "k1"}
    first = redfish.reset_system(**args)
    sel_after_first = len(redfish.get_sel(SYSTEM, last=100)["entries"])
    second = redfish.reset_system(**args)
    assert second["replayed"] is True
    assert second["sel_entry_id"] == first["sel_entry_id"]
    assert len(redfish.get_sel(SYSTEM, last=100)["entries"]) == sel_after_first


def test_powering_a_machine_on_thaws_the_kind_node_it_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    """`hush-chaos hang` froze the container; a power-on has to undo that too."""
    unpaused: list[str] = []
    monkeypatch.setattr(redfish, "_kind_node", lambda system_id: "hush-worker")
    monkeypatch.setattr(redfish, "_docker_unpause", lambda node: bool(unpaused.append(node)) or True)
    result = redfish.reset_system(
        system_id=SYSTEM, reset_type="ForceRestart", reason="hung", idempotency_key="k1"
    )
    assert unpaused == ["hush-worker"]
    assert result["kind_node"] == "hush-worker"
    assert result["unpaused"] is True


def test_powering_a_machine_off_does_not_thaw_anything(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(redfish, "_kind_node", lambda system_id: "hush-worker")
    def never(node: str) -> bool:
        pytest.fail("a shutdown must not unpause the node")

    monkeypatch.setattr(redfish, "_docker_unpause", never)
    result = redfish.reset_system(
        system_id=SYSTEM, reset_type="ForceOff", reason="thermal", idempotency_key="k1"
    )
    assert result["kind_node"] is None
    assert result["unpaused"] is None


def test_a_machine_with_no_kind_node_just_resets() -> None:
    result = redfish.reset_system(
        system_id="R4-N02", reset_type="On", reason="restore", idempotency_key="k1"
    )
    assert result["ok"] is True
    assert result["kind_node"] is None
    assert result["unpaused"] is None


def test_a_thaw_that_failed_is_reported_not_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    """A machine that backs no kind node and one whose thaw failed must not look alike."""
    monkeypatch.setattr(redfish, "_kind_node", lambda system_id: "hush-worker")
    monkeypatch.setattr(redfish, "_docker_unpause", lambda node: False)
    result = redfish.reset_system(
        system_id=SYSTEM, reset_type="On", reason="restore", idempotency_key="k1"
    )
    assert result["kind_node"] == "hush-worker"
    assert result["unpaused"] is False
    assert result["ok"] is False
    assert "still paused" in result["warning"]


def test_a_failed_thaw_does_not_power_cycle_the_machine_again(
    monkeypatch: pytest.MonkeyPatch, bmc: TestClient
) -> None:
    """The reset already happened; retrying the key must replay, not repeat it."""
    monkeypatch.setattr(redfish, "_kind_node", lambda system_id: "hush-worker")
    monkeypatch.setattr(redfish, "_docker_unpause", lambda node: False)
    args = {"system_id": SYSTEM, "reset_type": "ForceRestart", "reason": "hung", "idempotency_key": "k1"}
    redfish.reset_system(**args)
    sel_after_first = len(redfish.get_sel(SYSTEM, last=100)["entries"])
    second = redfish.reset_system(**args)
    assert second["replayed"] is True
    assert len(redfish.get_sel(SYSTEM, last=100)["entries"]) == sel_after_first


def test_a_different_key_is_a_different_action() -> None:
    redfish.reset_system(system_id=SYSTEM, reset_type="ForceOff", reason="a", idempotency_key="k1")
    second = redfish.reset_system(system_id=SYSTEM, reset_type="On", reason="b", idempotency_key="k2")
    assert "replayed" not in second
    assert redfish.get_system(SYSTEM)["power_state"] == "On"
