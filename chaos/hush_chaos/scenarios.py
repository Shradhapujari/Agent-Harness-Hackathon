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
#: A `clear` silence only has to outlive the alerts it covers.
SILENCE_S = (alerts.TTL_MINUTES + 1) * 60


def crac(
    bmc: BmcClient, am: AmClient, k8s_nodes: dict[str, str], lead_s: float = HARDWARE_LEAD_S
) -> dict[str, Any]:
    """Scenario A: the CRAC unit fails and the whole rack overheats."""
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
    bmc: BmcClient, am: AmClient, k8s_node: str = "hush-worker", system: str = "R4-N04"
) -> dict[str, Any]:
    """Scenario B: one host wedges. The BMC still answers; the node does not."""
    bmc.post("/chaos/hang", {"system": system})
    paused = cluster.pause(k8s_node)
    symptoms = alerts.hang_symptoms(k8s_node, system)
    am.post_alerts(symptoms)
    return {"scenario": "hang", "system": system, "k8s_node": k8s_node, "paused": paused,
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
    for k8s_node in k8s_nodes:
        cluster.unpause(k8s_node)
        cluster.uncordon(k8s_node)
    # Alertmanager keeps the later `endsAt` when an alert is re-posted, so a
    # pushed alert cannot be shortened into resolution: silencing is the only
    # way to stop the synthetic storm on demand. Real alerts are untouched —
    # they resolve when the physics does, which is the point of the demo.
    stale = am.list_alerts([f"origin={alerts.ORIGIN}"])
    silence_id = ""
    if stale:
        silence_id = am.silence(
            [f"origin={alerts.ORIGIN}"],
            duration_s=SILENCE_S,
            comment="hush-chaos clear: scenario over",
        )
    return {"scenario": "clear", "powered_on": recovered, "silenced_alerts": len(stale),
            "silence_id": silence_id, "nodes": list(k8s_nodes)}


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
