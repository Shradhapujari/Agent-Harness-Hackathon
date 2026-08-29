"""Prometheus exposition for the fleet snapshot (GET /metrics, no auth)."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app.state import Fleet

_GAUGES = {  # metric name -> (snapshot key, help)
    "hush_inlet_temp_celsius": ("inlet_temp_c", "Inlet air temperature"),
    "hush_cpu_temp_celsius": ("cpu_temp_c", "CPU temperature"),
    "hush_fan_percent": ("fan_pct", "Fan duty cycle"),
    "hush_power_watts": ("power_watts", "Power draw"),
}


def _bool(v: bool) -> str:
    return "1" if v else "0"


def _label(v: str) -> str:
    """Escape a label value: Prometheus reserves backslash, double quote and newline.

    create_app() takes caller-supplied node ids, and one unescaped quote makes the
    whole scrape unparseable — not just that series.
    """
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def build_metrics_router(fleet: Fleet) -> APIRouter:
    """Expose the live fleet snapshot in Prometheus text format."""
    router = APIRouter()

    @router.get("/metrics", response_class=PlainTextResponse)
    def metrics() -> str:
        snap = fleet.snapshot()
        nodes = snap["nodes"]
        out: list[str] = []
        for name, (key, help_) in _GAUGES.items():
            out.append(f"# HELP {name} {help_}\n# TYPE {name} gauge")
            out += [f'{name}{{system="{_label(n["system_id"])}"}} {n[key]:.2f}' for n in nodes]
        out.append("# TYPE hush_power_on gauge")
        out += [
            f'hush_power_on{{system="{_label(n["system_id"])}"}} {_bool(n["power"] == "On")}'
            for n in nodes
        ]
        out.append("# TYPE hush_host_hung gauge")
        out += [f'hush_host_hung{{system="{_label(n["system_id"])}"}} {_bool(n["hung"])}' for n in nodes]
        out.append("# TYPE hush_thermal_trip gauge")
        out += [
            f'hush_thermal_trip{{system="{_label(n["system_id"])}"}} {_bool(n["thermal_trip"])}'
            for n in nodes
        ]
        out.append("# TYPE hush_psu_ok gauge")
        for n in nodes:
            for psu in (1, 2):
                out.append(
                    f'hush_psu_ok{{system="{_label(n["system_id"])}",psu="{psu}"}} {_bool(n[f"psu{psu}_ok"])}'
                )
        out.append(f'hush_ambient_celsius {snap["ambient_c"] + snap["ambient_offset_c"]:.2f}')
        return "\n".join(out) + "\n"

    return router
