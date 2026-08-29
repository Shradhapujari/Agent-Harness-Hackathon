"""Kubernetes tools against the in-memory cluster (FAKE_K8S=1).

The fake returns the same client model objects the real API does, so what these
tests exercise is the projection and the drain policy, not the fake.
"""
from __future__ import annotations

from collections.abc import Iterator

import pytest

from hush_mcp import common, kubernetes


@pytest.fixture(autouse=True)
def fake_cluster(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("FAKE_K8S", "1")
    monkeypatch.setattr(kubernetes, "_api", None)
    common._IDEMPOTENT.clear()
    yield
    kubernetes._api = None


def test_nodes_carry_the_bmc_label_that_joins_the_two_worlds() -> None:
    nodes = kubernetes.list_nodes()["nodes"]
    assert [n["name"] for n in nodes] == ["hush-control-plane", "hush-worker", "hush-worker2"]
    assert {n["bmc_id"] for n in nodes} == {"R4-N01", "R4-N04", "R4-N07"}
    assert all(n["ready"] and not n["unschedulable"] for n in nodes)


def test_get_node_reports_conditions_and_labels() -> None:
    node = kubernetes.get_node("hush-worker")
    assert node["bmc_id"] == "R4-N04"
    assert node["labels"]["hush.io/rack"] == "R4"
    assert node["conditions"][0] == {
        "type": "Ready",
        "status": "True",
        "reason": "KubeletReady",
        "message": None,
    }


def test_an_unknown_node_is_an_error_not_a_crash() -> None:
    assert kubernetes.get_node("hush-worker9")["error"]["code"] == "ApiException"


def test_list_pods_defaults_to_the_demo_namespace() -> None:
    pods = kubernetes.list_pods()["pods"]
    assert len(pods) == 9
    assert all(p["phase"] == "Running" for p in pods)


def test_list_pods_can_be_narrowed_to_one_node() -> None:
    pods = kubernetes.list_pods(node="hush-worker")["pods"]
    assert {p["node"] for p in pods} == {"hush-worker"}
    assert len(pods) == 3


def test_system_pods_are_not_reported_as_workload() -> None:
    """kube-proxy lives on every node and is nobody's workload."""
    assert all("kube-proxy" not in p["name"] for p in kubernetes.list_pods()["pods"])


def test_cordon_stops_scheduling_without_moving_anything() -> None:
    assert kubernetes.cordon_node(name="hush-worker", idempotency_key="c1")["ok"] is True
    node = next(n for n in kubernetes.list_nodes()["nodes"] if n["name"] == "hush-worker")
    assert node["unschedulable"] is True
    assert len(kubernetes.list_pods(node="hush-worker")["pods"]) == 3


def test_uncordon_puts_the_node_back_in_service() -> None:
    kubernetes.cordon_node(name="hush-worker", idempotency_key="c1")
    kubernetes.uncordon_node(name="hush-worker", idempotency_key="u1")
    node = next(n for n in kubernetes.list_nodes()["nodes"] if n["name"] == "hush-worker")
    assert node["unschedulable"] is False


def test_drain_moves_the_workload_off_the_node() -> None:
    result = kubernetes.drain_node(name="hush-worker", idempotency_key="d1")
    assert result["evicted"] == ["demo/web-1", "demo/api-1", "demo/worker-1"]
    assert kubernetes.list_pods(node="hush-worker")["pods"] == []
    assert len(kubernetes.list_pods()["pods"]) == 9  # rescheduled, not deleted


def test_drain_leaves_daemonset_and_system_pods_alone() -> None:
    result = kubernetes.drain_node(name="hush-worker", idempotency_key="d1")
    assert all("kube-system" not in evicted for evicted in result["evicted"])


def test_drain_cordons_first_so_pods_do_not_come_back() -> None:
    kubernetes.drain_node(name="hush-worker", idempotency_key="d1")
    node = next(n for n in kubernetes.list_nodes()["nodes"] if n["name"] == "hush-worker")
    assert node["unschedulable"] is True


def test_repeating_a_drain_key_replays_instead_of_evicting_again() -> None:
    first = kubernetes.drain_node(name="hush-worker", idempotency_key="d1")
    second = kubernetes.drain_node(name="hush-worker", idempotency_key="d1")
    assert second["replayed"] is True
    assert second["evicted"] == first["evicted"]
