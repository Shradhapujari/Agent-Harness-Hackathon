# Hush — Roadmap (two people, two laptops)

Spec-driven: `mission.md` (why/what) → `tech-stack.md` (with what) →
`graph.md` (topology + contracts) → **this file** (who/when/how). A coding
agent executes one task at a time, in order, opening one PR per task.

Clock: in-person day is Sat Aug 29; submission closes **Sun Aug 30, 20:00 London
(12:00 PDT)**. Phases carry rough durations, not clock times. Do not skip a
"Definition of done"; do not start the next task with a red CI.

## 0. Rules for the coding agent

1. Read `specs/*.md` before touching code. Contracts in `graph.md` §5 are the
   interface between people; changing one requires editing `graph.md` in the same PR.
2. Branch from `main`: `feat/<task-id>-<slug>`. PR title = task id + summary.
   Body: what/why, how tested, "Qodo findings addressed: …". Comment
   `/agentic_review` if Qodo did not auto-review. Fix High findings before merge.
3. No secrets in the repo. `.env.example` only. `gitleaks` runs in CI.
4. Tests first for pure logic (`correlate.py`, `state.ts`, `graph.ts`, `verify.ts`);
   adapters (HTTP/k8s) mocked behind interfaces.
5. Chunk large file writes (AGENTS.md). Verify generated files with `grep`.
6. Commit messages: Conventional Commits; body explains why.
7. Every log line JSON with `graph_id`, `run_id`, `node_id` (see `tech-stack.md` §4).
8. If blocked on the other person's component, use the stub listed in the task
   (`FAKE_*` flags) and keep going; never wait.

## 1. Split

| | Person A — "the data center" | Person B — "the operator" |
|---|---|---|
| Owns | `mock-bmc/`, `infra/`, `chaos/`, `mcp/` | `hush/`, `skills/`, `.github/`, `docs/`, `README.md`, TrueForge setup |
| Language | Python 3.12, `uv`, FastAPI, FastMCP | TypeScript, `@truefoundry/trueforge-sdk`, zod, vitest |
| Delivers | a storm-producing simulated DC reachable through 5 MCP URLs | an agent + graph that silences it, with approvals, report, CI, Qodo, blog, video |
| Stub for the other side | `mcp/` servers work against mock-bmc alone; `FAKE_K8S=1`, `FAKE_NETBOX=1` env flags | `hush/test/fixtures/*.json` recorded tool outputs; `HUSH_FAKE_HARNESS=1` replays a canned session |

Integration checkpoints (both on a call, 20 min each): **I1** after A3+B3,
**I2** after A5+B5, **I3** = dress rehearsal before recording.

---

# Person A — the data center

## A0 · Laptop + Python workspace (≈ 45 min)

Goal: one `uv` workspace, mock-bmc tests green, Docker + kind installed.

```bash
brew install --cask docker && open -a Docker      # wait for "Docker is running"
brew install kind kubectl uv gitleaks
uv python install 3.12
```

Root `pyproject.toml` (workspace so `uv run` works from anywhere):

```toml
[project]
name = "hush-workspace"
version = "0.0.0"
requires-python = ">=3.12"

[tool.uv.workspace]
members = ["mock-bmc", "mcp", "chaos"]

[tool.ruff]
line-length = 110
target-version = "py312"
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM"]

[tool.mypy]
strict = true
python_version = "3.12"
```

Tasks:
- `A0.1` add root `pyproject.toml`, `uv sync --all-packages`, `uv run pytest mock-bmc -q` → 36 passed.
- `A0.2` `mock-bmc/Dockerfile` (python:3.12-slim, `uv pip install .`, `CMD uvicorn app.main:app --host 0.0.0.0 --port 8100`).
- `A0.3` `Makefile` targets: `up`, `down`, `kind-up`, `kind-down`, `smoke`, `test`.

Definition of done: `make test` runs ruff + mypy + pytest for all three packages (mcp/chaos may be empty); PR #A0 merged with Qodo review.

## A1 · Metrics + Prometheus + Alertmanager (≈ 1.5 h)

Goal: real alerts fire from scraped mock-BMC metrics.

`mock-bmc/app/metrics.py` — Prometheus text format, no extra deps:

```python
"""Prometheus exposition for the fleet snapshot (GET /metrics, no auth)."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app.state import Fleet

_GAUGES = {  # metric name -> (snapshot key, help)
    "hush_inlet_temp_celsius": ("inlet_temp_c", "Inlet air temperature"),
    "hush_cpu_temp_celsius": ("cpu_temp_c", "CPU temperature"),
    "hush_fan_percent": ("fan_pct", "Fan duty cycle"),
    "hush_power_watts": ("power_watts", "Power draw"),
}


def _bool(v: bool) -> str:
    return "1" if v else "0"


def build_metrics_router(fleet: Fleet) -> APIRouter:
    router = APIRouter()

    @router.get("/metrics", response_class=PlainTextResponse)
    def metrics() -> str:
        snap = fleet.snapshot()
        out: list[str] = []
        for name, (key, help_) in _GAUGES.items():
            out.append(f"# HELP {name} {help_}\n# TYPE {name} gauge")
            out += [f'{name}{{system="{n["system_id"]}"}} {n[key]:.2f}' for n in snap["nodes"]]
        out.append("# TYPE hush_power_on gauge")
        out += [f'hush_power_on{{system="{n["system_id"]}"}} {_bool(n["power"] == "On")}' for n in snap["nodes"]]
        out.append("# TYPE hush_host_hung gauge")
        out += [f'hush_host_hung{{system="{n["system_id"]}"}} {_bool(n["hung"])}' for n in snap["nodes"]]
        out.append("# TYPE hush_thermal_trip gauge")
        out += [f'hush_thermal_trip{{system="{n["system_id"]}"}} {_bool(n["thermal_trip"])}' for n in snap["nodes"]]
        out.append("# TYPE hush_psu_ok gauge")
        for n in snap["nodes"]:
            for psu in (1, 2):
                out.append(f'hush_psu_ok{{system="{n["system_id"]}",psu="{psu}"}} {_bool(n[f"psu{psu}_ok"])}')
        out.append(f'hush_ambient_celsius {snap["ambient_c"] + snap["ambient_offset_c"]:.2f}')
        return "\n".join(out) + "\n"

    return router
```

Wire in `create_app`: `app.include_router(build_metrics_router(fleet))`. Test: `GET /metrics` contains 12 `hush_cpu_temp_celsius` lines.

`infra/prometheus/rules/hush.yml` (every rule carries `layer` + `rack`/`node` labels — the correlator keys on them):

```yaml
groups:
- name: hush-hardware
  interval: 5s
  rules:
  - alert: InletTempHigh
    expr: hush_inlet_temp_celsius > 30
    for: 10s
    labels: {severity: warning, layer: bmc, rack: R4, node: "{{ $labels.system }}"}
    annotations: {summary: "Inlet {{ $labels.system }} at {{ $value }}C"}
  - alert: CpuTempCritical
    expr: hush_cpu_temp_celsius > 90
    for: 5s
    labels: {severity: critical, layer: bmc, rack: R4, node: "{{ $labels.system }}"}
  - alert: ThermalTrip
    expr: hush_thermal_trip == 1
    labels: {severity: critical, layer: bmc, rack: R4, node: "{{ $labels.system }}"}
  - alert: PsuInputLost
    expr: hush_psu_ok == 0
    labels: {severity: critical, layer: bmc, rack: R4, node: "{{ $labels.system }}"}
  - alert: HostHung
    expr: hush_host_hung == 1
    for: 5s
    labels: {severity: critical, layer: bmc, rack: R4, node: "{{ $labels.system }}"}
  - alert: FacilityAmbientHigh
    expr: hush_ambient_celsius > 28
    for: 10s
    labels: {severity: critical, layer: facility, rack: R4}
    annotations: {summary: "Rack R4 ambient {{ $value }}C — possible CRAC failure"}
```

`infra/prometheus/prometheus.yml`: `scrape_interval: 5s`, job `mock-bmc` → `mock-bmc:8100`, `alerting.alertmanagers` → `alertmanager:9093`, `rule_files: [rules/*.yml]`.
`infra/alertmanager/alertmanager.yml`: one receiver `hush-null` (webhook to `http://host.docker.internal:9199` optional), `group_wait: 5s`, `group_interval: 10s`, `repeat_interval: 1h`, `group_by: ["alertname", "node"]` — grouping stays coarse so the storm is visible.

`infra/docker-compose.yml` services: `mock-bmc` (build ../mock-bmc, 8100), `prometheus` (`prom/prometheus:v2.54.1`, 9090, mounts config+rules), `alertmanager` (`prom/alertmanager:v0.27.0`, 9093). NetBox added in A4 under `profiles: [netbox]`.

Definition of done: `make up` → `curl -s localhost:8100/chaos/crac-failure -XPOST -d '{"delta_c":14}' -H 'content-type: application/json'` → within 60 s `curl -s localhost:9093/api/v2/alerts | jq length` ≥ 13 (12 InletTempHigh + FacilityAmbientHigh). `POST /chaos/clear` resolves them.

## A2 · kind cluster + demo workloads (≈ 1 h)

Goal: 3 real k8s nodes, each labelled with the BMC it "lives in"; pods to drain.

`infra/kind/cluster.yaml`:

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: hush
nodes:
- role: control-plane
  labels: {hush.io/bmc: R4-N01, hush.io/rack: R4}
- role: worker
  labels: {hush.io/bmc: R4-N04, hush.io/rack: R4}
- role: worker
  labels: {hush.io/bmc: R4-N07, hush.io/rack: R4}
```

`infra/kind/workloads.yaml`: namespace `demo`; three Deployments
(`web`, `api`, `worker`, 3 replicas each, `nginx:alpine`, small requests) with
`topologySpreadConstraints` on `kubernetes.io/hostname` so every node holds
pods; a `PodDisruptionBudget` `minAvailable: 1` per app so drain is realistic
but succeeds.

Makefile:

```makefile
kind-up:
	kind create cluster --config infra/kind/cluster.yaml
	kubectl apply -f infra/kind/workloads.yaml
	kubectl -n demo rollout status deploy --timeout=120s
kind-down:
	kind delete cluster --name hush
```

Hung-node realism (used by A5): `docker pause hush-worker` → node `NotReady`
after `node-monitor-grace-period` (40 s); `docker unpause hush-worker` recovers.
Mapping worker↔BMC: `kubectl get nodes -L hush.io/bmc`.

Definition of done: `kubectl get nodes -L hush.io/bmc` shows 3 Ready nodes with
labels; `kubectl -n demo get pods -o wide` shows pods on every node;
`kubectl drain hush-worker --ignore-daemonsets --delete-emptydir-data` succeeds
and `kubectl uncordon hush-worker` restores.

## A3 · MCP servers: common + alertmanager/correlate + redfish (≈ 2 h)

Goal: two MCP URLs the harness can register; correlation is pure + tested.

`mcp/pyproject.toml` deps: `mcp[cli]>=1.12`, `httpx`, `pydantic`, `kubernetes`,
`structlog`; scripts: `hush-mcp = "hush_mcp.cli:main"` (`hush-mcp alertmanager|redfish|kubernetes|prometheus|netbox`).

`mcp/hush_mcp/common.py`:

```python
"""Shared FastMCP factory: JSON logging, idempotency store, error envelope."""
from __future__ import annotations

import functools
import json
import logging
import os
import sys
from collections.abc import Callable
from typing import Any, ParamSpec

from mcp.server.fastmcp import FastMCP

P = ParamSpec("P")

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(message)s")
log = logging.getLogger("hush-mcp")


def make_server(name: str, port: int) -> FastMCP:
    """FastMCP bound to 127.0.0.1:<port>, streamable-http at /mcp."""
    return FastMCP(name, host="127.0.0.1", port=port, streamable_http_path="/mcp")


def env(name: str, default: str) -> str:
    return os.getenv(name, default)


_IDEMPOTENT: dict[str, Any] = {}


def idempotent(fn: Callable[P, dict[str, Any]]) -> Callable[P, dict[str, Any]]:
    """Return the first result for a repeated idempotency_key; never raise to the model."""

    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> dict[str, Any]:
        key = str(kwargs.get("idempotency_key", ""))
        if key and key in _IDEMPOTENT:
            return {**_IDEMPOTENT[key], "replayed": True}
        try:
            result = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - tool boundary
            log.error(json.dumps({"tool": fn.__name__, "error": str(exc)}))
            return {"error": {"code": type(exc).__name__, "message": str(exc)}}
        if key:
            _IDEMPOTENT[key] = result
        log.info(json.dumps({"tool": fn.__name__, "key": key, "ok": result.get("ok", True)}))
        return result

    return wrapper
```

`mcp/hush_mcp/correlate.py` — pure, no I/O (tested with `tests/fixtures/alerts_crac.json`, `alerts_hang.json`):

```python
"""Deterministic alert clustering. The model classifies; this code groups."""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import TypedDict


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


def _ts(a: Alert) -> datetime:
    return datetime.fromisoformat(a["startsAt"].replace("Z", "+00:00"))


def correlate(alerts: list[Alert], window_s: int = 120) -> dict[str, list]:
    firing = sorted((a for a in alerts if a["status"] == "firing"), key=_ts)
    if not firing:
        return {"clusters": [], "noise": []}
    t0 = _ts(firing[0])
    in_window = [a for a in firing if (_ts(a) - t0).total_seconds() <= window_s]
    late = [a["fingerprint"] for a in firing if a not in in_window]
    by_rack: dict[str, list[Alert]] = {}
    for a in in_window:
        by_rack.setdefault(a["labels"].get("rack", "unknown"), []).append(a)
    clusters: list[Cluster] = []
    for rack, group in by_rack.items():
        layers = Counter(a["labels"].get("layer", "unknown") for a in group)
        lead = min(group, key=lambda a: (_ts(a), {"facility": 0, "bmc": 1}.get(a["labels"].get("layer", ""), 2)))
        clusters.append({
            "key": {"rack": rack},
            "layer_counts": dict(layers),
            "first_seen": group[0]["startsAt"], "last_seen": max(group, key=_ts)["startsAt"],
            "fingerprints": [a["fingerprint"] for a in group],
            "leading_alert": lead["fingerprint"],
        })
    clusters.sort(key=lambda c: (-len(c["fingerprints"]), c["first_seen"]))
    noise = late + [c["fingerprints"][0] for c in clusters if len(c["fingerprints"]) == 1 and c["key"]["rack"] == "unknown"]
    return {"clusters": clusters, "noise": noise}
```

Rule of thumb encoded above: the *earliest, lowest-layer* alert in the biggest
cluster leads (facility < bmc < kubernetes < app). Tests assert: scenario A →
one R4 cluster, leading alert `FacilityAmbientHigh`; scenario B → leading
`HostHung` on `R4-N04`; alerts outside the window → noise.

`mcp/hush_mcp/alertmanager.py` (port 9101) tools per `graph.md` §5; `list_alerts`
maps AM v2 JSON → `Alert` (`fingerprint`, `labels.alertname`→`name`, `labels.severity`).
`correlate_alerts` wraps `correlate()`. `silence_alerts` POSTs `/api/v2/silences`.

`mcp/hush_mcp/redfish.py` (port 9102): `httpx.Client(base_url=HUSH_BMC_URL, auth=(user, pw))`.
`reset_system` is `@idempotent`, validates `reset_type` against the allowed set,
POSTs `ComputerSystem.Reset`, then reads the last SEL entry and returns its id.
`get_fleet_summary` reads `/chaos/status` (unauthenticated read, fine locally).

Run: `uv run hush-mcp alertmanager` → `http://127.0.0.1:9101/mcp`. Smoke: `npx @modelcontextprotocol/inspector` → connect streamable-http URL → list tools.

Definition of done: `uv run pytest mcp -q` green incl. ≥ 8 correlate tests;
both servers list their tools in MCP Inspector; `reset_system` twice with the
same key returns `replayed: true` the second time and only one SEL entry is written.

## A4 · MCP servers: kubernetes + prometheus + netbox (≈ 2 h)

`mcp/hush_mcp/kubernetes.py` (port 9103) — official `kubernetes` client, context `kind-hush`:

```python
from kubernetes import client, config
from kubernetes.client.rest import ApiException

from hush_mcp.common import idempotent, make_server

mcp = make_server("kubernetes", 9103)
config.load_kube_config(context="kind-hush")
v1 = client.CoreV1Api()


def _bmc(node: client.V1Node) -> str | None:
    return (node.metadata.labels or {}).get("hush.io/bmc")


@mcp.tool()
def list_nodes() -> dict:
    """List cluster nodes with Ready state, schedulability and the BMC id label."""
    out = []
    for n in v1.list_node().items:
        ready = next((c.status == "True" for c in n.status.conditions if c.type == "Ready"), False)
        out.append({"name": n.metadata.name, "ready": ready, "unschedulable": bool(n.spec.unschedulable), "bmc_id": _bmc(n)})
    return {"nodes": out}


@mcp.tool()
@idempotent
def cordon_node(name: str, idempotency_key: str) -> dict:
    """Mark a node unschedulable (safe, reversible)."""
    v1.patch_node(name, {"spec": {"unschedulable": True}})
    return {"ok": True, "node": name}


@mcp.tool()
@idempotent
def drain_node(name: str, grace_s: int = 30, idempotency_key: str = "") -> dict:
    """Cordon then evict all non-DaemonSet pods via the Eviction API (safe: pods reschedule)."""
    v1.patch_node(name, {"spec": {"unschedulable": True}})
    evicted: list[str] = []
    for p in v1.list_pod_for_all_namespaces(field_selector=f"spec.nodeName={name}").items:
        owners = {o.kind for o in (p.metadata.owner_references or [])}
        if "DaemonSet" in owners or p.metadata.namespace == "kube-system":
            continue
        body = client.V1Eviction(metadata=client.V1ObjectMeta(name=p.metadata.name, namespace=p.metadata.namespace),
                                 delete_options=client.V1DeleteOptions(grace_period_seconds=grace_s))
        try:
            v1.create_namespaced_pod_eviction(p.metadata.name, p.metadata.namespace, body)
            evicted.append(f"{p.metadata.namespace}/{p.metadata.name}")
        except ApiException as exc:  # PDB blocked → report, don't fail the whole drain
            evicted.append(f"{p.metadata.namespace}/{p.metadata.name} (blocked: {exc.status})")
    return {"ok": True, "node": name, "evicted": evicted}
```

Add `get_node`, `list_pods`, `uncordon_node`. `FAKE_K8S=1` swaps `v1` for an
in-memory fake (3 nodes, 9 pods) so Person B and CI never need a cluster.

`mcp/hush_mcp/prometheus.py` (port 9104): `query` → `GET /api/v1/query`,
`query_range` → `/api/v1/query_range` with `start=now-minutes`, `step`; trim
series/points per `graph.md`; `list_rules` → `/api/v1/rules`.

NetBox (`infra/docker-compose.yml` profile `netbox`): follow `netbox-docker`
(services `netbox`, `netbox-worker`, `postgres`, `redis`, `redis-cache`;
image `netboxcommunity/netbox:v4.1`; env `SUPERUSER_API_TOKEN=0123456789abcdef0123456789abcdef01234567`,
`SKIP_SUPERUSER=false`). Startup ≈ 2–4 min. `infra/netbox/seed.py` (idempotent, uses the token):
site `SFO-LAB`, rack `R4`, tenants `acme`, `globex`, `initech`, device role
`compute`, device type `MockRack-1U`, 12 devices `R4-N01..12` with tenants
round-robin and `custom_fields.bmc_id`. Same data is written to
`infra/netbox/seed.json` — the fallback.

`mcp/hush_mcp/netbox.py` (port 9105): each tool tries the live API with a 3 s
timeout; on any failure returns the `seed.json` answer with `"source": "fallback"`
(and logs it). `get_blast_radius(nodes)` aggregates tenants/racks.

Definition of done: `hush-mcp kubernetes|prometheus|netbox` all list tools in
Inspector; `drain_node` on `hush-worker` evicts demo pods (visible in `kubectl get pods -w`);
`FAKE_K8S=1 uv run pytest mcp` green; stopping NetBox makes `get_device` return
`source: "fallback"` within 3 s.

## A5 · Chaos CLI — the two scenarios (≈ 1.5 h)

Goal: `hush-chaos crac` and `hush-chaos hang` produce the storms in `mission.md` §3 deterministically; `hush-chaos clear` resets everything.

`chaos/hush_chaos/alerts.py` — synthetic symptom alerts posted straight to Alertmanager
(`POST /api/v2/alerts`, array of `{labels, annotations, startsAt, endsAt}`). Prometheus
already fires the hardware layer; this adds the k8s/app layers to reach ≥ 40:

```python
"""Synthetic k8s/app-layer alerts for a scenario; hardware alerts come from Prometheus rules."""
from datetime import UTC, datetime, timedelta

def _alert(name: str, severity: str, **labels: str) -> dict:
    now = datetime.now(UTC)
    return {
        "labels": {"alertname": name, "severity": severity, "rack": "R4", **labels},
        "annotations": {"summary": f"{name} {labels}"},
        "startsAt": now.isoformat(), "endsAt": (now + timedelta(minutes=15)).isoformat(),
        "generatorURL": "hush-chaos",
    }

def crac_cascade(k8s_nodes: dict[str, str]) -> list[dict]:   # {"hush-worker": "R4-N04", ...}
    out = []
    for kn, bmc in k8s_nodes.items():
        out.append(_alert("KubeNodeNotReady", "critical", layer="kubernetes", node=bmc, k8s_node=kn))
        out.append(_alert("KubeNodeUnreachable", "warning", layer="kubernetes", node=bmc, k8s_node=kn))
        for app in ("web", "api", "worker"):
            out.append(_alert("KubePodCrashLooping", "warning", layer="kubernetes", node=bmc, namespace="demo", pod=f"{app}-{kn}"))
    for tenant in ("acme", "globex", "initech"):
        out.append(_alert("AppErrorRateHigh", "critical", layer="app", tenant=tenant))
        out.append(_alert("AppLatencyP99High", "warning", layer="app", tenant=tenant))
    out.append(_alert("FlappingSwitchPort", "info", layer="network", node="R2-SW01", rack="R2"))  # noise, other rack
    return out
```

`chaos/hush_chaos/scenarios.py`:

```python
def crac(bmc: BmcClient, am: AmClient, k8s_map: dict[str, str]) -> None:
    bmc.post("/chaos/crac-failure", {"delta_c": 14})           # 12× InletTempHigh + FacilityAmbientHigh via Prometheus
    for sid in ("R4-N04", "R4-N07"):                             # push two nodes past 97C → ThermalTrip
        bmc.post("/chaos/thermal-spike", {"system": sid, "delta_c": 35, "duration_s": 600})
    time.sleep(20)                                               # let hardware alerts land first (ordering matters to the correlator)
    am.post_alerts(alerts.crac_cascade(k8s_map))

def hang(bmc: BmcClient, am: AmClient, k8s_node: str = "hush-worker", system: str = "R4-N04") -> None:
    bmc.post("/chaos/hang", {"system": system})                  # HostHung via Prometheus
    subprocess.run(["docker", "pause", k8s_node], check=True)    # real NotReady in ~40 s
    am.post_alerts(alerts.hang_symptoms(k8s_node, system))       # pods pending, app errors for that node's tenants

def clear(bmc, am, k8s_nodes) -> None:
    bmc.post("/chaos/clear", {})
    for n in k8s_nodes: subprocess.run(["docker", "unpause", n], check=False)
    am.expire_all("generatorURL=hush-chaos")                     # POST same alerts with endsAt=now
    kubectl uncordon all nodes
```

`chaos/hush_chaos/cli.py`: `hush-chaos crac|hang|clear|status` (`status` = firing
count by layer). Note: `ForceRestart` on the BMC does not unpause the kind
container — the redfish MCP `reset_system` calls `docker unpause <k8s node>`
when the target system maps to a kind node (`hush.io/bmc` label), so a real
power-cycle brings the real node back. Document this in `mcp/README.md`.

Definition of done: fresh stack → `hush-chaos crac` → `hush-chaos status`
shows ≥ 40 firing within 90 s with layers bmc/facility/kubernetes/app/network;
`hush-chaos hang` → `kubectl get nodes` shows `hush-worker NotReady` within 60 s
and Redfish shows `Oem.DCSentinel.Hung: true`; `hush-chaos clear` → 0 firing
within 2 min and all nodes Ready. `chaos/tests` cover alert generation (count,
labels) without network.

## A6 · One-command stack + smoke test + hardening (≈ 1 h, after I1)

- `make up` = `docker compose --profile netbox up -d` + `kind-up` (if missing) + `netbox seed` + start the 5 MCP servers (`scripts/mcp-up.sh` runs them with `nohup`, logs to `runs/mcp-*.log`).
- `scripts/smoke.sh`: curls 8100 `/redfish/v1` (auth), 9090 `/-/ready`, 9093 `/-/ready`, 8000 `/api/status/`, and each `/mcp` URL via a tiny Python client that lists tools; prints a table; exit 1 on any miss. `make smoke`.
- Tune drama for the demo: in `state.py` keep tau 8 s; in the scenario, `thermal-spike` two nodes so `ThermalTrip` fires within ~60 s. Document constants in `chaos/README.md`.
- Add `X-Hush-Run` header passthrough: MCP servers log `run_id` if the tool arg `run_id` is present (Person B's prompts include it) — cheap correlation between harness traces and tool logs.
- Fix everything Qodo flagged on A1–A5 PRs that was deferred.

Definition of done: on a clean laptop, `README.md` "Run it" section (Person B writes, Person A verifies) works end to end: `make up && make smoke && hush-chaos crac`.

---

# Person B — the operator

## B0 · TrueForge up, repo hygiene, CI, Qodo (≈ 1.5 h) — *do this first, PR #1*

TrueForge:

```bash
npx @truefoundry/trueforge@latest          # http://localhost:8790
```

Settings → Models: add an OpenAI key, pick `openai/gpt-5-6-luna`. This is Hush's
only supported model; do not configure a fallback. Settings → Sandbox
providers: Daytona key (needs sandbox **and** snapshot-create permission).
Manual sanity check in chat: enable sandbox + subagents, ask "spawn two
subagents that each compute a prime and run python to add them" — confirm
`thread.created` cards and a sandbox run appear. Screenshot for the blog.

`hush/` scaffold (TypeScript ESM, strict):

```bash
mkdir hush && cd hush && npm init -y
npm i @truefoundry/trueforge-sdk zod commander pino
npm i -D typescript tsx vitest @types/node eslint @eslint/js typescript-eslint prettier
```

`package.json` scripts: `build: tsc -p .`, `test: vitest run --coverage`,
`lint: eslint src test && prettier --check .`, `incident: tsx src/cli.ts incident`,
`resume: tsx src/cli.ts resume`, `register: tsx scripts/register.ts`.

`.github/workflows/ci.yml` (matrix python/node; both run on every PR):

```yaml
name: ci
on: { pull_request: {}, push: { branches: [main] } }
jobs:
  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv python install 3.12 && uv sync --all-packages
      - run: uv run ruff check . && uv run ruff format --check .
      - run: uv run mypy mcp chaos
      - run: FAKE_K8S=1 FAKE_NETBOX=1 uv run pytest -q
  node:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: hush } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: hush/package-lock.json }
      - run: npm ci
      - run: npm run lint && npm run build && npm test
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
```

Qodo: sign in at app.qodo.ai → connect GitHub → install on this repo. Add
`.github/pull_request_template.md` with sections *What / Why / Tests / Qodo
findings addressed*. Open **PR #1** (scaffold + CI + template) and confirm Qodo
comments; comment `/agentic_review` if not. Merge. Add `.env.example`,
`.gitignore` (`runs/`, `reports/*.md` except `reports/samples/`, `.env`, `node_modules`, `.venv`).

Definition of done: PR #1 merged with a Qodo review visible; CI green; TrueForge
runs a subagent + sandbox turn locally.

## B1 · State + graph runner (pure, tested) (≈ 2 h)

Files: `hush/src/state.ts` (schemas from `graph.md` §2 verbatim), `hush/src/registry.ts`
(§5), `hush/src/graph.ts`, `hush/src/checkpoint.ts`, `hush/src/log.ts`.

`hush/src/graph.ts` — nodes are functions, edges are code, limits are data:

```ts
import type { RunState } from "./state.js";

export type NodeId = RunState["node"];
export type NodeFn = (s: RunState, ctx: Ctx) => Promise<Partial<RunState>>;
export type EdgeFn = (s: RunState) => NodeId;           // decided by code (or by a human via state)

export interface Ctx {
  harness: Harness;            // TrueForge adapter (B2)
  approval: ApprovalBridge;    // terminal | ui (B4)
  probes: Probes;              // direct HTTP reads for N0/N8 (alertmanager, bmc, k8s)
  clock: () => Date;
  log: (nodeId: NodeId, event: string, detail?: unknown) => void;
}

export const LIMITS = { STORM_MIN: 15, WINDOW_S: 120, ACTIONS_MAX: 4, REPLANS_MAX: 2,
  PARSE_RETRIES_MAX: 2, VERIFY_ATTEMPTS_MAX: 2, VERIFY_TIMEOUT_S: 180, APPROVAL_TIMEOUT_S: 600, RUN_TIMEOUT_S: 900 } as const;

export interface Graph { nodes: Record<NodeId, NodeFn>; edges: Record<NodeId, EdgeFn>; }

export function merge(s: RunState, patch: Partial<RunState>): RunState {
  const byId = <T extends { id: string }>(a: T[], b: T[] = []) =>
    [...a.filter(x => !b.some(y => y.id === x.id)), ...b];
  return { ...s, ...patch,
    evidence: byId(s.evidence, patch.evidence), actions: byId(s.actions, patch.actions),
    timeline: [...s.timeline, ...(patch.timeline ?? [])] };
}

export async function run(graph: Graph, initial: RunState, ctx: Ctx, save: (s: RunState) => Promise<void>): Promise<RunState> {
  let s = initial; const started = ctx.clock().getTime();
  while (s.node !== "DONE") {
    if (ctx.clock().getTime() - started > LIMITS.RUN_TIMEOUT_S * 1000 && s.node !== "N10" && s.node !== "N9") {
      s = merge(s, { node: "N9", timeline: [{ ts: ctx.clock().toISOString(), nodeId: s.node, event: "run_timeout" }] });
    }
    const patch = await graph.nodes[s.node](s, ctx);
    s = merge(s, patch);
    const next = s.node === "N10" ? "DONE" : graph.edges[s.node](s);
    ctx.log(s.node, "edge", { next });
    s = { ...s, node: next };
    await save(s);                                      // checkpoint after every node
  }
  return s;
}
```

`hush/src/edges.ts` implements E0…E9 exactly as `graph.md` §4 (each a one-liner
over state + `LIMITS`). `hush/src/checkpoint.ts` writes `runs/<runId>/state.json` atomically.

Tests (`hush/test/graph.test.ts`, `edges.test.ts`, `state.test.ts`) with fake
nodes: happy path visits N0→N1→N2→N3→N4→N5→N4→N6→N7→N8→N10; deny once →
replans to N3 and blacklists the pair; deny twice → N9; parse retries
exhausted → N9; verify fails twice → N9; run timeout → N9 → N10; `merge`
dedupes by id; unknown tool stripped at E3. Target: 100 % branch coverage on
`graph.ts`, `edges.ts`, `state.ts`, `registry.ts`.

Definition of done: `npm test` green with coverage report; PR merged with Qodo review.

## B2 · TrueForge adapter + registration script + prompts (≈ 2 h)

`hush/scripts/register.ts` — idempotent setup via REST (so a stranger runs one command):

```ts
// PUT-or-POST each MCP server, then create-or-replace the agent from hush/agent.json
const BASE = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";
const SERVERS = [
  { name: "alertmanager", url: "http://127.0.0.1:9101/mcp", description: "Alertmanager alerts + deterministic correlation" },
  { name: "redfish",      url: "http://127.0.0.1:9102/mcp", description: "Mock BMC (DMTF Redfish): power, thermal, SEL, reset" },
  { name: "kubernetes",   url: "http://127.0.0.1:9103/mcp", description: "kind cluster: nodes, pods, cordon/drain" },
  { name: "prometheus",   url: "http://127.0.0.1:9104/mcp", description: "PromQL over mock-BMC metrics" },
  { name: "netbox",       url: "http://127.0.0.1:9105/mcp", description: "NetBox inventory (read-only)" },
];
for (const s of SERVERS) {
  await fetch(`${BASE}/api/v1/mcp-servers/${s.name}`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: { type: "remote", ...s } }) });      // "create or replace"; no auth block = no credentials
}
const agent = JSON.parse(await readFile("hush/agent.json", "utf8"));
agent.manifest.instructions = await readFile("hush/prompts/system.md", "utf8");
agent.manifest.model.name = process.env.HUSH_MODEL ?? agent.manifest.model.name;
await fetch(`${BASE}/api/v1/agents/${agent.name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(agent) });
```

Confirm exact paths against `http://localhost:8790/openapi.json` on first run
(the docs list "Create or replace an MCP server" and "Update an agent"); adjust
verbs, keep the script idempotent. The skill (`hush-triage`) is imported once
via Settings → Skills → Import from GitHub (public repo URL, path `skills/hush-triage`) — document in README; do not automate OAuth flows.

`hush/src/trueforge.ts` — the `Harness` interface used by nodes:

```ts
import { TrueForge } from "@truefoundry/trueforge-sdk";

export interface TurnResult { text: string; events: unknown[]; pendingApproval?: { threadId: string; toolCallId: string; tool: string; args: unknown } }

export class Harness {
  private client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790", timeoutInSeconds: 900 });
  constructor(private readonly agentName = "hush-operator", private readonly sink: (e: unknown) => void) {}

  async openSession(): Promise<string> {
    const { data } = await this.client.sessions.create({ agent: { name: this.agentName } });
    return data.id;
  }

  async turn(sessionId: string, message: string, tag: { runId: string; nodeId: string }): Promise<TurnResult> {
    return this.stream(sessionId, [{ type: "user.message", content: `[hush run_id=${tag.runId} node=${tag.nodeId}]\n${message}` }]);
  }

  async approve(sessionId: string, p: NonNullable<TurnResult["pendingApproval"]>, allow: boolean, reason?: string): Promise<TurnResult> {
    return this.stream(sessionId, [{ type: "user.tool_approval", thread_id: p.threadId, tool_call_id: p.toolCallId,
      approval: allow ? { status: "allow" } : { status: "deny", reason } }]);
  }

  private async stream(sessionId: string, input: unknown[]): Promise<TurnResult> {
    const stream = await this.client.sessions.createTurnStream(sessionId, { input, previous_turn_id: "auto" } as never);
    const out: TurnResult = { text: "", events: [] };
    for await (const { data: ev } of stream.withMetadata()) {
      this.sink(ev); out.events.push(ev);
      if (ev.type === "model.message.delta") out.text += ev.content ?? "";
      if (ev.type === "tool.approval_required") out.pendingApproval = { threadId: ev.thread_id, toolCallId: ev.tool_call_id, tool: ev.tool_name ?? ev.name, args: ev.arguments ?? ev.input };
      if (ev.type === "turn.done") break;
    }
    return out;
  }
}

export function lastJsonBlock(text: string): unknown {
  const m = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);
  if (!m) throw new Error("no json block");
  return JSON.parse(m[1]);
}
```

Field names on `tool.approval_required` (`thread_id`, `tool_call_id`, tool
name/args) must be confirmed from a real event dump in B0's sanity chat —
record one to `hush/test/fixtures/events/approval.json` and type against it.
Every SSE event goes to `runs/<runId>/events.jsonl` via `sink`.

Prompts: `hush/prompts/system.md` (per `graph.md` §6) and per-node templates
`triage.md`, `enrich.md`, `plan.md`, `exec.md`, `verify.md`, each ending with
the node's JSON schema (generate from zod with `zod-to-json-schema`). Keep each
template < 40 lines; put runbook knowledge in the skill, not the prompt.

`HUSH_FAKE_HARNESS=1`: `FakeHarness` replays `hush/test/fixtures/session-crac.jsonl`
(recorded at I1) so graph tests and CI run without TrueForge or a model key.

Definition of done: `npm run register` twice → second run is a no-op; TrueForge
UI shows agent `hush-operator` with 5 connectors and `reset_system` marked
approval-required; a manual turn "list systems" in the UI calls `redfish.list_systems`.

## B3 · Nodes N0–N3: watch, triage, enrich, plan (≈ 2 h)

`hush/src/nodes/watch.ts` (N0, deterministic): poll `GET ${HUSH_ALERTMANAGER_URL}/api/v2/alerts?active=true`
every 5 s; map to `Alert`; when `firing.length ≥ STORM_MIN` and the earliest
`startsAt` is within `WINDOW_S`, mint `runId = inc-<yyyymmdd>-<4hex>` and return
`{ alerts, runId, timeline: [storm_detected] }`. `--scenario` flag only sets
`scenarioHint` for the report; the model never sees it.

`hush/src/nodes/triage.ts` (N1, agentic):

```ts
export const triage: NodeFn = async (s, ctx) => {
  const sessionId = s.sessionId ?? await ctx.harness.openSession();
  const compact = s.alerts.map(a => ({ f: a.fingerprint, n: a.name, sev: a.severity, l: pick(a.labels, ["layer","rack","node","tenant"]), t: a.startsAt, st: a.status }));
  const msg = render("triage", { alerts: JSON.stringify(compact), schema: incidentSchemaJson });
  const r = await ctx.harness.turn(sessionId, msg, { runId: s.runId, nodeId: "N1" });
  try {
    const incident = Incident.parse(lastJsonBlock(r.text));
    return { sessionId, incident, timeline: [ev(ctx, "N1", "incident_identified", incident.rootCause)] };
  } catch (e) {
    return { sessionId, counters: { ...s.counters, parseRetries: s.counters.parseRetries + 1 },
      timeline: [ev(ctx, "N1", "parse_error", String(e))] };   // E1b re-enters N1 with the error appended by render()
  }
};
```

`triage.md` tells the model: call `alertmanager.correlate_alerts` with the
alerts it was given (and `list_alerts` if it wants labels it lacks), pick the
leading cluster, classify `rootCause.kind` from the leading alert
(`FacilityAmbientHigh`→`crac_failure`, `HostHung`→`host_hang`, `PsuInputLost`→`psu_failure`,
single `CpuTempCritical`→`thermal_single`), fill `primary/symptoms/noise` from the
cluster output, and answer with one json block. The mapping is also in the
skill so the model has a runbook, but the code still validates the enum.

`hush/src/nodes/enrich.ts` (N2): one turn with `enrich.md`, which *requires*
three `create_sub_agent` calls (redfish / netbox / kubernetes+prometheus) in
parallel and a merged json block `{ evidence: Evidence[] }`. Controller checks
`thread.created` count ≥ 3 in the events (logged as `subagents_spawned`) and
that each required layer is present (E2). Optional 4th subagent for Bright
Data when `brightdata` connector exists (agent.json gets it only if
`HUSH_BRIGHTDATA=1` at register time).

`hush/src/nodes/plan.ts` (N3): `plan.md` receives incident + evidence summaries
(+ `denied` list and verify findings when replanning) and returns
`{ actions: Action[] }`. Controller: strip unknown tools, cap at `ACTIONS_MAX`,
assign `rank`, set `idempotencyKey = ${runId}:${tool}:${hash(args)}`, and
**override `kind` from `REGISTRY`**.

Fixtures for tests: `hush/test/fixtures/alerts_crac.json` (≥ 40, generated by
running `hush-chaos crac` once at I1 and dumping AM), `alerts_hang.json`, plus
recorded turn texts. Unit tests cover parse-retry path, unknown-tool stripping,
kind override, subagent-count check.

Definition of done: with the real stack (I1) `npm run incident -- --scenario crac --until N3`
prints the incident (kind `crac_failure`, scope 12 nodes), ≥ 3 evidence layers,
and a ranked plan whose first action is `kubernetes.drain_node` and whose
destructive action is `redfish.reset_system GracefulShutdown`.

## B4 · Nodes N4–N10: route, execute, approval, verify, escalate, report (≈ 2.5 h)

`hush/src/nodes/route.ts` (N4): pick the next `proposed` action by rank; the
edge (`E4a/E4b`) reads `REGISTRY[action.tool].kind`. Never the model's word.

`hush/src/nodes/exec.ts` (N5 and N7 share one implementation):

```ts
export const exec: NodeFn = async (s, ctx) => {
  const a = nextProposed(s)!;
  const msg = render("exec", { action: JSON.stringify({ tool: a.tool, args: { ...a.args, idempotency_key: a.idempotencyKey, run_id: s.runId } }) });
  let r = await ctx.harness.turn(s.sessionId!, msg, { runId: s.runId, nodeId: a.kind === "safe" ? "N5" : "N7" });
  if (r.pendingApproval) {                                   // N6 — human checkpoint
    if (a.kind !== "destructive") throw new Error(`unexpected approval for safe tool ${a.tool}`);   // policy drift → fail loud
    const d = await ctx.approval.decide({ runId: s.runId, action: a, evidence: s.evidence, pending: r.pendingApproval, timeoutS: LIMITS.APPROVAL_TIMEOUT_S });
    ctx.log("N6", d.allow ? "approved" : "denied", { by: d.by, reason: d.reason });
    if (!d.allow) {
      await ctx.harness.approve(s.sessionId!, r.pendingApproval, false, d.reason);   // let the model see the denial
      return { actions: [{ ...a, status: "denied", decidedBy: d.by, decidedAt: d.at }], counters: { ...s.counters, replans: s.counters.replans + 1 } };
    }
    r = await ctx.harness.approve(s.sessionId!, r.pendingApproval, true);            // same turn resumes → tool executes
    a.decidedBy = d.by; a.decidedAt = d.at;
  }
  const result = ExecResult.safeParse(lastJsonBlock(r.text));                         // { ok, tool, result, note }
  return { actions: [{ ...a, status: result.success && result.data.ok ? "executed" : "failed", result: result.success ? result.data : r.text.slice(0, 500) }] };
};
```

`hush/src/approval.ts` — `ApprovalBridge` with two implementations selected by `HUSH_APPROVAL_MODE`:

- `terminal`: prints an approval card (root cause, blast radius from netbox
  evidence, exact tool + args, evidence ids) and reads `allow/deny [reason]`
  from stdin with a timeout; `by = "human:" + os.userInfo().username`.
- `ui`: prints "approve in TrueForge UI → session <id>" and polls
  `client.sessions.turns.list` / events until a `user.tool_approval` appears
  (human clicked Allow/Deny in the chat UI), then returns that decision. This is
  the mode for the demo video (approval card visible in the harness UI); `terminal`
  is the fallback if UI polling proves unreliable — decide at I2, keep both.

`hush/src/nodes/verify.ts` (N8): deterministic probes first (`Probes` reads
Alertmanager, mock-BMC `/chaos/status`, k8s `list_nodes` through the MCP server
or direct API), evaluate the recovered predicate from `graph.md` §4 every 15 s
until `VERIFY_TIMEOUT_S`; then one agentic turn (`verify.md`) to confirm with
tool reads and produce `{ recovered, summary, evidence }` for the report. Code
decides `recovered`; the model's answer is recorded but cannot override it
(log a `verify_disagreement` event if they differ — good blog material).

`hush/src/nodes/escalate.ts` (N9): prints a pager stub, sets `outcome: "escalated"`.

`hush/src/nodes/report.ts` (N10): renders `reports/<runId>.md`:

```
# Incident <runId> — <rootCause.kind> on <scope>        outcome: recovered|escalated
## Timeline            (ts · node · event)  from state.timeline
## Alerts              total / primary / symptoms / noise counts + table of primary
## Evidence            per layer, with `source: live|fallback`
## Actions             rank · tool · args · kind · status · decidedBy · decidedAt
## Harness trace       session id, turns, subagent threads (from events.jsonl), tool calls count, tokens if present
## Verification        predicate result + model summary
```

Also copies the sandbox-rendered `evidence.png` if the model produced one
(`GET .../download-a-file-from-the-turn-sandbox`). `hush resume <runId>` loads
`state.json` and re-enters `run()` at `state.node` — test this by killing
TrueForge (`Ctrl-C` the npx process) during N2, restarting it, and resuming:
the same session continues (persistent sessions demo).

Definition of done (needs I2 stack): `npm run incident -- --scenario hang` end
to end: drain executes without a prompt; `reset_system ForceRestart` pauses;
`deny` → agent replans (e.g. proposes `Nmi` or waits) and second attempt with
`allow` → node comes back Ready; report written; resume-after-restart works.

## B5 · Skill, Generative UI, README, Qodo evidence (≈ 1.5 h)

`skills/hush-triage/SKILL.md`:

```markdown
---
name: hush-triage
description: Runbook for correlating data-center alarm storms to one root cause and choosing safe vs approval-gated remediation (Redfish/Kubernetes/NetBox/Prometheus).
---
# Hush triage runbook
## Which layer answers which question
- "Is the node off or hung?" → only Redfish: PowerState + Oem.DCSentinel.Hung.
- "Is it one node or the room?" → FacilityAmbientHigh / inlet temps on many nodes ⇒ facility (CRAC).
- "Who is affected?" → NetBox tenants for the scoped rack/devices.
## Root-cause mapping (leading alert → kind)
FacilityAmbientHigh → crac_failure · HostHung → host_hang · PsuInputLost → psu_failure · isolated CpuTempCritical → thermal_single
## Remediation ladder
1. Always first: cordon + drain k8s nodes mapped to affected BMCs (safe).
2. crac_failure: GracefulShutdown nodes with cpu_temp ≥ 90 °C (destructive, approval) — protect hardware; leave cooler nodes running.
3. host_hang: ForceRestart the hung system (destructive, approval). If denied: propose Nmi for diagnostics, then re-propose restart with the new evidence.
4. After recovery: uncordon, silence residual alerts for 10 m with a comment naming the incident id.
## Never
Never call reset_system outside an explicitly listed action. Never retry a denied call with the same arguments. Never claim recovery without a fresh tool read.
```

`references/redfish-reset-types.md` in the same folder. Import in TrueForge
Settings → Skills from the public repo (pin `main`, path `skills/hush-triage`).

Generative UI: `system.md` asks for one incident card after N1 (root cause,
confidence, alert counts) and one thermal table/chart after N2; keep it to two
cards so the chat stays readable. Sandbox: after N2 the model writes
`evidence.png` (matplotlib, inlet+CPU temps from `prometheus.query_range`) —
this is the visible "sandboxed execution" beat.

`README.md` (a stranger can follow it — judged):

1. What Hush does (3 lines + `docs/architecture.svg` = graph from `graph.md` §1).
2. Prereqs (`tech-stack.md` §6). 3. `make up && make smoke`. 4. `npx @truefoundry/trueforge`, keys, `npm run register`, import skill.
5. Demo: `hush-chaos crac` → `npm run incident -- --scenario crac`; what you will see; where the approval appears.
6. Graph engineering: node/edge table (link to spec). 7. Repo layout. 8. Tests/CI.
9. **Qodo Code Review Evidence**: links to ≥ 2 merged PRs, 1–2 lines each on what Qodo found and what changed (keep a running list from PR #1).
10. Limits & non-goals. 11. Team + licence (MIT).

Definition of done: Person A follows README on their laptop from a clean clone
and reaches the approval card without asking Person B anything.

## B6 · Demo video + blog + submission (≈ 2 h, after I3)

`docs/demo-script.md` (~3 min, record with screen + voice; two windows: TrueForge UI left, terminal right):

| t | Beat | On screen |
|---|---|---|
| 0:00 | Problem in one sentence; "40 alarms, 1 root cause" | title card |
| 0:20 | `hush-chaos crac` → Alertmanager UI fills up | `localhost:9093` |
| 0:45 | `npm run incident` → N0 detects storm → N1 incident card in TrueForge chat (Generative UI) | chat |
| 1:10 | N2: three subagent threads spawn in parallel; sandbox renders `evidence.png` | chat threads + image |
| 1:40 | N3 plan card: drain (auto) vs GracefulShutdown (approval) | chat |
| 1:55 | drain runs, `kubectl get pods -w` shows rescheduling | terminal |
| 2:10 | **Approval card** for `reset_system GracefulShutdown R4-N04` → click Allow; SEL entry appears | chat + curl SEL |
| 2:35 | N8 verify: temps falling, alerts resolving; report opens | `reports/<id>.md` |
| 2:50 | Restart TrueForge mid-run earlier? (optional cut) + "harness did every call: 5 MCP servers, 3 subagents, 1 approval" | closing card |

`docs/blog.md` outline (Field Report; publish on dev.to/Medium/Hashnode, link in submission):
problem & market (BigPanda etc.) → why a mock BMC → the graph (diagram + node
table) → how TrueForge features map to nodes (approvals, subagents, sandbox,
sessions) → what broke (keep a `docs/troubleshooting-log.md` all day: every
error string + fix) → numbers from `events.jsonl` (turns, tool calls, tokens,
time-to-root-cause) → what we'd do next. Write sections during the build, not
at the end.

Submission checklist (form closes Sun 20:00 London): repo public; README Qodo
section; video link (unlisted YouTube); blog link; write-up paragraph; social
post tagging WeMakeDevs/TrueFoundry/Qodo (Radio Traffic); star trueforge repo
(Calling Card); no keys in repo/video (`gitleaks` green, scrub the video).

---

# Integration checkpoints

| Checkpoint | Preconditions | Script (20 min, both on a call) | Output |
|---|---|---|---|
| **I1** | A3 (alertmanager+redfish MCP, Prometheus rules), B2 (register + adapter) | B registers A's two servers; run `hush-chaos crac` (A5 may be partial: use `curl` to `/chaos/crac-failure`); B runs `--until N3` | `hush/test/fixtures/alerts_crac.json`, recorded events → `FakeHarness` fixture; list of prompt fixes |
| **I2** | A5, A4, B4 | full `hang` scenario with `ui` approval mode; then `crac`; kill/restart TrueForge once during N2 and `hush resume` | decide approval mode for demo; bug list, triaged by "blocks demo?" |
| **I3** | A6, B5 | dress rehearsal on **Person A's** laptop from a clean clone following README; time the run; record troubleshooting notes | go/no-go for recording; README fixes |

Parallel timeline (rough, both people):

```
A: A0 ── A1 ──── A2 ── A3 ────────┐I1┌── A4 ──── A5 ──────┐I2┌── A6 ──┐I3┌ support B6
B: B0 ── B1 ──────── B2 ──────────┘  └── B3 ── B4 ────────┘  └── B5 ──┘  └ B6 (video, blog, submit)
```

If behind schedule, cut in this order: Bright Data subagent → NetBox live
(use fallback only, say so) → `ui` approval mode (use `terminal`) → scenario A
(keep hung-node B: it has the approval beat) → resume-after-restart demo.
Never cut: Qodo PRs, README, approval gate, video.

---

# Submission requirements (from the hackathon page — all mandatory)

- Public GitHub repo; README a stranger can follow.
- TrueForge visibly doing agent work: real tool reach (MCP), sandbox code execution, human approval pause.
- Qodo installed; substantive changes via PRs reviewed by Qodo before merge; README "Qodo Code Review Evidence" links ≥ 1 representative merged PR.
- ~3-minute demo video; short write-up on the agent and how it uses TrueForge.
- No personal data, API keys, or private credentials in repo or video.
- Deadline: **Sunday Aug 30, 20:00 London**. Submit via the Google Form on the hackathon page.

Judging (equal weight): potential impact · creativity · technical excellence ·
use of sponsor tools (TrueForge central, Qodo integrated) · control & safety
(sandbox, approval before irreversible actions) · presentation.

# Open questions (resolve at first contact with the real thing; do not block)

1. Exact REST paths/verbs for create-or-replace MCP server and agent — read `/openapi.json` at B2.
2. Exact field names on `tool.approval_required` events and whether `sessions.createTurnStream` accepts `metadata` — record a real event in B0.
3. Whether a session created via SDK is visible/approvable in the TrueForge chat UI (`ui` approval mode) — test at I2; `terminal` mode is the fallback.
4. Whether `@read-only` tool filtering recognises FastMCP tools without annotations — if not, use explicit `enable_tools` lists (the names in `graph.md` §5).
5. Daytona availability at the venue — if no key, disable sandbox and skill for the run (`config.sandbox.enabled=false`), note it in README, keep the rest.
