"""Deterministic alert clustering. The model classifies; this code groups.

Split of responsibility (specs/graph.md §5): grouping an alert storm is a
mechanical, testable operation, so it lives here as a pure function. Deciding
*what kind of* failure the leading cluster represents is a judgement call and
stays with the model.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import TypedDict

#: facility < bmc < everything else. The lowest layer that fired first is the
#: physical cause; the layers above it are consequences reported later.
_LAYER_RANK = {"facility": 0, "bmc": 1}
_UNRANKED = 2


class Alert(TypedDict):
    fingerprint: str
    name: str
    severity: str
    labels: dict[str, str]
    startsAt: str
    status: str


class Cluster(TypedDict):
    key: dict[str, str]
    layer_counts: dict[str, int]
    first_seen: str
    last_seen: str
    fingerprints: list[str]
    leading_alert: str


class Correlation(TypedDict):
    clusters: list[Cluster]
    noise: list[str]


def _ts(a: Alert) -> datetime:
    return datetime.fromisoformat(a["startsAt"].replace("Z", "+00:00"))


def _rank(a: Alert) -> int:
    return _LAYER_RANK.get(a["labels"].get("layer", ""), _UNRANKED)


def correlate(alerts: list[Alert], window_s: int = 120) -> Correlation:
    """Group firing alerts by rack within ``window_s`` of the first one.

    Clusters are ordered by size then by earliest ``first_seen``, so the biggest
    simultaneous burst leads. Alerts that start after the window has closed are
    noise: a storm is what fires *together*.
    """
    firing = sorted((a for a in alerts if a["status"] == "firing"), key=_ts)
    if not firing:
        return {"clusters": [], "noise": []}
    t0 = _ts(firing[0])
    in_window = [a for a in firing if (_ts(a) - t0).total_seconds() <= window_s]
    windowed = {a["fingerprint"] for a in in_window}
    late = [a["fingerprint"] for a in firing if a["fingerprint"] not in windowed]

    by_rack: dict[str, list[Alert]] = {}
    for a in in_window:
        by_rack.setdefault(a["labels"].get("rack", "unknown"), []).append(a)

    clusters: list[Cluster] = []
    for rack, group in by_rack.items():
        layers = Counter(a["labels"].get("layer", "unknown") for a in group)
        lead = min(group, key=lambda a: (_ts(a), _rank(a)))
        clusters.append(
            {
                "key": {"rack": rack},
                "layer_counts": dict(layers),
                "first_seen": group[0]["startsAt"],
                "last_seen": max(group, key=_ts)["startsAt"],
                "fingerprints": [a["fingerprint"] for a in group],
                "leading_alert": lead["fingerprint"],
            }
        )
    clusters.sort(key=lambda c: (-len(c["fingerprints"]), c["first_seen"]))

    # A lone alert with no rack label cannot be tied to the storm's location, so
    # it is reported as noise instead of as a cluster of its own — otherwise the
    # same fingerprint would appear in both halves of the answer.
    def _orphan(c: Cluster) -> bool:
        return len(c["fingerprints"]) == 1 and c["key"]["rack"] == "unknown"

    orphans = [c["fingerprints"][0] for c in clusters if _orphan(c)]
    return {"clusters": [c for c in clusters if not _orphan(c)], "noise": late + orphans}
