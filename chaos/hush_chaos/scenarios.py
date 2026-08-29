"""The two demo scenarios, and the reset that puts the lab back.

Both scenarios drive real state — facility ambient, CPU temperature, a frozen
kind node — and then add the symptom alerts that a real incident would carry
with it. Ordering matters: the hardware alerts have to land first, because the
correlator's leading alert is the earliest one in the lowest layer, and that is
the whole story the agent has to reconstruct.
"""
from __future__ import annotations

import time
from typing import Any

from hush_chaos import alerts, cluster
from hush_chaos.clients import AmClient, BmcClient

#: Ambient rise that puts every inlet over the 30 C rule threshold (nominal 22 C).
CRAC_DELTA_C = 14.0
#: Extra CPU heat on the two machines that should trip: 35 C is enough to cross
#: the 97 C trip point once the rack is already hot, and not enough before it.
SPIKE_DELTA_C = 35.0
SPIKE_DURATION_S = 600.0
#: Machines pushed past the trip point. Both back kind nodes, so the k8s layer
#: reacts too.
SPIKE_SYSTEMS = ("R4-N04", "R4-N07")
#: The rack's thermal time constant is 8 s; twenty seconds is enough for the
#: hardware rules (`for: 10s`) to fire before the symptom alerts arrive.
HARDWARE_LEAD_S = 20.0
#: A `clear` silence only has to outlive the alerts it covers, and the next
#: scenario expires it on the way in.
SILENCE_S = (alerts.TTL_MINUTES + 1) * 60
SILENCE_AUTHOR = "hush-chaos"


def crac(
    bmc: BmcClient, am: AmClient, k8s_nodes: dict[str, str], lead_s: float = HARDWARE_LEAD_S
) -> dict[str, Any]:
    """Scenario A: the CRAC unit fails and the whole rack overheats."""
    am.expire_silences(SILENCE_AUTHOR)
    bmc.post("/chaos/crac-failure", {"delta_c": CRAC_DELTA_C})
    for system in SPIKE_SYSTEMS:
        bmc.post("/chaos/thermal-spike", {
            "system": system, "delta_c": SPIKE_DELTA_C, "duration_s": SPIKE_DURATION_S,
        })
    time.sleep(lead_s)
    cascade = alerts.crac_cascade(k8s_nodes)
    am.post_alerts(cascade)
    return {"scenario": "crac", "ambient_delta_c": CRAC_DELTA_C, "spiked": list(SPIKE_SYSTEMS),
            "synthetic_alerts": len(cascade)}


def hang(
    bmc: BmcClient, am: AmClient, k8s_node: str = "hush-worker", system: str = "R4-N04",
    lead_s: float = HARDWARE_LEAD_S,
) -> dict[str, Any]:
    """Scenario B: one host wedges. The BMC still answers; the node does not.

    The node and the machine have to be the pair the cluster actually reports,
    or the scenario would claim a NotReady node that is nothing to do with the
    machine the agent is about to be shown.

    Like `crac`, this waits for the hardware alert before posting the symptoms.
    `HostHung` needs a Prometheus scrape plus its `for: 5s`, while the symptoms
    post instantly; without the lead the operator's N0 snapshot caught the eight
    Kubernetes symptoms and no `HostHung`, and triage called the root cause
    `unknown` because nothing in the alert set named the machine's fault (I2).
    """
    nodes = cluster.node_map()
    if k8s_node not in nodes:
        raise ValueError(f"{k8s_node} is not a node in this cluster: {', '.join(sorted(nodes))}")
    if nodes[k8s_node] != system:
        raise ValueError(f"{k8s_node} runs on {nodes[k8s_node]}, not {system}")
    am.expire_silences(SILENCE_AUTHOR)
    bmc.post("/chaos/hang", {"system": system})
    if not cluster.pause(k8s_node):
        # Posting NotReady symptoms for a node that is still healthy would
        # describe an incident that is not happening.
        bmc.post("/chaos/unhang", {"system": system})
        raise RuntimeError(f"could not pause {k8s_node}; is the kind cluster up?")
    time.sleep(lead_s)
    symptoms = alerts.hang_symptoms(k8s_node, system)
    am.post_alerts(symptoms)
    return {"scenario": "hang", "system": system, "k8s_node": k8s_node, "paused": True,
            "synthetic_alerts": len(symptoms)}


def clear(bmc: BmcClient, am: AmClient, k8s_nodes: dict[str, str]) -> dict[str, Any]:
    """Put the lab back: chaos off, machines on, nodes thawed and schedulable.

    `/chaos/clear` deliberately leaves a thermal trip standing — a tripped
    machine is a real fault, not an injected one — so anything that tripped or
    powered off is switched back on through Redfish, the same way an operator
    would.
    """
    bmc.post("/chaos/clear", {})
    recovered = []
    for node in bmc.status().get("nodes", []):
        if node.get("thermal_trip") or node.get("power") != "On":
            bmc.reset(node["system_id"], "On")
            recovered.append(node["system_id"])
    failed: list[str] = []
    for k8s_node in k8s_nodes:
        # unpause fails on a node that was never paused, which is not an error;
        # a node that stays cordoned is, because the workload never comes back.
        cluster.unpause(k8s_node)
        if not cluster.uncordon(k8s_node):
            failed.append(k8s_node)
    # Re-posting a synthetic alert with `endsAt` now does resolve it, so that is
    # what happens first. Silencing alone left the alerts on the bus, and
    # `expire_silences` on the way into the next scenario brought them straight
    # back — carrying their *original* `startsAt`, because Alertmanager keeps
    # the first one it saw for a fingerprint. The correlator then anchored its
    # burst on those stale symptoms and filed the fresh hardware alert as noise,
    # so back-to-back demo runs triaged to `unknown` (I2).
    #
    # The silence stays as a backstop for anything that will not resolve.
    # Real alerts are untouched — they resolve when the physics does, which is
    # the point of the demo.
    stale = am.list_alerts([f"origin={alerts.ORIGIN}"])
    silence_id = ""
    if stale:
        am.post_alerts(alerts.expired(stale))
        silence_id = am.silence(
            [f"origin={alerts.ORIGIN}"],
            duration_s=SILENCE_S,
            comment="hush-chaos clear: scenario over",
        )
    return {"scenario": "clear", "powered_on": recovered, "resolved_alerts": len(stale),
            "silenced_alerts": len(stale), "silence_id": silence_id,
            "nodes": list(k8s_nodes), "failed_nodes": failed}


def status(bmc: BmcClient, am: AmClient) -> dict[str, Any]:
    """What the alarm bus and the fleet look like right now."""
    firing = am.list_alerts(silenced=False)
    by_layer: dict[str, int] = {}
    for a in firing:
        layer = a.get("labels", {}).get("layer", "unknown")
        by_layer[layer] = by_layer.get(layer, 0) + 1
    snapshot = bmc.status()
    machines = snapshot.get("nodes", [])
    # The BMC reports the nominal ambient and the chaos offset separately; what
    # the rack actually feels — and what FacilityAmbientHigh fires on — is both.
    ambient = float(snapshot.get("ambient_c", 0.0)) + float(snapshot.get("ambient_offset_c", 0.0))
    return {
        "firing": len(firing),
        "silenced": len(am.list_alerts()) - len(firing),
        "by_layer": dict(sorted(by_layer.items())),
        "ambient_c": round(ambient, 1),
        "hung": [m["system_id"] for m in machines if m.get("hung")],
        "powered_off": [m["system_id"] for m in machines if m.get("power") != "On"],
        "tripped": [m["system_id"] for m in machines if m.get("thermal_trip")],
    }
