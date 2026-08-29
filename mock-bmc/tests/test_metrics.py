"""Prometheus exposition tests via TestClient (ticker frozen with tick_interval_s=3600)."""
from fastapi.testclient import TestClient

from app.main import create_app


def _client(*node_ids: str) -> TestClient:
    """Small two-node fleet unless the test names its own nodes."""
    app = create_app(node_ids=list(node_ids) or ["T1", "T2"], tick_interval_s=3600)
    return TestClient(app)


def _default_fleet_client() -> TestClient:
    """The real rack-R4 fleet create_app() ships with."""
    return TestClient(create_app(tick_interval_s=3600))


def _lines(body: str, metric: str) -> list[str]:
    return [ln for ln in body.splitlines() if ln.startswith(metric + "{")]


def test_metrics_needs_no_auth():
    r = _client().get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")


def test_default_fleet_exposes_one_series_per_node():
    """Default fleet is the 12 nodes of rack R4; Prometheus must see all of them."""
    body = _default_fleet_client().get("/metrics").text
    for metric in (
        "hush_cpu_temp_celsius",
        "hush_inlet_temp_celsius",
        "hush_fan_percent",
        "hush_power_watts",
    ):
        assert len(_lines(body, metric)) == 12, metric


def test_every_gauge_is_declared_and_labelled():
    body = _client().get("/metrics").text
    for metric in (
        "hush_inlet_temp_celsius",
        "hush_cpu_temp_celsius",
        "hush_fan_percent",
        "hush_power_watts",
        "hush_power_on",
        "hush_host_hung",
        "hush_thermal_trip",
        "hush_psu_ok",
    ):
        assert f"# TYPE {metric} gauge" in body, metric
        assert len(_lines(body, metric)) >= 2, metric
    assert 'hush_cpu_temp_celsius{system="T1"}' in body


def test_psu_gauge_has_one_series_per_psu():
    body = _client().get("/metrics").text
    assert len(_lines(body, "hush_psu_ok")) == 4  # 2 nodes x 2 PSUs
    assert 'hush_psu_ok{system="T1",psu="1"} 1' in body
    assert 'hush_psu_ok{system="T1",psu="2"} 1' in body


def test_ambient_is_a_single_unlabelled_series():
    client = _client()
    body = client.get("/metrics").text
    ambient = [ln for ln in body.splitlines() if ln.startswith("hush_ambient_celsius ")]
    assert len(ambient) == 1
    assert float(ambient[0].split()[1]) == client.app.state.fleet.ambient_c


def test_crac_failure_raises_ambient_series():
    """FacilityAmbientHigh fires off this series, so chaos must move it."""
    client = _client()
    before = float(client.get("/metrics").text.splitlines()[-1].split()[1])
    client.post("/chaos/crac-failure", json={"delta_c": 14})
    after = float(client.get("/metrics").text.splitlines()[-1].split()[1])
    assert after == before + 14.0


def test_boolean_gauges_track_state():
    client = _client()
    client.post("/chaos/hang", json={"system": "T1"})
    client.post("/chaos/psu-fail", json={"system": "T2", "psu": 1})
    body = client.get("/metrics").text
    assert 'hush_host_hung{system="T1"} 1' in body
    assert 'hush_host_hung{system="T2"} 0' in body
    assert 'hush_psu_ok{system="T2",psu="1"} 0' in body
    assert 'hush_psu_ok{system="T2",psu="2"} 1' in body
    assert 'hush_power_on{system="T1"} 1' in body


def test_values_are_fixed_point_not_scientific():
    """Prometheus parses floats fine, but readable output keeps the demo legible."""
    body = _client().get("/metrics").text
    for ln in _lines(body, "hush_cpu_temp_celsius"):
        value = ln.split()[1]
        assert "e" not in value.lower()
        assert value.count(".") == 1


def test_label_values_are_escaped():
    """One unescaped quote in a node id breaks the whole scrape, not just its series."""
    body = _client('bad"id').get("/metrics").text
    assert 'hush_cpu_temp_celsius{system="bad\\"id"} ' in body
    assert 'hush_cpu_temp_celsius{system="bad"id"}' not in body


def test_backslash_and_newline_in_node_id_are_escaped():
    body = _client("back\\slash", "two\nlines").get("/metrics").text
    assert 'system="back\\\\slash"' in body
    assert 'system="two\\nlines"' in body
    # The newline must not survive as a real line break, or the exposition splits.
    assert len([ln for ln in body.splitlines() if ln.startswith("hush_cpu_temp_celsius{")]) == 2


def test_ordinary_node_ids_are_untouched():
    body = _default_fleet_client().get("/metrics").text
    assert 'hush_cpu_temp_celsius{system="R4-N01"}' in body
    assert "\\" not in body


def test_power_off_clears_hung_so_host_hung_cannot_fire_on_a_dead_box():
    client = _client()
    client.post("/chaos/hang", json={"system": "T1"})
    assert 'hush_host_hung{system="T1"} 1' in client.get("/metrics").text

    client.post("/chaos/psu-fail", json={"system": "T1", "psu": 1})
    client.post("/chaos/psu-fail", json={"system": "T1", "psu": 2})
    client.app.state.fleet.tick(1.0)

    body = client.get("/metrics").text
    assert 'hush_power_on{system="T1"} 0' in body
    assert 'hush_host_hung{system="T1"} 0' in body
