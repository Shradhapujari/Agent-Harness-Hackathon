"""The kind cluster is where k8s and the BMC fleet have to line up.

`make kind-up` proves this for real, but it needs Docker and a few minutes. What
these tests protect is the join: every node claims a BMC by label, and the agent
uses that label to ask Redfish about the machine behind a NotReady node. Rename a
fleet node and the mapping breaks silently — nothing else in the repo notices.
"""
from pathlib import Path

import pytest
import yaml

from app.main import create_app

KIND = Path(__file__).resolve().parents[1] / "kind"
CLUSTER = KIND / "cluster.yaml"
WORKLOADS = KIND / "workloads.yaml"

APPS = {"web", "api", "worker"}


@pytest.fixture(scope="module")
def cluster() -> dict:
    return yaml.safe_load(CLUSTER.read_text())


@pytest.fixture(scope="module")
def workloads() -> list[dict]:
    return list(yaml.safe_load_all(WORKLOADS.read_text()))


def _by_kind(docs: list[dict], kind: str) -> dict[str, dict]:
    return {d["metadata"]["name"]: d for d in docs if d["kind"] == kind}


def test_cluster_is_three_nodes_named_hush(cluster):
    assert cluster["name"] == "hush"
    roles = [n["role"] for n in cluster["nodes"]]
    assert roles == ["control-plane", "worker", "worker"]


def test_every_node_claims_a_bmc_that_exists_in_the_fleet(cluster):
    """The agent joins k8s to Redfish on this label; a typo breaks the whole demo."""
    fleet = create_app(tick_interval_s=3600).state.fleet
    claimed = [n["labels"]["hush.io/bmc"] for n in cluster["nodes"]]

    assert len(set(claimed)) == 3, "two k8s nodes cannot share one BMC"
    for bmc in claimed:
        assert bmc in fleet.machines, f"{bmc} is not a node in the mock fleet"
    for n in cluster["nodes"]:
        assert n["labels"]["hush.io/rack"] == "R4"


def test_workloads_land_in_the_demo_namespace(workloads):
    namespaces = _by_kind(workloads, "Namespace")
    assert set(namespaces) == {"demo"}
    for doc in workloads:
        if doc["kind"] != "Namespace":
            assert doc["metadata"]["namespace"] == "demo", doc["metadata"]["name"]


def test_three_deployments_of_three_replicas(workloads):
    deploys = _by_kind(workloads, "Deployment")
    assert set(deploys) == APPS
    for name, d in deploys.items():
        assert d["spec"]["replicas"] == 3, name
        containers = d["spec"]["template"]["spec"]["containers"]
        assert len(containers) == 1
        assert containers[0]["image"] == "nginx:alpine", name
        assert containers[0]["resources"]["requests"]["cpu"] == "10m", name


def test_pods_spread_across_hosts_and_tolerate_the_control_plane(workloads):
    """3 replicas over 3 nodes, one each — so every BMC is worth power-cycling."""
    for name, d in _by_kind(workloads, "Deployment").items():
        spec = d["spec"]["template"]["spec"]

        constraint = spec["topologySpreadConstraints"][0]
        assert constraint["topologyKey"] == "kubernetes.io/hostname", name
        assert constraint["maxSkew"] == 1, name
        assert constraint["whenUnsatisfiable"] == "DoNotSchedule", name
        assert constraint["labelSelector"]["matchLabels"] == {"app": name}, name

        # kind taints the control-plane NoSchedule; without this toleration only
        # the two workers hold pods and R4-N01 is unreachable to the demo.
        keys = [t["key"] for t in spec["tolerations"]]
        assert "node-role.kubernetes.io/control-plane" in keys, name


def test_every_app_has_a_budget_that_lets_a_drain_finish(workloads):
    budgets = _by_kind(workloads, "PodDisruptionBudget")
    assert set(budgets) == APPS
    for name, pdb in budgets.items():
        # minAvailable must stay below the replica count, or drain blocks forever.
        assert pdb["spec"]["minAvailable"] == 1, name
        assert pdb["spec"]["selector"]["matchLabels"] == {"app": name}, name
