"""The kind cluster, seen from outside: node ↔ BMC mapping, pause, uncordon.

A kind node is a container, so `docker pause` is the closest thing to a machine
that stops answering while its BMC stays up — which is exactly scenario B.
"""
from __future__ import annotations

import json
import subprocess

from hush_chaos.clients import env

#: infra/kind/cluster.yaml. Used when kubectl cannot answer, so a scenario can
#: still post the symptoms that belong to those nodes.
DEFAULT_NODES = {
    "hush-control-plane": "R4-N01",
    "hush-worker": "R4-N04",
    "hush-worker2": "R4-N07",
}
BMC_LABEL = "hush.io/bmc"


def context() -> str:
    return env("HUSH_KUBE_CONTEXT", "kind-hush")


def _run(argv: list[str], timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


def node_map() -> dict[str, str]:
    """Kubernetes node name → BMC id, from the `hush.io/bmc` label on each node."""
    result = _run(["kubectl", "--context", context(), "get", "nodes", "-o", "json"])
    if result.returncode != 0:
        return dict(DEFAULT_NODES)
    try:
        items = json.loads(result.stdout).get("items", [])
    except json.JSONDecodeError:
        return dict(DEFAULT_NODES)
    mapping = {
        item["metadata"]["name"]: item["metadata"].get("labels", {}).get(BMC_LABEL, "")
        for item in items
    }
    return {node: bmc for node, bmc in mapping.items() if bmc} or dict(DEFAULT_NODES)


def pause(node: str) -> bool:
    """Freeze a kind node's container: the kubelet stops reporting within ~40 s."""
    return _run(["docker", "pause", node]).returncode == 0


def unpause(node: str) -> bool:
    """Thaw a kind node. Safe to call on a node that was never paused."""
    return _run(["docker", "unpause", node]).returncode == 0


def uncordon(node: str) -> bool:
    return _run(["kubectl", "--context", context(), "uncordon", node]).returncode == 0
