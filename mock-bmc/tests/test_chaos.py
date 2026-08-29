"""Chaos injector API tests via TestClient."""
from fastapi.testclient import TestClient

from app.main import create_app


def _client() -> TestClient:
    app = create_app(node_ids=["T1", "T2"], tick_interval_s=3600)
    return TestClient(app)


def test_status_shape():
    client = _client()
    r = client.get("/chaos/status")
    assert r.status_code == 200
    body = r.json()
    assert "ambient_c" in body
    assert "ambient_offset_c" in body
    assert len(body["nodes"]) == 2


def test_thermal_spike_roundtrip_sets_offset():
    client = _client()
    r = client.post(
        "/chaos/thermal-spike",
        json={"system": "T1", "delta_c": 25, "duration_s": 120},
    )
    assert r.status_code == 200
    fleet = client.app.state.fleet
    assert fleet.machines["T1"].thermal_offset_c == 25.0


def test_thermal_spike_unknown_system_404():
    client = _client()
    r = client.post(
        "/chaos/thermal-spike",
        json={"system": "NOPE", "delta_c": 25, "duration_s": 120},
    )
    assert r.status_code == 404


def test_psu_fail_invalid_psu_numbers_400():
    client = _client()
    r_hi = client.post("/chaos/psu-fail", json={"system": "T1", "psu": 3})
    r_lo = client.post("/chaos/psu-fail", json={"system": "T1", "psu": 0})
    assert r_hi.status_code == 400
    assert r_lo.status_code == 400


def test_hang_unhang_roundtrip_via_status():
    client = _client()
    assert client.post("/chaos/hang", json={"system": "T1"}).status_code == 200
    nodes = {n["system_id"]: n for n in client.get("/chaos/status").json()["nodes"]}
    assert nodes["T1"]["hung"] is True
    assert client.post("/chaos/unhang", json={"system": "T1"}).status_code == 200
    nodes = {n["system_id"]: n for n in client.get("/chaos/status").json()["nodes"]}
    assert nodes["T1"]["hung"] is False


def test_crac_failure_and_restore_roundtrip():
    client = _client()
    r = client.post("/chaos/crac-failure", json={"delta_c": 10})
    assert r.status_code == 200
    assert client.get("/chaos/status").json()["ambient_offset_c"] == 10.0
    r = client.post("/chaos/crac-restore")
    assert r.status_code == 200
    assert client.get("/chaos/status").json()["ambient_offset_c"] == 0.0


def test_sel_add_severity_validation():
    client = _client()
    r_bad = client.post(
        "/chaos/sel",
        json={"system": "T1", "severity": "Bogus", "message": "x"},
    )
    assert r_bad.status_code == 400
    r_ok = client.post(
        "/chaos/sel",
        json={"system": "T1", "severity": "Warning", "message": "x"},
    )
    assert r_ok.status_code == 200


def test_clear_after_chaos_leaves_sel_history():
    client = _client()
    client.post("/chaos/thermal-spike", json={"system": "T1", "delta_c": 20, "duration_s": 500})
    client.post("/chaos/psu-fail", json={"system": "T1", "psu": 1})
    client.post("/chaos/hang", json={"system": "T1"})
    fleet = client.app.state.fleet
    sel_before = len(fleet.machines["T1"].sel)
    assert sel_before > 0
    r = client.post("/chaos/clear")
    assert r.status_code == 200
    status = client.get("/chaos/status").json()
    assert status["ambient_offset_c"] == 0.0
    node = next(n for n in status["nodes"] if n["system_id"] == "T1")
    assert node["psu1_ok"] is True
    assert node["psu2_ok"] is True
    assert node["hung"] is False
    assert node["thermal_trip"] is False
    assert len(fleet.machines["T1"].sel) == sel_before
