"""Pure simulation tests for app.state (no HTTP)."""
import time
from datetime import datetime

import pytest

from app.state import Fleet, PowerState


def _fleet_one() -> Fleet:
    return Fleet(["T1"])


def test_powered_on_node_heats_and_draws_power():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    m.cpu_load_pct = 90.0
    for _ in range(30):
        fleet.tick(1.0)
    assert m.cpu_temp_c > 70.0
    assert m.fan_pct > 50.0
    assert m.power_watts > 200.0


def test_idle_node_stays_cool():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    m.cpu_load_pct = 10.0
    for _ in range(30):
        fleet.tick(1.0)
    assert m.cpu_temp_c < 65.0


def test_power_off_cools_to_inlet_and_idle_watts():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    fleet.reset("T1", "ForceOff")
    for _ in range(60):
        fleet.tick(1.0)
    assert abs(m.cpu_temp_c - m.inlet_temp_c) < 3.0
    assert m.power_watts == pytest.approx(8.0)
    assert m.fan_pct == 0.0


def test_thermal_trip_at_97c_powers_off_and_logs_sel():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    m.cpu_load_pct = 95.0
    fleet.thermal_spike("T1", 60, 1000)
    tripped = False
    for _ in range(200):
        fleet.tick(1.0)
        if m.thermal_trip:
            tripped = True
            break
    assert tripped
    assert m.power == PowerState.OFF
    codes = [e.code for e in m.sel]
    assert "ThermalTrip" in codes
    entry = next(e for e in m.sel if e.code == "ThermalTrip")
    assert entry.severity == "Critical"


def test_both_psus_fail_powers_off_and_logs_sel():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    fleet.psu_fail("T1", 1)
    fleet.psu_fail("T1", 2)
    fleet.tick(1.0)
    assert m.power == PowerState.OFF
    assert any(e.code == "PSUFault" for e in m.sel)


def test_reset_invalid_type_raises_value_error():
    fleet = _fleet_one()
    with pytest.raises(ValueError):
        fleet.reset("T1", "Bogus")


def test_reset_unknown_system_raises_value_error():
    fleet = _fleet_one()
    with pytest.raises(ValueError):
        fleet.reset("Nope", "On")


def test_thermal_spike_expires():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    fleet.thermal_spike("T1", 50, 5)
    fleet.tick(1.0)
    assert m.thermal_offset_c == 50.0
    fleet.tick(1.0, now=time.monotonic() + 10)
    assert m.thermal_offset_c == 0.0


def test_crac_failure_raises_all_inlets():
    fleet = Fleet(["T1", "T2"])
    fleet.crac_fail(14)
    for _ in range(1):
        fleet.tick(1.0)
    for m in fleet.machines.values():
        assert m.inlet_temp_c >= fleet.ambient_c + 13.0


def test_clear_chaos_resets_offsets_psus_hang_and_keeps_sel():
    fleet = Fleet(["T1", "T2"])
    fleet.crac_fail(10)
    fleet.thermal_spike("T1", 20, 500)
    fleet.psu_fail("T1", 1)
    fleet.hang("T2")
    sel_counts = {sid: len(m.sel) for sid, m in fleet.machines.items()}
    assert sum(sel_counts.values()) > 0
    fleet.clear_chaos()
    assert fleet.ambient_offset_c == 0.0
    for m in fleet.machines.values():
        assert m.thermal_offset_c == 0.0
        assert m.thermal_until == 0.0
        assert m.psu_ok == {1: True, 2: True}
        assert m.hung is False
        assert len(m.sel) == sel_counts[m.system_id]


@pytest.mark.parametrize("terminal_fault", ["thermal", "psu"])
def test_clear_chaos_restores_chaos_terminated_machine(terminal_fault: str):
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    if terminal_fault == "thermal":
        m.thermal_trip = True
        m.power = PowerState.OFF
    else:
        fleet.psu_fail("T1", 1)
        fleet.psu_fail("T1", 2)
        fleet.tick()
    sel_count = len(m.sel)

    fleet.clear_chaos()

    assert m.power == PowerState.ON
    assert m.thermal_trip is False
    assert m.psu_ok == {1: True, 2: True}
    assert len(m.sel) == sel_count


def test_sel_ids_increase_timestamps_iso_newest_last():
    fleet = _fleet_one()
    e1 = fleet.log_sel("T1", "OK", "UserNote", "first")
    e2 = fleet.log_sel("T1", "Warning", "Chaos", "second")
    e3 = fleet.log_sel("T1", "Critical", "ThermalTrip", "third")
    ids = [e.id for e in fleet.machines["T1"].sel]
    assert ids == sorted(ids)
    assert ids[0] < ids[1] < ids[2]
    assert [e1.id, e2.id, e3.id] == ids
    for e in fleet.machines["T1"].sel:
        parsed = datetime.fromisoformat(e.timestamp)
        assert parsed.tzinfo is not None
    assert fleet.machines["T1"].sel[-1].message == "third"


def test_sel_wraps_at_1000_records_and_keeps_newest_entries():
    fleet = _fleet_one()
    for number in range(1002):
        fleet.log_sel("T1", "OK", "UserNote", str(number))

    entries = fleet.machines["T1"].sel
    assert len(entries) == 1000
    assert entries[0].message == "2"
    assert entries[-1].message == "1001"
    assert [entry.id for entry in entries] == list(range(3, 1003))


def test_hung_machine_load_frozen_across_ticks():
    fleet = _fleet_one()
    m = fleet.machines["T1"]
    m.cpu_load_pct = 42.0
    fleet.hang("T1")
    for _ in range(10):
        fleet.tick(1.0)
    assert m.cpu_load_pct == 42.0
