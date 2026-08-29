"""Chaos injector API: fault-dial routes over the Fleet simulator."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.state import Fleet


class ThermalSpikeBody(BaseModel):
    system: str
    delta_c: float
    duration_s: float = 120.0


class PsuBody(BaseModel):
    system: str
    psu: int


class SystemBody(BaseModel):
    system: str


class SelBody(BaseModel):
    system: str
    severity: str = "Warning"
    message: str


class CracBody(BaseModel):
    delta_c: float = 14.0


def _not_found(system_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": {"code": "SystemNotFound", "message": f"System {system_id} not found"}},
    )


def _bad_request(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail={"error": {"code": "BadRequest", "message": str(exc)}})


def _run(fleet: Fleet, system_id: str, fn: Callable[[], Any]) -> Any:
    if system_id not in fleet.machines:
        raise _not_found(system_id)
    try:
        return fn()
    except ValueError as exc:
        raise _bad_request(exc) from None


def build_chaos_router(fleet: Fleet) -> APIRouter:
    """Build the /chaos router bound to a Fleet."""
    router = APIRouter()

    @router.post("/chaos/thermal-spike")
    def thermal_spike(body: ThermalSpikeBody) -> dict[str, Any]:
        _run(fleet, body.system, lambda: fleet.thermal_spike(body.system, body.delta_c, body.duration_s))
        return {
            "result": f"thermal spike {body.delta_c:+.1f}C on {body.system}"
            f" for {body.duration_s:.0f}s",
            "system": body.system,
        }

    @router.post("/chaos/psu-fail")
    def psu_fail(body: PsuBody) -> dict[str, Any]:
        _run(fleet, body.system, lambda: fleet.psu_fail(body.system, body.psu))
        return {"result": f"PSU {body.psu} failed on {body.system}", "system": body.system}

    @router.post("/chaos/psu-restore")
    def psu_restore(body: PsuBody) -> dict[str, Any]:
        _run(fleet, body.system, lambda: fleet.psu_restore(body.system, body.psu))
        return {"result": f"PSU {body.psu} restored on {body.system}", "system": body.system}

    @router.post("/chaos/hang")
    def hang(body: SystemBody) -> dict[str, Any]:
        _run(fleet, body.system, lambda: fleet.hang(body.system))
        return {"result": f"{body.system} host hung (BMC still alive)", "system": body.system}

    @router.post("/chaos/unhang")
    def unhang(body: SystemBody) -> dict[str, Any]:
        _run(fleet, body.system, lambda: fleet.unhang(body.system))
        return {"result": f"{body.system} host unhung", "system": body.system}

    @router.post("/chaos/sel")
    def add_sel(body: SelBody) -> dict[str, Any]:
        _run(fleet, body.system, lambda: fleet.add_sel(body.system, body.severity, body.message))
        return {"result": "SEL entry added", "system": body.system}

    @router.post("/chaos/crac-failure")
    def crac_failure(body: CracBody) -> dict[str, Any]:
        fleet.crac_fail(body.delta_c)
        return {"result": f"CRAC failure: facility ambient +{body.delta_c:.1f}C"}

    @router.post("/chaos/crac-restore")
    def crac_restore() -> dict[str, Any]:
        fleet.crac_restore()
        return {"result": "CRAC restored; facility ambient nominal"}

    @router.post("/chaos/clear")
    def clear() -> dict[str, Any]:
        fleet.clear_chaos()
        return {"result": "chaos cleared; nominal state restored"}

    @router.get("/chaos/status")
    def status() -> dict[str, Any]:
        return fleet.snapshot()

    return router
