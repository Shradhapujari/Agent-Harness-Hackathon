"""NetBox MCP server (port 9105): who owns the machines an action would touch.

Read-only by decision D3. NetBox is the slowest and least essential service in
the stack, so every tool has a fallback: if the live API does not answer inside
`TIMEOUT_S`, the same question is answered from `infra/netbox/seed.json` and the
result is labelled `source: "fallback"`. The agent still gets its blast radius,
and the report stays honest about where the answer came from.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx

from hush_mcp.common import env, guarded, make_server

PORT = 9105
mcp = make_server("netbox")

#: NetBox is inventory, not telemetry: waiting longer than this costs the run
#: more than the fallback costs in precision.
TIMEOUT_S = 3.0
SEED = Path(__file__).resolve().parents[2] / "infra" / "netbox" / "seed.json"


def _client() -> httpx.Client:
    """HTTP client for the local NetBox (patched in tests)."""
    return httpx.Client(
        base_url=env("HUSH_NETBOX_URL", "http://127.0.0.1:8000"),
        headers={"Authorization": f"Token {env('HUSH_NETBOX_TOKEN', '')}", "Accept": "application/json"},
        timeout=TIMEOUT_S,
    )


#: The fields every device answer carries, whichever source produced it.
FIELDS = ("name", "rack", "site", "role", "tenant", "model", "serial", "bmc_id")


def _seed_devices() -> list[dict[str, Any]]:
    """The seeded fleet, projected onto the same shape as a live NetBox answer."""
    seed: dict[str, Any] = json.loads(SEED.read_text())
    return [{k: d.get(k, "") for k in FIELDS} for d in seed["devices"]]


def _from_netbox(raw: dict[str, Any]) -> dict[str, Any]:
    """Project one NetBox device onto the shape the agent reasons about."""
    def name_of(value: Any) -> str:
        return str((value or {}).get("name", "")) if isinstance(value, dict) else ""

    device_type = raw.get("device_type") or {}
    return {
        "name": raw.get("name", ""),
        "rack": name_of(raw.get("rack")),
        "site": name_of(raw.get("site")),
        "role": name_of(raw.get("role") or raw.get("device_role")),
        "tenant": name_of(raw.get("tenant")),
        "model": str(device_type.get("model", "")),
        "serial": raw.get("serial", ""),
        "bmc_id": (raw.get("custom_fields") or {}).get("bmc_id", ""),
    }


def _live_devices(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Query NetBox; return None if it is slow, down, or unhappy."""
    try:
        with _client() as http:
            response = http.get("/api/dcim/devices/", params=params)
            response.raise_for_status()
            results = response.json().get("results") or []
    except (httpx.HTTPError, ValueError):
        return None
    return [_from_netbox(d) for d in results]


def _devices(params: dict[str, Any], match: Any) -> tuple[list[dict[str, Any]], str]:
    """Live devices if NetBox answers, else the seeded answer — always labelled."""
    live = _live_devices(params)
    if live is not None:
        return live, "live"
    return [d for d in _seed_devices() if match(d)], "fallback"


@mcp.tool()
@guarded
def get_device(name: str) -> dict[str, Any]:
    """Inventory record for one device: rack, site, role, tenant, model, serial."""
    devices, source = _devices({"name": name}, lambda d: d["name"] == name)
    if not devices:
        return {"error": {"code": "DeviceNotFound", "message": f"no device named {name}"}, "source": source}
    return {**devices[0], "source": source}


@mcp.tool()
@guarded
def list_rack_devices(rack: str) -> dict[str, Any]:
    """Every device in a rack, plus the tenants those devices belong to."""
    devices, source = _devices({"rack": rack, "limit": 100}, lambda d: d["rack"] == rack)
    return {
        "rack": rack,
        "devices": devices,
        "tenants": sorted({d["tenant"] for d in devices if d["tenant"]}),
        "source": source,
    }


@mcp.tool()
@guarded
def get_blast_radius(nodes: list[str]) -> dict[str, Any]:
    """Who is affected if these machines go away — the question an approval turns on."""
    wanted = set(nodes)
    devices, source = _devices({"name": nodes, "limit": 100}, lambda d: d["name"] in wanted)
    by_tenant: dict[str, list[str]] = {}
    for device in devices:
        by_tenant.setdefault(device["tenant"] or "unassigned", []).append(device["name"])
    return {
        "racks": sorted({d["rack"] for d in devices if d["rack"]}),
        "tenants": [{"name": t, "devices": sorted(ds)} for t, ds in sorted(by_tenant.items())],
        "device_count": len(devices),
        "missing": sorted(wanted - {d["name"] for d in devices}),
        "source": source,
    }
