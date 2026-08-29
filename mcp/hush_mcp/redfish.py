"""Redfish MCP server (port 9102): the hardware truth under the alerts.

Reads are thin projections of the DMTF payloads — the agent gets the four or
five numbers that decide an action, not a Redfish document. `reset_system` is
the one destructive tool in the whole system and is gated by the harness
approval node (AGENTS.md, decision D4); the idempotency key makes a re-approval
or a replan replay the first result instead of power-cycling twice.
"""
from __future__ import annotations

import subprocess
from typing import Any

import httpx

from hush_mcp.common import env, guarded, idempotent, make_server

PORT = 9102
mcp = make_server("redfish")

#: The Redfish ResetType values the simulated fleet implements.
RESET_TYPES = ("On", "GracefulShutdown", "ForceOff", "GracefulRestart", "ForceRestart")
#: Resets that are supposed to leave the machine running afterwards.
POWER_ON_RESETS = ("On", "GracefulRestart", "ForceRestart")


def _client() -> httpx.Client:
    """Authenticated HTTP client for the mock BMC (patched in tests)."""
    return httpx.Client(
        base_url=env("HUSH_BMC_URL", "http://127.0.0.1:8100"),
        auth=(env("MOCK_BMC_USER", "root"), env("MOCK_BMC_PASSWORD", "password0")),
        timeout=5.0,
    )


def _get(path: str) -> dict[str, Any]:
    with _client() as http:
        response = http.get(path)
        response.raise_for_status()
        payload: dict[str, Any] = response.json()
    return payload


def _temperature(thermal: dict[str, Any], name: str) -> dict[str, Any]:
    for sensor in thermal.get("Temperatures") or []:
        if sensor.get("Name") == name:
            reading: dict[str, Any] = sensor
            return reading
    return {}


def _sel_entries(system_id: str, last: int) -> list[dict[str, Any]]:
    members = _get(f"/redfish/v1/Systems/{system_id}/LogServices/SEL/Entries").get("Members") or []
    return [
        {
            "id": int(e.get("Id", 0)),
            "created": e.get("Created", ""),
            "severity": e.get("Severity", ""),
            "code": ((e.get("Oem") or {}).get("DCSentinel") or {}).get("Code", ""),
            "message": e.get("Message", ""),
        }
        for e in members[-last:]
    ]


@mcp.tool()
@guarded
def list_systems() -> dict[str, Any]:
    """List every system id known to the BMC."""
    members = _get("/redfish/v1/Systems").get("Members") or []
    return {"systems": [str(m.get("@odata.id", "")).rsplit("/", 1)[-1] for m in members]}


@mcp.tool()
@guarded
def get_system(system_id: str) -> dict[str, Any]:
    """Power state, health, hang flag, rack and CPU load for one system."""
    system = _get(f"/redfish/v1/Systems/{system_id}")
    oem = (system.get("Oem") or {}).get("DCSentinel") or {}
    return {
        "id": system.get("Id", system_id),
        "power_state": system.get("PowerState", ""),
        "health": (system.get("Status") or {}).get("Health", ""),
        "hung": bool(oem.get("Hung", False)),
        "rack": oem.get("Rack", ""),
        "cpu_load_pct": oem.get("CpuLoadPercent", 0.0),
    }


@mcp.tool()
@guarded
def get_thermal(system_id: str) -> dict[str, Any]:
    """Inlet and CPU temperature, fan speed and CPU sensor health for one system."""
    thermal = _get(f"/redfish/v1/Chassis/{system_id}/Thermal")
    inlet = _temperature(thermal, "Inlet")
    cpu = _temperature(thermal, "CPU")
    fans = thermal.get("Fans") or []
    return {
        "inlet_c": inlet.get("ReadingCelsius"),
        "cpu_c": cpu.get("ReadingCelsius"),
        "fan_rpm": (fans[0].get("Reading") if fans else None),
        "cpu_health": (cpu.get("Status") or {}).get("Health", ""),
    }


@mcp.tool()
@guarded
def get_power(system_id: str) -> dict[str, Any]:
    """Consumed watts and per-PSU state for one system."""
    power = _get(f"/redfish/v1/Chassis/{system_id}/Power")
    control = power.get("PowerControl") or [{}]
    return {
        "watts": control[0].get("PowerConsumedWatts"),
        "psu": [
            {
                "name": psu.get("Name", ""),
                "ok": (psu.get("Status") or {}).get("Health") == "OK",
                "watts": psu.get("LastPowerOutputWatts"),
            }
            for psu in (power.get("PowerSupplies") or [])
        ],
    }


@mcp.tool()
@guarded
def get_sel(system_id: str, last: int = 10) -> dict[str, Any]:
    """The last `last` System Event Log entries for one system, oldest first."""
    return {"entries": _sel_entries(system_id, max(last, 1))}


@mcp.tool()
@guarded
def get_fleet_summary() -> dict[str, Any]:
    """One line per machine in the fleet: power, hang flag, temperatures, health.

    Cheaper than 12 `get_system` calls when the question is "which machines are
    in trouble" rather than "what is machine X doing".
    """
    snapshot = _get("/chaos/status")
    return {
        "ambient_c": snapshot.get("ambient_c"),
        "nodes": [
            {
                "id": n.get("system_id", ""),
                "power_state": n.get("power", ""),
                "hung": bool(n.get("hung", False)),
                "inlet_c": n.get("inlet_temp_c"),
                "cpu_c": n.get("cpu_temp_c"),
                "health": n.get("health", ""),
            }
            for n in (snapshot.get("nodes") or [])
        ],
    }


def _kind_node(system_id: str) -> str | None:
    """The kind container backing this machine, if one does (label `hush.io/bmc`)."""
    try:
        from hush_mcp.kubernetes import api

        for node in api().list_node().items:
            if (node.metadata.labels or {}).get("hush.io/bmc") == system_id:
                name: str = node.metadata.name
                return name
    except Exception:  # noqa: BLE001 - no cluster is a normal state here
        return None
    return None


def _unpause_kind_node(system_id: str) -> str | None:
    """Thaw the kind container a power-on is supposed to bring back.

    `hush-chaos hang` freezes a kind node with `docker pause` to make it really
    stop reporting. Powering the machine on over Redfish has to undo that too,
    or the agent would do everything right and the node would stay NotReady.
    """
    node = _kind_node(system_id)
    if node is None:
        return None
    return node if _docker_unpause(node) else None


def _docker_unpause(node: str) -> bool:
    """`docker unpause`, tolerant of a node that was never paused."""
    result = subprocess.run(["docker", "unpause", node], capture_output=True, text=True, check=False)
    return result.returncode == 0


@mcp.tool()
@idempotent
def reset_system(system_id: str, reset_type: str, reason: str, idempotency_key: str) -> dict[str, Any]:
    """Power-action one system. DESTRUCTIVE — requires harness approval.

    Args:
        system_id: Redfish system id, e.g. "R4-N04".
        reset_type: On | GracefulShutdown | ForceOff | GracefulRestart | ForceRestart.
        reason: why this machine, recorded in the run report.
        idempotency_key: repeat calls with the same key replay the first result.
    """
    if reset_type not in RESET_TYPES:
        raise ValueError(f"reset_type must be one of {', '.join(RESET_TYPES)}")
    with _client() as http:
        response = http.post(
            f"/redfish/v1/Systems/{system_id}/Actions/ComputerSystem.Reset",
            json={"ResetType": reset_type},
        )
        response.raise_for_status()
    unpaused = _unpause_kind_node(system_id) if reset_type in POWER_ON_RESETS else None
    entries = _sel_entries(system_id, 1)
    return {
        "ok": True,
        "system_id": system_id,
        "reset_type": reset_type,
        "reason": reason,
        "sel_entry_id": entries[-1]["id"] if entries else None,
        "unpaused_k8s_node": unpaused,
    }
