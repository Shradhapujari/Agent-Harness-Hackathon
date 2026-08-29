"""Stateful mock-BMC fleet simulation. Pure stdlib."""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


def clamp(v: float, lo: float, hi: float) -> float:
    """Clamp v into [lo, hi]."""
    return max(lo, min(hi, v))


class PowerState(str, Enum):
    ON = "On"
    OFF = "Off"
    POWERING_ON = "PoweringOn"
    POWERING_OFF = "PoweringOff"


class Health(str, Enum):
    OK = "OK"
    WARNING = "Warning"
    CRITICAL = "Critical"


@dataclass
class SelEntry:
    """One system event log entry."""

    id: int
    timestamp: str
    severity: str
    code: str
    message: str


@dataclass
class Machine:
    """Simulated node with thermal/power physics state."""

    system_id: str
    rack: str = "R4"
    model: str = "MockRack-1U"
    serial: str = ""
    hostname: str = ""
    power: PowerState = PowerState.ON
    hung: bool = False
    cpu_load_pct: float = 12.0
    cpu_temp_c: float = 45.0
    inlet_temp_c: float = 22.0
    fan_pct: float = 20.0
    psu_ok: dict = field(default_factory=lambda: {1: True, 2: True})
    thermal_trip: bool = False
    sel: list = field(default_factory=list)
    thermal_offset_c: float = 0.0
    thermal_until: float = 0.0
    power_watts: float = 180.0

    def __post_init__(self) -> None:
        if not self.serial:
            self.serial = f"MBMC-{self.system_id}"
        if not self.hostname:
            self.hostname = f"{self.system_id.lower()}.lab"


class Fleet:
    """Fleet of simulated machines with chaos injection and SEL logging."""

    def __init__(self, node_ids: list[str], ambient_c: float = 22.0) -> None:
        self.ambient_c = ambient_c
        self.ambient_offset_c = 0.0
        self._sel_seq = 0
        self.machines: dict[str, Machine] = {
            nid: Machine(system_id=nid, serial=f"MBMC-{nid}", hostname=f"{nid.lower()}.lab")
            for nid in node_ids
        }

    def _machine(self, system_id: str) -> Machine:
        try:
            return self.machines[system_id]
        except KeyError:
            raise ValueError(f"unknown system_id: {system_id}") from None

    def inlet_for(self, m: Machine) -> float:
        """Facility inlet temperature seen by a machine."""
        return self.ambient_c + self.ambient_offset_c

    def log_sel(self, system_id: str, severity: str, code: str, message: str) -> SelEntry:
        """Append an SEL entry (newest last) and return it."""
        self._sel_seq += 1
        entry = SelEntry(
            id=self._sel_seq,
            timestamp=datetime.now(timezone.utc).isoformat(),
            severity=severity,
            code=code,
            message=message,
        )
        self._machine(system_id).sel.append(entry)
        return entry

    def tick(self, dt_s: float = 1.0, now: float | None = None) -> None:
        """Advance physics and fault handling by dt_s seconds."""
        if now is None:
            now = time.monotonic()
        for m in self.machines.values():
            if m.thermal_offset_c != 0.0 and now >= m.thermal_until:
                m.thermal_offset_c = 0.0
            inlet = self.inlet_for(m)
            m.inlet_temp_c = inlet
            if m.power == PowerState.ON and not m.thermal_trip:
                target_cpu = 35.0 + 0.5 * m.cpu_load_pct + 0.6 * inlet + m.thermal_offset_c
                m.cpu_temp_c += (target_cpu - m.cpu_temp_c) * (1.0 - math.exp(-dt_s / 8.0))
                target_fan = clamp(15.0 + 3.0 * (m.cpu_temp_c - 40.0), 15.0, 100.0)
                m.fan_pct += (target_fan - m.fan_pct) * min(1.0, dt_s * 0.5)
                m.power_watts = 90.0 + 1.8 * m.cpu_load_pct + 1.2 * max(0.0, m.cpu_temp_c - 30.0) + 0.5 * m.fan_pct
                if not m.hung:
                    m.cpu_load_pct = clamp(m.cpu_load_pct + random.uniform(-2.0, 2.0), 5.0, 95.0)
            else:
                m.cpu_temp_c += (inlet - m.cpu_temp_c) * (1.0 - math.exp(-dt_s / 15.0))
                m.fan_pct = 0.0
                m.power_watts = 8.0
            if m.power == PowerState.ON and not m.psu_ok[1] and not m.psu_ok[2]:
                m.power = PowerState.OFF
                self.log_sel(m.system_id, "Warning", "PSUFault", "Both PSUs lost input; system powered off")
            if m.cpu_temp_c >= 97.0 and not m.thermal_trip:
                m.thermal_trip = True
                m.power = PowerState.OFF
                self.log_sel(
                    m.system_id,
                    "Critical",
                    "ThermalTrip",
                    f"CPU temperature {m.cpu_temp_c:.1f}C exceeded 97C trip point; system powered off",
                )

    def health(self, m: Machine) -> str:
        """Roll-up health string for a machine."""
        if m.thermal_trip or not all(m.psu_ok.values()) or m.cpu_temp_c >= 90.0:
            return Health.CRITICAL.value
        if m.hung or m.cpu_temp_c >= 80.0:
            return Health.WARNING.value
        return Health.OK.value

    def reset(self, system_id: str, reset_type: str) -> None:
        """Apply a Redfish-style reset action."""
        m = self._machine(system_id)
        if reset_type not in {"On", "ForceOff", "GracefulShutdown", "ForceRestart", "GracefulRestart", "Nmi"}:
            raise ValueError(f"unknown reset_type: {reset_type}")
        if reset_type == "On":
            m.thermal_trip = False
            m.hung = False
            m.power = PowerState.ON
            self.log_sel(system_id, "OK", "PowerStateChange", "System powered on")
        elif reset_type in ("ForceOff", "GracefulShutdown"):
            m.power = PowerState.OFF
            m.hung = False
            self.log_sel(system_id, "OK", "PowerStateChange", "System powered off")
        elif reset_type in ("ForceRestart", "GracefulRestart"):
            m.power = PowerState.OFF
            m.power = PowerState.ON
            m.thermal_trip = False
            m.hung = False
            self.log_sel(system_id, "OK", "PowerStateChange", "System restart requested")
        else:
            self.log_sel(system_id, "Warning", "UserNote", "NMI injected")

    def thermal_spike(self, system_id: str, delta_c: float, duration_s: float) -> None:
        """Inject a temporary CPU thermal offset (chaos)."""
        m = self._machine(system_id)
        m.thermal_offset_c = delta_c
        m.thermal_until = time.monotonic() + duration_s
        self.log_sel(system_id, "Warning", "Chaos", f"Thermal spike {delta_c:+.1f}C for {duration_s:.0f}s")

    def psu_fail(self, system_id: str, psu: int) -> None:
        """Mark a PSU input lost (chaos)."""
        m = self._machine(system_id)
        if psu not in (1, 2):
            raise ValueError(f"unknown psu: {psu}")
        m.psu_ok[psu] = False
        self.log_sel(system_id, "Warning", "PSUFault", f"PSU {psu} lost input")

    def psu_restore(self, system_id: str, psu: int) -> None:
        """Mark a PSU input restored."""
        m = self._machine(system_id)
        if psu not in (1, 2):
            raise ValueError(f"unknown psu: {psu}")
        m.psu_ok[psu] = True
        self.log_sel(system_id, "OK", "PSUFault", f"PSU {psu} input restored")

    def hang(self, system_id: str) -> None:
        """Mark host OS hung (chaos)."""
        m = self._machine(system_id)
        m.hung = True
        self.log_sel(system_id, "Critical", "HostHang", "Host OS stopped responding")

    def unhang(self, system_id: str) -> None:
        """Clear host hang flag."""
        self._machine(system_id).hung = False

    def add_sel(self, system_id: str, severity: str, message: str, code: str = "UserNote") -> None:
        """Append a user SEL entry with validated severity."""
        if severity not in ("OK", "Warning", "Critical"):
            raise ValueError(f"unknown severity: {severity}")
        self.log_sel(system_id, severity, code, message)

    def crac_fail(self, delta_c: float) -> None:
        """Raise facility ambient (chaos); logs on every machine."""
        self.ambient_offset_c += delta_c
        for system_id in self.machines:
            self.log_sel(system_id, "Warning", "Chaos", f"CRAC failure: ambient +{delta_c:.1f}C")

    def crac_restore(self) -> None:
        """Reset facility ambient offset."""
        self.ambient_offset_c = 0.0

    def clear_chaos(self) -> None:
        """Clear chaos state; real faults (thermal_trip) persist."""
        self.ambient_offset_c = 0.0
        for m in self.machines.values():
            m.thermal_offset_c = 0.0
            m.thermal_until = 0.0
            m.psu_ok = {1: True, 2: True}
            m.hung = False

    def snapshot(self) -> dict:
        """Point-in-time fleet state for the API layer."""
        nodes = [
            {
                "system_id": m.system_id,
                "power": m.power.value,
                "hung": m.hung,
                "cpu_load_pct": m.cpu_load_pct,
                "cpu_temp_c": m.cpu_temp_c,
                "inlet_temp_c": m.inlet_temp_c,
                "fan_pct": m.fan_pct,
                "power_watts": m.power_watts,
                "health": self.health(m),
                "psu1_ok": m.psu_ok[1],
                "psu2_ok": m.psu_ok[2],
                "thermal_trip": m.thermal_trip,
            }
            for m in self.machines.values()
        ]
        return {"ambient_c": self.ambient_c, "ambient_offset_c": self.ambient_offset_c, "nodes": nodes}
