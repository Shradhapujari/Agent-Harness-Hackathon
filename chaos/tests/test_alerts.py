"""Alert generation is pure: no network, no cluster, no clock surprises."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from hush_chaos import alerts

WHEN = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)
NODES = {"hush-control-plane": "R4-N01", "hush-worker": "R4-N04", "hush-worker2": "R4-N07"}


def _names(generated: list[dict]) -> list[str]:
    return [a["labels"]["alertname"] for a in generated]


def test_every_alert_is_tagged_so_clear_can_find_it() -> None:
    """`hush-chaos clear` expires what it created and nothing else."""
    generated = alerts.crac_cascade(NODES, when=WHEN)
    generated += alerts.hang_symptoms("hush-worker", "R4-N04", when=WHEN)
    assert all(a["labels"]["origin"] == alerts.ORIGIN for a in generated)
    assert all(a["generatorURL"] == alerts.GENERATOR_URL for a in generated)


def test_the_generator_url_is_a_uri_because_alertmanager_checks() -> None:
    """Alertmanager rejects the whole batch with 422 if this is a bare word."""
    assert alerts.GENERATOR_URL.startswith("http://")


def test_the_crac_cascade_covers_the_kubernetes_and_app_layers() -> None:
    layers = {a["labels"]["layer"] for a in alerts.crac_cascade(NODES, when=WHEN)}
    assert layers == {"kubernetes", "app", "network"}


def test_the_crac_cascade_hits_every_node_in_the_rack() -> None:
    generated = alerts.crac_cascade(NODES, when=WHEN)
    not_ready = [a for a in generated if a["labels"]["alertname"] == "KubeNodeNotReady"]
    assert {a["labels"]["node"] for a in not_ready} == set(NODES.values())
    assert {a["labels"]["k8s_node"] for a in not_ready} == set(NODES)


def test_the_crac_cascade_is_big_enough_to_need_triage() -> None:
    """The demo claims a storm; 40 alerts across layers is what makes it one."""
    generated = alerts.crac_cascade(NODES, when=WHEN)
    assert len(generated) >= 25  # plus 15 hardware alerts from Prometheus
    assert len([a for a in generated if a["labels"]["layer"] == "app"]) == 9


def test_the_cascade_carries_one_alert_from_another_rack_as_noise() -> None:
    generated = alerts.crac_cascade(NODES, when=WHEN)
    elsewhere = [a for a in generated if a["labels"]["rack"] != "R4"]
    assert _names(elsewhere) == ["FlappingSwitchPort"]
    assert elsewhere[0]["labels"]["severity"] == "info"


def test_a_hang_looks_nothing_like_a_facility_failure() -> None:
    """One machine wedged: one node's symptoms, not the rack's."""
    generated = alerts.hang_symptoms("hush-worker", "R4-N04", when=WHEN)
    assert {a["labels"].get("k8s_node") for a in generated if "k8s_node" in a["labels"]} == {"hush-worker"}
    assert len(generated) < len(alerts.crac_cascade(NODES, when=WHEN))


def test_alerts_carry_a_bounded_lifetime() -> None:
    alert = alerts.crac_cascade(NODES, when=WHEN)[0]
    assert alert["startsAt"] == WHEN.isoformat()
    assert alert["endsAt"] == (WHEN + timedelta(minutes=alerts.TTL_MINUTES)).isoformat()


def test_expiring_an_alert_only_moves_its_end() -> None:
    generated = alerts.crac_cascade(NODES, when=WHEN)
    ended = alerts.expired(generated, when=WHEN)
    assert [a["labels"] for a in ended] == [a["labels"] for a in generated]
    assert all(a["endsAt"] == WHEN.isoformat() for a in ended)
