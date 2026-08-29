"""NetBox tools: the live projection, and the fallback that keeps the run moving."""
from __future__ import annotations

from typing import Any

import httpx
import pytest

from hush_mcp import netbox


def _mock(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(
        netbox,
        "_client",
        lambda: httpx.Client(transport=httpx.MockTransport(record), base_url="http://netbox"),
    )
    return seen


def _live_device(name: str, tenant: str = "acme", rack: str = "R4") -> dict[str, Any]:
    return {
        "name": name,
        "rack": {"name": rack},
        "site": {"name": "SFO-LAB"},
        "role": {"name": "compute"},
        "tenant": {"name": tenant},
        "device_type": {"model": "MockRack-1U"},
        "serial": f"MBMC-{name}",
        "custom_fields": {"bmc_id": name},
    }


def _results(*devices: dict[str, Any]) -> dict[str, Any]:
    return {"count": len(devices), "results": list(devices)}


def test_a_live_device_is_projected_onto_the_agents_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_results(_live_device("R4-N04"))))
    device = netbox.get_device("R4-N04")
    assert device == {
        "name": "R4-N04",
        "rack": "R4",
        "site": "SFO-LAB",
        "role": "compute",
        "tenant": "acme",
        "model": "MockRack-1U",
        "serial": "MBMC-R4-N04",
        "bmc_id": "R4-N04",
        "source": "live",
    }


def test_a_dead_netbox_falls_back_to_the_seed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Inventory is nice to have; stalling the incident on it is not."""
    _mock(monkeypatch, lambda r: httpx.Response(502))
    device = netbox.get_device("R4-N04")
    assert device["source"] == "fallback"
    assert device["tenant"] == "acme"
    assert device["bmc_id"] == "R4-N04"


def test_a_slow_netbox_falls_back_too(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    _mock(monkeypatch, timeout)
    assert netbox.list_rack_devices("R4")["source"] == "fallback"


def test_an_unknown_device_is_reported_with_its_source(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_results()))
    result = netbox.get_device("R9-N99")
    assert result["error"]["code"] == "DeviceNotFound"
    assert result["source"] == "live"


def test_a_rack_lists_its_devices_and_tenants(monkeypatch: pytest.MonkeyPatch) -> None:
    devices = _results(_live_device("R4-N01"), _live_device("R4-N02", tenant="globex"))
    _mock(monkeypatch, lambda r: httpx.Response(200, json=devices))
    rack = netbox.list_rack_devices("R4")
    assert rack["rack"] == "R4"
    assert rack["tenants"] == ["acme", "globex"]
    assert len(rack["devices"]) == 2


def test_the_seeded_rack_has_all_twelve_machines(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(503))
    rack = netbox.list_rack_devices("R4")
    assert len(rack["devices"]) == 12
    assert rack["tenants"] == ["acme", "globex", "initech"]


def test_blast_radius_groups_the_machines_by_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    """This is the number an approval turns on: whose service goes down."""
    devices = _results(_live_device("R4-N04"), _live_device("R4-N05", tenant="globex"))
    _mock(monkeypatch, lambda r: httpx.Response(200, json=devices))
    radius = netbox.get_blast_radius(["R4-N04", "R4-N05"])
    assert radius["device_count"] == 2
    assert radius["racks"] == ["R4"]
    assert radius["tenants"] == [
        {"name": "acme", "devices": ["R4-N04"]},
        {"name": "globex", "devices": ["R4-N05"]},
    ]
    assert radius["missing"] == []


def test_a_paged_answer_is_read_to_the_end(monkeypatch: pytest.MonkeyPatch) -> None:
    """A blast radius that is quietly too small is worse than none at all."""
    pages = [
        {"count": 2, "next": "http://netbox/api/dcim/devices/?offset=1", "results": [_live_device("R4-N01")]},
        {"count": 2, "next": None, "results": [_live_device("R4-N02", tenant="globex")]},
    ]
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json=pages.pop(0)))
    rack = netbox.list_rack_devices("R4")
    assert len(seen) == 2
    assert [d["name"] for d in rack["devices"]] == ["R4-N01", "R4-N02"]
    assert rack["tenants"] == ["acme", "globex"]


def test_an_endless_pagination_loop_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    page = {
        "count": 99,
        "next": "http://netbox/api/dcim/devices/?offset=1",
        "results": [_live_device("R4-N01")],
    }
    _mock(monkeypatch, lambda r: httpx.Response(200, json=page))
    assert netbox.list_rack_devices("R4")["source"] == "fallback"


def test_blast_radius_says_which_machines_it_could_not_find(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock(monkeypatch, lambda r: httpx.Response(200, json=_results(_live_device("R4-N04"))))
    radius = netbox.get_blast_radius(["R4-N04", "R9-N99"])
    assert radius["missing"] == ["R9-N99"]
