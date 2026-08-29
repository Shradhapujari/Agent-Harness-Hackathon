"""Redfish (DMTF) subset API over the fleet simulation."""
from __future__ import annotations

import os
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app.state import Fleet, Machine, SelEntry

# Redfish bodies are free-form JSON; handlers that can 404 also return a JSONResponse.
JsonDict = dict[str, Any]
JsonReply = JsonDict | JSONResponse

_security = HTTPBasic()


def _require_auth(credentials: Annotated[HTTPBasicCredentials, Depends(_security)]) -> None:
    """Validate HTTP Basic credentials against env-configured values."""
    user = os.getenv("MOCK_BMC_USER", "root")
    password = os.getenv("MOCK_BMC_PASSWORD", "password0")
    if credentials.username != user or credentials.password != password:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Basic"},
        )


def _not_found(msg: str) -> JSONResponse:
    """Standard Redfish-style 404 body."""
    return JSONResponse(
        {"error": {"code": "Base.1.15.ResourceNotFound", "message": msg}},
        status_code=404,
    )


def _system_collection(fleet: Fleet) -> JsonDict:
    """ComputerSystem collection payload."""
    sids = list(fleet.machines)
    return {
        "@odata.id": "/redfish/v1/Systems",
        "@odata.type": "#ComputerSystemCollection.ComputerSystemCollection",
        "Name": "Computer Systems Collection",
        "Members": [{"@odata.id": f"/redfish/v1/Systems/{sid}"} for sid in sids],
        "Members@odata.count": len(sids),
    }


def _computer_system(m: Machine, health: str) -> JsonDict:
    """ComputerSystem payload for one machine."""
    sid = m.system_id
    return {
        "@odata.id": f"/redfish/v1/Systems/{sid}",
        "@odata.type": "#ComputerSystem.v1_18_0.ComputerSystem",
        "Id": sid,
        "Name": f"Compute Node {sid}",
        "Model": m.model,
        "SerialNumber": m.serial,
        "HostName": m.hostname,
        "PowerState": m.power.value,
        "Status": {"State": "Enabled", "Health": health},
        "ProcessorSummary": {"Count": 2, "Model": "Mock Xeon"},
        "MemorySummary": {"TotalSystemMemoryGiB": 256},
        "Oem": {
            "DCSentinel": {
                "Hung": m.hung,
                "Rack": m.rack,
                "CpuLoadPercent": round(m.cpu_load_pct, 1),
            }
        },
    }


def _chassis_collection(fleet: Fleet) -> JsonDict:
    """Chassis collection payload (one chassis per system)."""
    sids = list(fleet.machines)
    return {
        "@odata.id": "/redfish/v1/Chassis",
        "@odata.type": "#ChassisCollection.ChassisCollection",
        "Name": "Chassis Collection",
        "Members": [{"@odata.id": f"/redfish/v1/Chassis/{sid}"} for sid in sids],
        "Members@odata.count": len(sids),
    }


def _chassis(m: Machine, health: str) -> JsonDict:
    """Chassis payload for one machine."""
    sid = m.system_id
    return {
        "@odata.id": f"/redfish/v1/Chassis/{sid}",
        "@odata.type": "#Chassis.v1_25_0.Chassis",
        "Id": sid,
        "Name": f"Chassis {sid}",
        "ChassisType": "RackMount",
        "Status": {"State": "Enabled", "Health": health},
        "Thermal": {"@odata.id": f"/redfish/v1/Chassis/{sid}/Thermal"},
        "Power": {"@odata.id": f"/redfish/v1/Chassis/{sid}/Power"},
        "Links": {"ComputerSystems": [{"@odata.id": f"/redfish/v1/Systems/{sid}"}]},
    }


def _thermal(m: Machine) -> JsonDict:
    """Thermal subsystem payload."""
    return {
        "@odata.id": f"/redfish/v1/Chassis/{m.system_id}/Thermal",
        "@odata.type": "#Thermal.v1_7_0.Thermal",
        "Temperatures": [
            {
                "MemberId": "0",
                "Name": "Inlet",
                "SensorNumber": 1,
                "ReadingCelsius": round(m.inlet_temp_c, 1),
                "Status": {"State": "Enabled", "Health": "OK"},
            },
            {
                "MemberId": "1",
                "Name": "CPU",
                "SensorNumber": 2,
                "ReadingCelsius": round(m.cpu_temp_c, 1),
                "UpperThresholdCritical": 97.0,
                "UpperThresholdWarning": 80.0,
                "Status": {
                    "State": "Enabled",
                    "Health": "Warning" if m.cpu_temp_c >= 80 else "OK",
                },
            },
        ],
        "Fans": [
            {
                "MemberId": "0",
                "Name": "Front System Fan",
                "SensorNumber": 1,
                "Reading": int(m.fan_pct * 120),
                "ReadingUnits": "RPM",
                "FanName": "Front",
                "Status": {"State": "Enabled", "Health": "OK"},
            }
        ],
        "Redundancy": [],
    }


def _psu_watts(m: Machine, psu: int) -> float:
    """Last power output watts for one PSU."""
    if m.psu_ok[1] and m.psu_ok[2]:
        return round(m.power_watts / 2, 1)
    return round(m.power_watts if m.psu_ok[psu] else 0.0, 1)


def _power(m: Machine) -> JsonDict:
    """Power subsystem payload."""
    return {
        "@odata.id": f"/redfish/v1/Chassis/{m.system_id}/Power",
        "@odata.type": "#Power.v1_7_0.Power",
        "PowerControl": [
            {
                "MemberId": "0",
                "PowerConsumedWatts": round(m.power_watts, 1),
                "PowerCapacityWatts": 800.0,
                "Status": {"State": "Enabled", "Health": "OK"},
            }
        ],
        "PowerSupplies": [
            {
                "MemberId": "0",
                "Name": "PSU1",
                "LastPowerOutputWatts": _psu_watts(m, 1),
                "Status": {
                    "State": "Enabled",
                    "Health": "OK" if m.psu_ok[1] else "Critical",
                },
            },
            {
                "MemberId": "1",
                "Name": "PSU2",
                "LastPowerOutputWatts": _psu_watts(m, 2),
                "Status": {
                    "State": "Enabled",
                    "Health": "OK" if m.psu_ok[2] else "Critical",
                },
            },
        ],
    }


def _log_service(sid: str) -> JsonDict:
    """SEL LogService resource payload."""
    return {
        "@odata.id": f"/redfish/v1/Systems/{sid}/LogServices/SEL",
        "@odata.type": "#LogService.v1_5_0.LogService",
        "Id": "SEL",
        "Name": "System Event Log",
        "OverWritePolicy": "WrapsWhenFull",
        "MaxNumberOfRecords": 1000,
        "Entries": {
            "@odata.id": f"/redfish/v1/Systems/{sid}/LogServices/SEL/Entries"
        },
    }


def _sel_entry(sid: str, e: SelEntry) -> JsonDict:
    """Single LogEntry payload."""
    return {
        "@odata.id": f"/redfish/v1/Systems/{sid}/LogServices/SEL/Entries/{e.id}",
        "@odata.type": "#LogEntry.v1_14_0.LogEntry",
        "Id": str(e.id),
        "Name": "SEL Entry",
        "EntryType": "SEL",
        "Severity": e.severity,
        "Created": e.timestamp,
        "Message": e.message,
        "Oem": {"DCSentinel": {"Code": e.code}},
    }


def build_router(fleet: Fleet) -> APIRouter:
    """Build the Redfish API router bound to a fleet."""
    router = APIRouter(dependencies=[Depends(_require_auth)])

    @router.get("/redfish/v1")
    def service_root() -> JsonDict:
        """Redfish service root."""
        return {
            "@odata.id": "/redfish/v1/",
            "@odata.type": "#ServiceRoot.v1_15_0.ServiceRoot",
            "Id": "RootService",
            "Name": "DC-Sentinel Mock BMC",
            "RedfishVersion": "1.15.0",
            "Systems": {"@odata.id": "/redfish/v1/Systems"},
            "Chassis": {"@odata.id": "/redfish/v1/Chassis"},
        }

    @router.get("/redfish/v1/Systems")
    def list_systems() -> JsonDict:
        """All computer systems."""
        return _system_collection(fleet)

    @router.get("/redfish/v1/Systems/{system_id}", response_model=JsonDict)
    def get_system(system_id: str) -> JsonReply:
        """One computer system."""
        m = fleet.machines.get(system_id)
        if m is None:
            return _not_found(f"System {system_id} not found")
        return _computer_system(m, fleet.health(m))

    @router.post("/redfish/v1/Systems/{system_id}/Actions/ComputerSystem.Reset", response_model=JsonDict)
    def reset_system(system_id: str, body: JsonDict) -> JsonReply:
        """Apply a reset action to one system."""
        if system_id not in fleet.machines:
            return _not_found(f"System {system_id} not found")
        reset_type = body.get("ResetType")
        if not isinstance(reset_type, str):
            return JSONResponse(
                {
                    "error": {
                        "code": "Base.1.15.PropertyMissing",
                        "message": "ResetType is required",
                    }
                },
                status_code=400,
            )
        try:
            fleet.reset(system_id, reset_type)
        except ValueError:
            return JSONResponse(
                {
                    "error": {
                        "code": "Base.1.15.ActionParameterValueError",
                        "message": f"Unknown ResetType: {reset_type}",
                    }
                },
                status_code=400,
            )
        return {
            "@odata.type": "#ComputerSystem.ResetResponse",
            "ResetType": reset_type,
            "Message": "Operation submitted",
        }

    @router.get("/redfish/v1/Chassis")
    def list_chassis() -> JsonDict:
        """All chassis."""
        return _chassis_collection(fleet)

    @router.get("/redfish/v1/Chassis/{system_id}", response_model=JsonDict)
    def get_chassis(system_id: str) -> JsonReply:
        """One chassis."""
        m = fleet.machines.get(system_id)
        if m is None:
            return _not_found(f"Chassis {system_id} not found")
        return _chassis(m, fleet.health(m))

    @router.get("/redfish/v1/Chassis/{system_id}/Thermal", response_model=JsonDict)
    def get_thermal(system_id: str) -> JsonReply:
        """Thermal sensors for one chassis."""
        m = fleet.machines.get(system_id)
        if m is None:
            return _not_found(f"Chassis {system_id} not found")
        return _thermal(m)

    @router.get("/redfish/v1/Chassis/{system_id}/Power", response_model=JsonDict)
    def get_power(system_id: str) -> JsonReply:
        """Power sensors for one chassis."""
        m = fleet.machines.get(system_id)
        if m is None:
            return _not_found(f"Chassis {system_id} not found")
        return _power(m)

    @router.get("/redfish/v1/Systems/{system_id}/LogServices/SEL", response_model=JsonDict)
    def get_sel(system_id: str) -> JsonReply:
        """SEL log service for one system."""
        if system_id not in fleet.machines:
            return _not_found(f"System {system_id} not found")
        return _log_service(system_id)

    @router.get("/redfish/v1/Systems/{system_id}/LogServices/SEL/Entries", response_model=JsonDict)
    def list_sel_entries(system_id: str) -> JsonReply:
        """All SEL entries for one system, newest last."""
        m = fleet.machines.get(system_id)
        if m is None:
            return _not_found(f"System {system_id} not found")
        entries = m.sel
        return {
            "@odata.id": f"/redfish/v1/Systems/{system_id}/LogServices/SEL/Entries",
            "@odata.type": "#LogEntryCollection.LogEntryCollection",
            "Name": "SEL Entries",
            "Members": [_sel_entry(system_id, e) for e in entries],
            "Members@odata.count": len(entries),
        }

    @router.get("/redfish/v1/Systems/{system_id}/LogServices/SEL/Entries/{entry_id}", response_model=JsonDict)
    def get_sel_entry(system_id: str, entry_id: str) -> JsonReply:
        """One SEL entry by numeric id."""
        m = fleet.machines.get(system_id)
        if m is None:
            return _not_found(f"System {system_id} not found")
        try:
            eid = int(entry_id)
        except ValueError:
            return _not_found(f"Entry {entry_id} not found")
        for e in m.sel:
            if e.id == eid:
                return _sel_entry(system_id, e)
        return _not_found(f"Entry {entry_id} not found")

    return router
