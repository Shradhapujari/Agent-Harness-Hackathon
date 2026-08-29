"""Redfish API tests via TestClient (ticker frozen with tick_interval_s=3600)."""
from app.main import create_app
from fastapi.testclient import TestClient

AUTH = ("root", "password0")


def _client() -> TestClient:
    app = create_app(node_ids=["T1", "T2"], tick_interval_s=3600)
    return TestClient(app)


def test_service_root_has_system_and_chassis_links():
    client = _client()
    r = client.get("/redfish/v1", auth=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["Systems"]["@odata.id"] == "/redfish/v1/Systems"
    assert body["Chassis"]["@odata.id"] == "/redfish/v1/Chassis"


def test_systems_collection_has_two_members():
    client = _client()
    r = client.get("/redfish/v1/Systems", auth=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["Members@odata.count"] == 2
    assert len(body["Members"]) == 2


def test_system_payload_fields():
    client = _client()
    r = client.get("/redfish/v1/Systems/T1", auth=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["PowerState"] == "On"
    assert "Health" in body["Status"]
    oem = body["Oem"]["DCSentinel"]
    assert "Hung" in oem
    assert "Rack" in oem
    assert "CpuLoadPercent" in oem


def test_unknown_system_returns_404_error_dict():
    client = _client()
    r = client.get("/redfish/v1/Systems/ZZ", auth=AUTH)
    assert r.status_code == 404
    assert "error" in r.json()


def test_wrong_password_rejected():
    client = _client()
    r = client.get("/redfish/v1/Systems/T1", auth=("root", "wrong"))
    assert r.status_code == 401


def test_missing_auth_rejected():
    client = _client()
    r = client.get("/redfish/v1/Systems/T1")
    assert r.status_code == 401


def test_reset_force_off_then_on():
    client = _client()
    r = client.post(
        "/redfish/v1/Systems/T1/Actions/ComputerSystem.Reset",
        json={"ResetType": "ForceOff"},
        auth=AUTH,
    )
    assert r.status_code == 200
    assert client.get("/redfish/v1/Systems/T1", auth=AUTH).json()["PowerState"] == "Off"
    r = client.post(
        "/redfish/v1/Systems/T1/Actions/ComputerSystem.Reset",
        json={"ResetType": "On"},
        auth=AUTH,
    )
    assert r.status_code == 200
    assert client.get("/redfish/v1/Systems/T1", auth=AUTH).json()["PowerState"] == "On"


def test_reset_bogus_type_returns_400():
    client = _client()
    r = client.post(
        "/redfish/v1/Systems/T1/Actions/ComputerSystem.Reset",
        json={"ResetType": "Bogus"},
        auth=AUTH,
    )
    assert r.status_code == 400


def test_reset_missing_reset_type_returns_400():
    client = _client()
    r = client.post(
        "/redfish/v1/Systems/T1/Actions/ComputerSystem.Reset",
        json={},
        auth=AUTH,
    )
    assert r.status_code == 400


def test_thermal_payload_two_temps_one_fan():
    client = _client()
    r = client.get("/redfish/v1/Chassis/T1/Thermal", auth=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert len(body["Temperatures"]) == 2
    assert {t["Name"] for t in body["Temperatures"]} == {"Inlet", "CPU"}
    assert len(body["Fans"]) == 1


def test_power_payload_watts_and_two_ok_psus():
    client = _client()
    r = client.get("/redfish/v1/Chassis/T1/Power", auth=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["PowerControl"][0]["PowerConsumedWatts"] > 0
    assert len(body["PowerSupplies"]) == 2
    assert all(p["Status"]["Health"] == "OK" for p in body["PowerSupplies"])


def test_chaos_psu_fail_shows_critical_psu():
    client = _client()
    r = client.post("/chaos/psu-fail", json={"system": "T1", "psu": 1})
    assert r.status_code == 200
    power = client.get("/redfish/v1/Chassis/T1/Power", auth=AUTH).json()
    psu1 = next(p for p in power["PowerSupplies"] if p["Name"] == "PSU1")
    assert psu1["Status"]["Health"] == "Critical"


def test_sel_empty_initially():
    client = _client()
    r = client.get("/redfish/v1/Systems/T1/LogServices/SEL/Entries", auth=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["Members@odata.count"] == 0
    assert body["Members"] == []


def test_sel_add_then_one_entry_with_fields():
    client = _client()
    r = client.post(
        "/chaos/sel",
        json={"system": "T1", "severity": "Warning", "message": "hello"},
    )
    assert r.status_code == 200
    body = client.get("/redfish/v1/Systems/T1/LogServices/SEL/Entries", auth=AUTH).json()
    assert body["Members@odata.count"] == 1
    entry = body["Members"][0]
    assert entry["Severity"] == "Warning"
    assert entry["Message"] == "hello"
    assert entry["Oem"]["DCSentinel"]["Code"]


def test_sel_entry_by_id_paths():
    client = _client()
    client.post("/chaos/sel", json={"system": "T1", "severity": "OK", "message": "x"})
    base = "/redfish/v1/Systems/T1/LogServices/SEL/Entries"
    assert client.get(f"{base}/1", auth=AUTH).status_code == 200
    assert client.get(f"{base}/99", auth=AUTH).status_code == 404
    assert client.get(f"{base}/abc", auth=AUTH).status_code == 404


def test_hang_t2_shows_hung_and_warning_health():
    client = _client()
    r = client.post("/chaos/hang", json={"system": "T2"})
    assert r.status_code == 200
    body = client.get("/redfish/v1/Systems/T2", auth=AUTH).json()
    assert body["Oem"]["DCSentinel"]["Hung"] is True
    assert body["Status"]["Health"] == "Warning"
