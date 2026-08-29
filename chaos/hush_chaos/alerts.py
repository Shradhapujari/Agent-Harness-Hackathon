"""Synthetic Kubernetes and application alerts for a scenario.

The hardware layer fires by itself: the BMC simulation moves real temperatures
and Prometheus rules turn them into alerts. What Prometheus cannot produce here
is the noise a real incident drags behind it — a rack of nodes going NotReady,
pods crash-looping, three tenants' error rates climbing at once. Those are
posted straight to Alertmanager, which is what makes the storm big enough to be
worth triaging (mission.md §3).

Every alert carries `origin=hush-chaos` so `hush-chaos clear` can find exactly
what it created and expire it, and nothing else.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

ORIGIN = "hush-chaos"
#: Alertmanager validates generatorURL as a URI, so the marker has to look like
#: one. Nothing serves it; it exists to say where these alerts came from.
GENERATOR_URL = "http://hush-chaos.local/"
#: Long enough to outlive a demo run, short enough that a forgotten alert dies.
TTL_MINUTES = 15
APPS = ("web", "api", "worker")
TENANTS = ("acme", "globex", "initech")


def alert(
    name: str, severity: str, layer: str, when: datetime | None = None, **labels: str
) -> dict[str, Any]:
    """One Alertmanager v2 alert. `rack` defaults to R4, the rack in the demo."""
    now = when or datetime.now(UTC)
    return {
        "labels": {
            "alertname": name,
            "severity": severity,
            "layer": layer,
            "rack": "R4",
            "origin": ORIGIN,
            **labels,
        },
        "annotations": {"summary": f"{name} on {labels.get('node', labels.get('tenant', 'R4'))}"},
        "startsAt": now.isoformat(),
        "endsAt": (now + timedelta(minutes=TTL_MINUTES)).isoformat(),
        "generatorURL": GENERATOR_URL,
    }


def crac_cascade(k8s_nodes: dict[str, str], when: datetime | None = None) -> list[dict[str, Any]]:
    """Scenario A symptoms: the whole rack overheats, so the whole rack falls over.

    `k8s_nodes` maps a Kubernetes node name to the BMC id of the machine it runs
    on — the join the agent has to make to connect a NotReady node to a hot box.
    """
    out: list[dict[str, Any]] = []
    for node, bmc in k8s_nodes.items():
        out.append(alert("KubeNodeNotReady", "critical", "kubernetes", when, node=bmc, k8s_node=node))
        out.append(alert("KubeNodeUnreachable", "warning", "kubernetes", when, node=bmc, k8s_node=node))
        out.append(
            alert("KubePodPending", "warning", "kubernetes", when, node=bmc, k8s_node=node, namespace="demo")
        )
        for app in APPS:
            out.append(
                alert(
                    "KubePodCrashLooping", "warning", "kubernetes", when,
                    node=bmc, k8s_node=node, namespace="demo", pod=f"{app}-{node}",
                )
            )
    for tenant in TENANTS:
        out.append(alert("AppErrorRateHigh", "critical", "app", when, tenant=tenant))
        out.append(alert("AppLatencyP99High", "warning", "app", when, tenant=tenant))
        out.append(alert("AppQueueBacklogHigh", "warning", "app", when, tenant=tenant))
    # Unrelated, and in another rack: the agent should classify this as noise
    # rather than fold it into the incident.
    out.append(alert("FlappingSwitchPort", "info", "network", when, node="R2-SW01", rack="R2"))
    return out


def hang_symptoms(k8s_node: str, system: str, when: datetime | None = None) -> list[dict[str, Any]]:
    """Scenario B symptoms: one machine is wedged, so one node's workload suffers.

    Deliberately smaller than the CRAC cascade — the point of this scenario is
    that a single hung host looks nothing like a facility failure.
    """
    out = [
        alert("KubeNodeNotReady", "critical", "kubernetes", when, node=system, k8s_node=k8s_node),
        alert("KubeNodeUnreachable", "warning", "kubernetes", when, node=system, k8s_node=k8s_node),
        alert(
            "KubePodPending", "warning", "kubernetes", when,
            node=system, k8s_node=k8s_node, namespace="demo",
        ),
    ]
    for app in APPS:
        out.append(
            alert(
                "KubePodCrashLooping", "warning", "kubernetes", when,
                node=system, k8s_node=k8s_node, namespace="demo", pod=f"{app}-{k8s_node}",
            )
        )
    for tenant in TENANTS[:2]:
        out.append(alert("AppErrorRateHigh", "critical", "app", when, tenant=tenant))
    return out


#: The fields Alertmanager accepts on a POSTed alert. Anything the GET response
#: adds — `fingerprint`, `status`, `receivers`, `updatedAt` — has to be dropped
#: before an alert read off the bus can be posted back to it.
POSTABLE = ("labels", "annotations", "startsAt", "generatorURL")


def expired(alerts: list[dict[str, Any]], when: datetime | None = None) -> list[dict[str, Any]]:
    """The same alerts with `endsAt` now: re-posting these resolves them."""
    now = (when or datetime.now(UTC)).isoformat()
    return [
        {**{key: a[key] for key in POSTABLE if key in a}, "endsAt": now}
        for a in alerts
    ]
