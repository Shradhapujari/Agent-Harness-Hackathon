"""Seed NetBox with the rack the demo talks about. Idempotent: safe to re-run.

The same fleet is kept in `seed.json`, which the NetBox MCP server falls back to
when the live API is slow or down. This script is the only writer of NetBox;
every tool the agent has is read-only (decision D3).

    HUSH_NETBOX_TOKEN=... uv run python infra/netbox/seed.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

SEED = Path(__file__).with_name("seed.json")
BASE_URL = os.getenv("HUSH_NETBOX_URL", "http://127.0.0.1:8000")
TOKEN = os.getenv("HUSH_NETBOX_TOKEN", "hush-local-netbox-token-not-a-secret")


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=BASE_URL,
        headers={"Authorization": f"Token {TOKEN}", "Accept": "application/json"},
        timeout=30.0,
    )


def ensure(http: httpx.Client, path: str, lookup: dict[str, Any], payload: dict[str, Any]) -> int:
    """Return the id of the object matching `lookup`, creating it if absent."""
    existing = http.get(path, params=lookup)
    existing.raise_for_status()
    results = existing.json().get("results") or []
    if results:
        object_id: int = results[0]["id"]
        return object_id
    created = http.post(path, json=payload)
    created.raise_for_status()
    new_id: int = created.json()["id"]
    return new_id


def seed(http: httpx.Client, data: dict[str, Any]) -> dict[str, int]:
    """Create site, rack, tenants, device type/role and the twelve devices."""
    site = data["site"]
    site_id = ensure(http, "/api/dcim/sites/", {"slug": site["slug"]}, site)

    tenant_ids = {
        name: ensure(http, "/api/tenancy/tenants/", {"slug": name}, {"name": name, "slug": name})
        for name in data["tenants"]
    }

    rack = data["rack"]
    rack_id = ensure(
        http,
        "/api/dcim/racks/",
        {"name": rack["name"], "site_id": site_id},
        {"name": rack["name"], "site": site_id, "u_height": rack["u_height"], "status": "active"},
    )

    device_type = data["device_type"]
    manufacturer_id = ensure(
        http,
        "/api/dcim/manufacturers/",
        {"slug": "hush-labs"},
        {"name": device_type["manufacturer"], "slug": "hush-labs"},
    )
    type_id = ensure(
        http,
        "/api/dcim/device-types/",
        {"slug": device_type["slug"]},
        {
            "model": device_type["model"],
            "slug": device_type["slug"],
            "manufacturer": manufacturer_id,
            "u_height": 1,
        },
    )

    role = data["device_role"]
    role_id = ensure(
        http,
        "/api/dcim/device-roles/",
        {"slug": role["slug"]},
        {"name": role["name"], "slug": role["slug"], "color": "2196f3"},
    )

    # The BMC id is the join between NetBox and Redfish, so it has to survive as
    # a first-class field rather than as a note somewhere.
    ensure(
        http,
        "/api/extras/custom-fields/",
        {"name": "bmc_id"},
        {
            "object_types": ["dcim.device"],
            "name": "bmc_id",
            "label": "BMC id",
            "type": "text",
            "required": False,
        },
    )

    device_ids = {}
    for device in data["devices"]:
        device_ids[device["name"]] = ensure(
            http,
            "/api/dcim/devices/",
            {"name": device["name"]},
            {
                "name": device["name"],
                "device_type": type_id,
                "role": role_id,
                "site": site_id,
                "rack": rack_id,
                "position": device["position"],
                "face": "front",
                "serial": device["serial"],
                "tenant": tenant_ids[device["tenant"]],
                "status": "active",
                "custom_fields": {"bmc_id": device["bmc_id"]},
            },
        )
    return device_ids


def main() -> int:
    data = json.loads(SEED.read_text())
    try:
        with _client() as http:
            device_ids = seed(http, data)
    except httpx.HTTPError as exc:
        print(f"netbox seed failed: {exc}", file=sys.stderr)
        return 1
    print(f"seeded {len(device_ids)} devices in rack {data['rack']['name']} at {BASE_URL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
