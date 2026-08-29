"""Kubernetes MCP server (port 9103): the workload half of a node.

Only the four reversible verbs exist here — cordon, drain, uncordon and the
reads that justify them (AGENTS.md, decision D4). Anything that would destroy a
workload is out of scope; anything that would power a machine down goes through
the Redfish approval gate instead.

`hush.io/bmc` is the join between the two worlds: Kubernetes says a node is
NotReady, Redfish says whether that machine is hung, cooking, or simply off.
"""
from __future__ import annotations

from typing import Any, Protocol

from kubernetes import client, config
from kubernetes.client.rest import ApiException

from hush_mcp.common import env, guarded, idempotent, make_server

PORT = 9103
mcp = make_server("kubernetes")

#: Pods the agent must not evict: the node's own infrastructure comes back with
#: the node, and a DaemonSet pod has nowhere else to go.
PROTECTED_NAMESPACES = ("kube-system", "local-path-storage")
#: The Eviction API answers 429 when a PodDisruptionBudget refuses the eviction.
#: Every other status is a real failure and must not be reported as a drain.
PDB_BLOCKED = 429


class CoreV1(Protocol):
    """The slice of CoreV1Api these tools use (real client or FakeCoreV1Api)."""

    def list_node(self) -> client.V1NodeList: ...
    def read_node(self, name: str) -> client.V1Node: ...
    def patch_node(self, name: str, body: dict[str, Any]) -> client.V1Node: ...
    def list_pod_for_all_namespaces(self, field_selector: str = ...) -> client.V1PodList: ...
    def create_namespaced_pod_eviction(self, name: str, namespace: str, body: object) -> object: ...


_api: CoreV1 | None = None


def api() -> CoreV1:
    """The cluster connection, built on first use.

    Lazily, because importing this module must not require a kubeconfig: CI and
    Person B run with FAKE_K8S=1 and no cluster at all.
    """
    global _api
    if _api is None:
        if env("FAKE_K8S", "") == "1":
            from hush_mcp.k8s_fake import FakeCoreV1Api

            _api = FakeCoreV1Api()
        else:
            config.load_kube_config(context=env("HUSH_KUBE_CONTEXT", "kind-hush"))
            _api = client.CoreV1Api()
    return _api


def _ready(node: client.V1Node) -> bool:
    conditions = (node.status.conditions or []) if node.status else []
    return next((c.status == "True" for c in conditions if c.type == "Ready"), False)


def _bmc(node: client.V1Node) -> str | None:
    labels: dict[str, str] = (node.metadata.labels or {}) if node.metadata else {}
    return labels.get("hush.io/bmc")


def _node_summary(node: client.V1Node) -> dict[str, Any]:
    return {
        "name": node.metadata.name,
        "ready": _ready(node),
        "unschedulable": bool(node.spec.unschedulable) if node.spec else False,
        "bmc_id": _bmc(node),
    }


def _restarts(pod: client.V1Pod) -> int:
    statuses = (pod.status.container_statuses or []) if pod.status else []
    return sum(s.restart_count or 0 for s in statuses)


def _evictable(pod: client.V1Pod) -> bool:
    owners = {o.kind for o in (pod.metadata.owner_references or [])}
    return "DaemonSet" not in owners and pod.metadata.namespace not in PROTECTED_NAMESPACES


@mcp.tool()
@guarded
def list_nodes(run_id: str = "") -> dict[str, Any]:
    """List cluster nodes with Ready state, schedulability and their BMC id."""
    return {"nodes": [_node_summary(n) for n in api().list_node().items]}


@mcp.tool()
@guarded
def get_node(name: str, run_id: str = "") -> dict[str, Any]:
    """One node: conditions, labels, schedulability and the machine it runs on."""
    node = api().read_node(name)
    conditions = (node.status.conditions or []) if node.status else []
    return {
        **_node_summary(node),
        "labels": node.metadata.labels or {},
        "conditions": [
            {"type": c.type, "status": c.status, "reason": c.reason, "message": c.message}
            for c in conditions
        ],
    }


@mcp.tool()
@guarded
def list_pods(node: str | None = None, namespace: str = "demo", run_id: str = "") -> dict[str, Any]:
    """List pods in `namespace`, optionally only those on `node`."""
    selector = f"spec.nodeName={node}" if node else ""
    pods = api().list_pod_for_all_namespaces(field_selector=selector).items
    return {
        "pods": [
            {
                "name": p.metadata.name,
                "node": p.spec.node_name if p.spec else None,
                "phase": p.status.phase if p.status else None,
                "restarts": _restarts(p),
            }
            for p in pods
            if p.metadata.namespace == namespace
        ]
    }


@mcp.tool()
@idempotent
def cordon_node(name: str, idempotency_key: str, run_id: str = "") -> dict[str, Any]:
    """Mark a node unschedulable. Reversible, and moves nothing on its own."""
    api().patch_node(name, {"spec": {"unschedulable": True}})
    return {"ok": True, "node": name, "unschedulable": True}


@mcp.tool()
@idempotent
def uncordon_node(name: str, idempotency_key: str, run_id: str = "") -> dict[str, Any]:
    """Make a node schedulable again, after it has recovered."""
    api().patch_node(name, {"spec": {"unschedulable": False}})
    return {"ok": True, "node": name, "unschedulable": False}


@mcp.tool()
@idempotent
def drain_node(name: str, idempotency_key: str, grace_s: int = 30, run_id: str = "") -> dict[str, Any]:
    """Cordon a node, then evict its pods so the workload moves before the machine does.

    DaemonSet and system pods are left alone, and a pod held back by a
    PodDisruptionBudget is reported rather than raised: a partial drain is still
    useful evidence, and the agent decides what to do about the remainder. Any
    other API failure — auth, a dead API server — is a failed drain and is
    raised, because reporting it as a partial success would let the agent
    power off a machine it never actually emptied.
    """
    api().patch_node(name, {"spec": {"unschedulable": True}})
    evicted: list[str] = []
    blocked: list[str] = []
    for pod in api().list_pod_for_all_namespaces(field_selector=f"spec.nodeName={name}").items:
        if not _evictable(pod):
            continue
        target = f"{pod.metadata.namespace}/{pod.metadata.name}"
        body = client.V1Eviction(
            metadata=client.V1ObjectMeta(name=pod.metadata.name, namespace=pod.metadata.namespace),
            delete_options=client.V1DeleteOptions(grace_period_seconds=grace_s),
        )
        try:
            api().create_namespaced_pod_eviction(pod.metadata.name, pod.metadata.namespace, body)
            evicted.append(target)
        except ApiException as exc:
            if exc.status != PDB_BLOCKED:
                raise
            blocked.append(f"{target} (blocked: {exc.status})")
    return {"ok": True, "node": name, "evicted": evicted, "blocked": blocked}
