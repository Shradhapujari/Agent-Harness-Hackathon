"""In-memory stand-in for CoreV1Api, used when FAKE_K8S=1.

Person B and CI need the kubernetes tools to answer without a cluster. The fake
returns the same client model objects the real API returns, so the projections
in `kubernetes.py` are the code under test either way — only the source of the
objects changes.
"""
from __future__ import annotations

from typing import Any

from kubernetes import client
from kubernetes.client.rest import ApiException

#: The kind cluster from infra/kind/cluster.yaml: three nodes, each pinned to a BMC.
NODES = (("hush-control-plane", "R4-N01"), ("hush-worker", "R4-N04"), ("hush-worker2", "R4-N07"))
APPS = ("web", "api", "worker")


def _node(name: str, bmc: str) -> client.V1Node:
    return client.V1Node(
        metadata=client.V1ObjectMeta(
            name=name,
            labels={"hush.io/bmc": bmc, "hush.io/rack": "R4", "kubernetes.io/hostname": name},
        ),
        spec=client.V1NodeSpec(unschedulable=False),
        status=client.V1NodeStatus(
            conditions=[client.V1NodeCondition(type="Ready", status="True", reason="KubeletReady")]
        ),
    )


def _daemon_pod(node: str) -> client.V1Pod:
    """A DaemonSet pod: it belongs to the node, so a drain must leave it alone."""
    return client.V1Pod(
        metadata=client.V1ObjectMeta(
            name=f"kube-proxy-{node}",
            namespace="kube-system",
            owner_references=[
                client.V1OwnerReference(
                    api_version="apps/v1", kind="DaemonSet", name="kube-proxy", uid="uid-kp"
                )
            ],
        ),
        spec=client.V1PodSpec(node_name=node, containers=[]),
        status=client.V1PodStatus(phase="Running", container_statuses=[]),
    )


def _pod(app: str, index: int, node: str) -> client.V1Pod:
    return client.V1Pod(
        metadata=client.V1ObjectMeta(
            name=f"{app}-{index}",
            namespace="demo",
            owner_references=[
                client.V1OwnerReference(api_version="apps/v1", kind="ReplicaSet", name=app, uid=f"uid-{app}")
            ],
        ),
        spec=client.V1PodSpec(node_name=node, containers=[]),
        status=client.V1PodStatus(
            phase="Running",
            container_statuses=[client.V1ContainerStatus(
                name=app, image=app, image_id="", ready=True, restart_count=0, state=None
            )],
        ),
    )


class FakeCoreV1Api:
    """The slice of CoreV1Api the kubernetes tools use, backed by dictionaries."""

    def __init__(self) -> None:
        self.nodes = {name: _node(name, bmc) for name, bmc in NODES}
        self.pods = [_pod(app, i, name) for i, (name, _) in enumerate(NODES) for app in APPS]
        self.pods += [_daemon_pod(name) for name, _ in NODES]

    def list_node(self) -> client.V1NodeList:
        return client.V1NodeList(items=list(self.nodes.values()))

    def read_node(self, name: str) -> client.V1Node:
        if name not in self.nodes:
            raise ApiException(status=404, reason=f"node {name} not found")
        return self.nodes[name]

    def patch_node(self, name: str, body: dict[str, Any]) -> client.V1Node:
        node = self.read_node(name)
        node.spec.unschedulable = bool(body["spec"]["unschedulable"])
        return node

    def list_pod_for_all_namespaces(self, field_selector: str = "") -> client.V1PodList:
        wanted = field_selector.removeprefix("spec.nodeName=") if field_selector else ""
        items = [p for p in self.pods if not wanted or p.spec.node_name == wanted]
        return client.V1PodList(items=items)

    def list_namespaced_pod(self, namespace: str, field_selector: str = "") -> client.V1PodList:
        pods = self.list_pod_for_all_namespaces(field_selector=field_selector).items
        return client.V1PodList(items=[p for p in pods if p.metadata.namespace == namespace])

    def create_namespaced_pod_eviction(self, name: str, namespace: str, body: object) -> object:
        """Evict a pod the way a deployment would: it comes back on a schedulable node."""
        pod = next(p for p in self.pods if p.metadata.name == name and p.metadata.namespace == namespace)
        elsewhere = [n for n, node in self.nodes.items() if not node.spec.unschedulable]
        if elsewhere:
            pod.spec.node_name = elsewhere[0]
            pod.status.phase = "Running"
        else:
            pod.spec.node_name = None
            pod.status.phase = "Pending"
        return body
