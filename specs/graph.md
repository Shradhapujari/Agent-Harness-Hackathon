# Hush — Execution Graph & Tool Contracts

Graph-engineering spec. Source principles: explicit typed state, single-
responsibility nodes with output contracts, code-decided routing for known
rules, GPT-5.6-Luna only where interpretation is needed, human checkpoints as
first-class nodes, idempotent side effects, hard termination limits, and
`graph_id/run_id/node_id` on every log line and model/tool call.

Layering: prompt (instructions/skill) → context (per-node inputs, subagent
isolation) → loop (TrueForge turn = one agentic node's observe-reason-act) →
**graph (this file: topology, edges, state)**.

## 1. Topology

One graph per incident. `graph_id = "hush-incident"`, `run_id = inc-<yyyymmdd>-<4hex>`.
Node kinds: **D** deterministic code (controller), **A** agentic (one TrueForge
turn in the incident's persistent session; the harness makes every tool call),
**S** subagent fan-out (spawned by the agentic node via `create_sub_agent`),
**H** human checkpoint (TrueForge `tool.approval_required`), **J** join.

```
                 ┌──────────────┐
   Alertmanager  │ N0 watch (D) │  storm detector: ≥ STORM_MIN firing alerts in WINDOW_S
                 └──────┬───────┘
                        │ storm=true
                 ┌──────▼───────┐
                 │ N1 triage (A)│  calls correlate_alerts (D tool) → 1 incident + noise
                 └──────┬───────┘
          parse ok ─────┤──── parse fail ×2 → N9 escalate
                 ┌──────▼───────┐
                 │ N2 enrich (A)│ ── create_sub_agent ×3 ──► S1 redfish  ┐
                 │              │                            S2 netbox   ├─ J (harness waits)
                 └──────┬───────┘                            S3 k8s+prom ┘
                 ┌──────▼───────┐
                 │ N3 plan  (A) │  ranked actions, each tagged safe|destructive, evidence ids
                 └──────┬───────┘
                        │ for each action in rank order (max ACTIONS_MAX)
                 ┌──────▼───────┐
                 │ N4 route (D) │  safe → N5 · destructive → N6 · unknown tool → N9
                 └───┬──────┬───┘
            ┌────────▼┐  ┌──▼──────────────────────┐
            │N5 exec  │  │N6 approval (H)          │ tool.approval_required → allow/deny
            │safe (A) │  │ allow → N7 · deny → N3' │ (N3' = replan with denial reason, once)
            └────┬────┘  └──┬──────────────────────┘
                 │          │ allow
                 │     ┌────▼─────────┐
                 │     │N7 exec       │ same turn resumes with user.tool_approval
                 │     │destructive(A)│
                 │     └────┬─────────┘
            ┌────▼──────────▼───┐
            │ N8 verify (D + A) │  D: poll BMC/k8s/AM until recovered or VERIFY_TIMEOUT_S
            └────┬──────────────┘  A: one turn to confirm + summarise evidence
       recovered │            not recovered & attempts<2 → N3 (replan) · else → N9
            ┌────▼─────────┐        ┌────────────────┐
            │ N10 report(D)│◄───────│ N9 escalate (D)│  page human, write partial report
            └──────────────┘        └────────────────┘
```

Termination guarantees: `ACTIONS_MAX=4`, replan ≤ 2, parse retries ≤ 2,
verify attempts ≤ 2, TrueForge `iteration_limit=60` per turn, wall-clock
`RUN_TIMEOUT_S=900`. Any breach → N9 → N10. The graph always ends in N10.

Where the harness does the work: N1, N2, N3, N5, N7 and the verify summary
are TrueForge turns — every Alertmanager/Redfish/k8s/Prometheus/NetBox call
is an MCP tool call made by the model, subagents are TrueForge subagents,
the approval is TrueForge's approval, and the whole incident is one session
(restart TrueForge mid-run → controller reconnects to `session_id` and
continues from the checkpointed node).

## 2. State (single source of truth, `hush/src/state.ts`)

Checkpointed to `runs/<run_id>/state.json` after every node. Nodes receive
only the slice they need (no full-state prompts). All timestamps ISO-8601 UTC.

```ts
import { z } from "zod";

export const Alert = z.object({
  fingerprint: z.string(),
  name: z.string(),                       // labels.alertname
  severity: z.enum(["critical", "warning", "info"]),
  labels: z.record(z.string()),           // must include layer, and node|rack when known
  startsAt: z.string(),
  status: z.enum(["firing", "resolved"]),
});

export const Incident = z.object({
  id: z.string(),                          // "inc-…" == run_id
  rootCause: z.object({
    kind: z.enum(["crac_failure", "host_hang", "psu_failure", "thermal_single", "unknown"]),
    scope: z.object({ rack: z.string().optional(), nodes: z.array(z.string()) }),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(600),
  }),
  primary: z.array(z.string()),            // alert fingerprints that ARE the root cause
  symptoms: z.array(z.string()),           // caused by root cause
  noise: z.array(z.string()),              // unrelated / flapping
});

export const Evidence = z.object({
  id: z.string(),                          // "ev-redfish-1"
  layer: z.enum(["redfish", "netbox", "kubernetes", "prometheus", "web"]),
  summary: z.string().max(300),
  data: z.unknown(),                       // raw tool result (trimmed)
  source: z.enum(["live", "fallback"]).default("live"),
});

export const Action = z.object({
  id: z.string(),                          // "act-1"
  rank: z.number().int(),
  kind: z.enum(["safe", "destructive"]),
  tool: z.string(),                        // e.g. "kubernetes.drain_node" | "redfish.reset_system"
  args: z.record(z.unknown()),
  idempotencyKey: z.string(),
  reason: z.string().max(300),
  evidence: z.array(z.string()),           // Evidence.id refs
  status: z.enum(["proposed", "approved", "denied", "executed", "failed", "skipped"]).default("proposed"),
  decidedBy: z.string().optional(),        // "human:<name>" | "policy:safe"
  decidedAt: z.string().optional(),
  result: z.unknown().optional(),
});

export const RunState = z.object({
  graphId: z.literal("hush-incident"),
  runId: z.string(),
  runStartedAt: z.string().optional(),       // immutable UTC start; preserves RUN_TIMEOUT_S across resume
  sessionId: z.string().optional(),        // TrueForge session, set in N1
  pendingActionId: z.string().optional(),   // action selected by N4 for N5/N6/N7 routing
  scenarioHint: z.string().optional(),     // CLI only; never shown to the model
  node: z.enum(["N0","N1","N2","N3","N4","N5","N6","N7","N8","N9","N10","DONE"]),
  alerts: z.array(Alert),
  incident: Incident.optional(),
  evidence: z.array(Evidence),
  actions: z.array(Action),
  counters: z.object({ replans: z.number(), parseRetries: z.number(), verifyAttempts: z.number() }),
  timeline: z.array(z.object({ ts: z.string(), nodeId: z.string(), event: z.string(), detail: z.unknown().optional() })),
  outcome: z.enum(["recovered", "escalated", "aborted"]).optional(),
});
export type RunState = z.infer<typeof RunState>;
```

Merge rule: nodes return a `Partial<RunState>`; arrays `evidence`, `actions`,
`timeline` are appended by id (dedupe), scalars overwrite. Only the controller
writes state; the model never sees `scenarioHint`.

## 3. Node contracts

Each node: responsibility · reads · writes · tools allowed · limits · success evidence.

| Node | Kind | Reads | Writes | Tools / model | Limits | Success evidence |
|---|---|---|---|---|---|---|
| N0 watch | D | Alertmanager `/api/v2/alerts` (controller HTTP) | `alerts`, `runId`, `timeline` | none | poll 5 s; STORM_MIN=15 firing in WINDOW_S=120 | `alerts.length ≥ STORM_MIN` |
| N1 triage | A | `alerts` (fingerprint, name, severity, labels, startsAt) | `sessionId`, `incident` | `alertmanager.*`, `correlate.correlate_alerts` | 1 turn; JSON parse retry ≤ 2 | `Incident` schema valid, `primary.length ≥ 1` |
| N2 enrich | A + S | `incident` | `evidence[]` | subagents each get **one** server: S1 `redfish.*`, S2 `netbox.*`, S3 `kubernetes.get_*` + `prometheus.*` (+ optional S4 `brightdata.*`) | 1 turn; ≥ 3 subagents; each ≤ 8 tool calls (instructions) | ≥ 1 evidence per layer redfish/netbox/kubernetes |
| N3 plan | A | `incident`, `evidence` summaries, prior `actions` with `denied` reasons | `actions[]` (ranked) | no tools (reasoning only; `skills` runbook) | 1 turn; ACTIONS_MAX=4 | every action has ≥ 1 evidence ref, valid tool name from registry |
| N4 route | D | next `proposed` action | — | none | — | `kind` decided by **registry**, not by the model (see §5 policy) |
| N5 exec safe | A | one action | `actions[i].status/result` | `kubernetes.cordon_node`, `kubernetes.drain_node`, `kubernetes.uncordon_node` | 1 turn; 1 tool call expected | tool result `ok=true` |
| N6 approval | H | pending `tool.approval_required` event | `actions[i].decidedBy/decidedAt/status` | TrueForge approval on `redfish.reset_system` | APPROVAL_TIMEOUT_S=600 → deny | `user.tool_approval` recorded with human id |
| N7 exec destructive | A | resumed turn | `actions[i].result` | `redfish.reset_system` (approved call only) | same turn as N6 | SEL shows `PowerStateChange` after call |
| N8 verify | D + A | `incident.scope`, `actions` | `timeline`, `outcome?` | D: controller polls BMC/k8s/AM; A: `redfish.get_thermal`, `kubernetes.get_node`, `alertmanager.list_alerts` | VERIFY_TIMEOUT_S=180, attempts ≤ 2 | recovered predicate (§4) true |
| N9 escalate | D | state | `outcome=escalated`, `timeline` | none (prints pager stub) | — | always succeeds |
| N10 report | D | full state + TrueForge session events | `reports/<runId>.md`, `runs/<runId>/events.jsonl` | `client.sessions.events.list` | — | file exists, contains timeline + approvals table |

Per-turn model contract (N1, N2, N3, N5, N8-A): the turn's user message ends with
`Respond with a single fenced json block matching: <schema>`; the controller
extracts the last ```json block and validates with zod. Invalid → retry the
same turn with the validation error appended (edge E1b), max 2.

Subagent contract (N2): root agent must call `create_sub_agent` three times
in one model message (parallel), each with instructions of the form:

```
You are the <LAYER> enricher for incident <id>. Root-cause hypothesis: <kind> on <scope>.
Use ONLY <server>.* tools. Gather: <layer-specific list>. Max 8 tool calls.
Return: {"layer": "<layer>", "summary": "<≤300 chars>", "findings": [ {"node": ..., "metric": ..., "value": ...} ], "raw_refs": [...] }
```

Layer-specific lists: redfish → PowerState, Hung flag, inlet+CPU temp, PSU
health, last 5 SEL entries per scoped node (cap 12 nodes → summarise);
netbox → rack, site, tenants, device roles for scoped nodes, count of
affected tenants; kubernetes+prometheus → node Ready conditions, pods on
scoped nodes, `range` of `hush_inlet_temp_celsius` over last 10 m.

## 4. Edges (enabling condition · decided by · on rejection)

| Edge | From → To | Condition | Decided by | On rejection / failure |
|---|---|---|---|---|
| E0 | N0 → N1 | `firing ≥ STORM_MIN` within `WINDOW_S` | code | keep polling; log every 30 s |
| E1a | N1 → N2 | `Incident` parses and `primary.length ≥ 1` | code (zod) | — |
| E1b | N1 → N1 | parse error, `parseRetries < 2` | code | append error to next message |
| E1c | N1 → N9 | parse error, retries exhausted | code | escalate with raw alerts |
| E2 | N2 → N3 | ≥ 1 evidence for redfish, netbox, kubernetes (netbox may be `fallback`) | code | missing layer → one retry turn asking only for that layer; then continue with `source: "fallback"` note |
| E3 | N3 → N4 | `actions.length ∈ [1, ACTIONS_MAX]`, all tool names ∈ registry | code | unknown tool → strip action, log; empty → N9 |
| E4a | N4 → N5 | `registry[tool].kind == "safe"` | **code (registry)** | — |
| E4b | N4 → N6 | `registry[tool].kind == "destructive"` | **code (registry)** | — |
| E6a | N6 → N7 | human `allow` | **human** | — |
| E6b | N6 → N3 | human `deny` and `replans < 2` | human + code | replan message includes `denied: <tool> <args> reason=<reason>`; the same `(tool,args)` pair is blacklisted for this run |
| E6c | N6 → N9 | deny with replans exhausted, or approval timeout | code | escalate |
| E5/E7 | N5/N7 → N4 | more `proposed` actions remain | code | tool `ok=false` → mark `failed`, continue to next action |
| E7b | N5/N7 → N8 | no proposed actions remain | code | — |
| E8a | N8 → N10 | recovered predicate true | code | — |
| E8b | N8 → N3 | not recovered, `verifyAttempts < 2` | code | replan with verify findings |
| E8c | N8 → N9 | not recovered, attempts exhausted, or `RUN_TIMEOUT_S` | code | — |
| E9 | N9 → N10 | always | code | — |

Recovered predicate (deterministic, `hush/src/nodes/verify.ts`):

```ts
// crac_failure: all scoped nodes PowerState=="Off" OR cpu_temp < 85 and falling (two samples 15 s apart)
// host_hang:    node PowerState=="On" && Hung==false && k8s node Ready==True
// any kind:     no *firing* alert in incident.primary ∪ incident.symptoms (Alertmanager)
```

Routing principle: the model *proposes* an action's kind, but N4 overrides it
from the tool registry. A model can never downgrade a destructive tool to
"safe" — the approval is enforced twice: by TrueForge (`require_approval_for_tools`)
and by the graph (N6 is the only path to N7).

## 5. MCP tool contracts (interface between Person A and Person B)

Five remote MCP servers, streamable-http, registered in TrueForge by name.
All tools return JSON; errors as `{"error": {"code": str, "message": str}}`.
Every side-effecting tool takes `idempotency_key: str`.

### `alertmanager` — http://127.0.0.1:9101/mcp  (read-only + silence)

| Tool | Params | Returns |
|---|---|---|
| `list_alerts` | `active: bool=true, filter: list[str]=[]` (AM matchers e.g. `["rack=R4"]`) | `{alerts: [Alert]}` (schema §2, ≤ 200 items) |
| `get_alert_groups` | — | `{groups: [{labels, alerts: [fingerprint]}]}` |
| `silence_alerts` | `matchers: list[str], duration_s: int, comment: str, idempotency_key` | `{silence_id}` — *write* (used after recovery, not gated) |

### `correlate` — served by the same process as `alertmanager` (tool list above +)

| Tool | Params | Returns |
|---|---|---|
| `correlate_alerts` | `alerts: [Alert], window_s: int=120` | `{clusters: [{key: {rack?, node?}, layer_counts, first_seen, last_seen, fingerprints, leading_alert}], noise: [fingerprint]}` |

Pure function in `mcp/hush_mcp/correlate.py`: group by `(rack, node)` derived
from labels, bucket by `startsAt` within `window_s`, order clusters by size
then earliest `first_seen`, mark single-alert clusters that flap (`resolved`
then `firing`) as noise. Unit-tested with fixtures for scenario A and B. The
GPT-5.6-Luna decides *what kind of* root cause the leading cluster is; code decides the
grouping.

### `redfish` — http://127.0.0.1:9102/mcp

| Tool | Params | Returns | Kind |
|---|---|---|---|
| `list_systems` | — | `{systems: [id]}` | read |
| `get_system` | `system_id` | `{id, power_state, health, hung, rack, cpu_load_pct}` | read |
| `get_thermal` | `system_id` | `{inlet_c, cpu_c, fan_rpm, cpu_health}` | read |
| `get_power` | `system_id` | `{watts, psu: [{name, ok, watts}]}` | read |
| `get_sel` | `system_id, last: int=10` | `{entries: [{id, created, severity, code, message}]}` | read |
| `get_fleet_summary` | — | `{nodes: [{id, power_state, hung, inlet_c, cpu_c, health}]}` (from `/chaos/status`, read-only) | read |
| `reset_system` | `system_id, reset_type: "On"|"GracefulShutdown"|"ForceOff"|"GracefulRestart"|"ForceRestart", reason, idempotency_key` | `{ok, system_id, reset_type, sel_entry_id}` | **destructive** (`require_approval_for_tools`) — `On` is allowed without approval by policy but still routed through this tool |

### `kubernetes` — http://127.0.0.1:9103/mcp

| Tool | Params | Returns | Kind |
|---|---|---|---|
| `list_nodes` | — | `{nodes: [{name, ready, unschedulable, bmc_id}]}` (bmc_id from node label `hush.io/bmc`) | read |
| `get_node` | `name` | node conditions + labels | read |
| `list_pods` | `node: str|None, namespace: str="demo"` | `{pods: [{name, node, phase, restarts}]}` | read |
| `cordon_node` | `name, idempotency_key` | `{ok}` | safe |
| `drain_node` | `name, grace_s: int=30, idempotency_key` | `{ok, evicted: [pod]}` | safe (evicts demo pods; ignores DaemonSets) |
| `uncordon_node` | `name, idempotency_key` | `{ok}` | safe |

### `prometheus` — http://127.0.0.1:9104/mcp (read-only)

| Tool | Params | Returns |
|---|---|---|
| `query` | `promql: str` | instant vector (trimmed to ≤ 50 series) |
| `query_range` | `promql, minutes: int=10, step_s: int=30` | series with `[ts, value]` (≤ 20 series × 40 points) |
| `list_rules` | — | rule names + state |

Metric names exported by mock-bmc `/metrics`: `hush_inlet_temp_celsius{system}`,
`hush_cpu_temp_celsius{system}`, `hush_fan_percent{system}`,
`hush_power_watts{system}`, `hush_psu_ok{system,psu}`, `hush_power_on{system}`,
`hush_host_hung{system}`, `hush_thermal_trip{system}`.

### `netbox` — http://127.0.0.1:9105/mcp (read-only, D3)

| Tool | Params | Returns |
|---|---|---|
| `get_device` | `name` | `{name, rack, site, role, tenant, model, serial, source}` |
| `list_rack_devices` | `rack` | `{rack, devices: [...], tenants: [...], source}` |
| `get_blast_radius` | `nodes: list[str]` | `{racks, tenants: [{name, devices}], device_count, source}` |

`source` is `"live"` or `"fallback"` (seed.json) — always surfaced in evidence.

### Tool registry (Person B, `hush/src/registry.ts`) — the routing authority

```ts
export const REGISTRY: Record<string, { kind: "safe" | "destructive" | "read"; server: string }> = {
  "kubernetes.cordon_node":   { kind: "safe", server: "kubernetes" },
  "kubernetes.drain_node":    { kind: "safe", server: "kubernetes" },
  "kubernetes.uncordon_node": { kind: "safe", server: "kubernetes" },
  "alertmanager.silence_alerts": { kind: "safe", server: "alertmanager" },
  "redfish.reset_system":     { kind: "destructive", server: "redfish" },
};
// anything else proposed by the model is rejected at E3
```

## 6. TrueForge agent spec (`hush/agent.json`, applied by `scripts/register.ts`)

```json
{
  "name": "hush-operator",
  "manifest": {
    "model": { "name": "openai/gpt-5.6-luna", "params": { "max_tokens": 8192, "temperature": 0.1, "parallel_tool_calls": true } },
    "instructions": "<contents of hush/prompts/system.md>",
    "config": {
      "iteration_limit": 60,
      "sandbox": { "enabled": true, "file_downloads": true },
      "ask_user_questions": { "enabled": false },
      "dynamic_sub_agents": { "enabled": true },
      "generative_ui": { "enabled": true },
      "context_management": {
        "compaction": { "enabled": true, "trigger": { "type": "input_tokens", "value": 80000 } },
        "large_tool_response": { "enabled": true }
      }
    },
    "mcp_servers": [
      { "name": "alertmanager", "enable_tools": ["@all"], "require_approval_for_tools": [], "preload": true },
      { "name": "redfish",      "enable_tools": ["@all"], "require_approval_for_tools": ["reset_system"], "preload": true },
      { "name": "kubernetes",   "enable_tools": ["@all"], "require_approval_for_tools": [], "preload": false },
      { "name": "prometheus",   "enable_tools": ["@read-only"], "require_approval_for_tools": [], "preload": false },
      { "name": "netbox",       "enable_tools": ["@read-only"], "require_approval_for_tools": [], "preload": false }
    ],
    "skills": [ { "name": "hush-triage" } ]
  }
}
```

`hush/prompts/system.md` (≤ 60 lines) states: role; the five layers and which
tool answers which question ("only the BMC can tell hung vs off"); the JSON
output rule; the subagent fan-out rule for enrichment; "never call
`reset_system` unless the current step explicitly lists it as the approved
action"; "if a tool call is denied, do not retry it; propose an alternative";
"use the sandbox to render `evidence.png` (inlet/CPU temps over time) once per
incident and show a Generative UI card with root cause, blast radius, actions".

Per-node user messages live in `hush/prompts/{triage,enrich,plan,exec,verify}.md`
as templates with `{{placeholders}}`; each ends with the JSON schema for that node.

Observability: the controller sets `metadata: { graph_id, run_id, node_id }`
on every `sessions.createTurnStream` call (if the SDK exposes a metadata
field; otherwise prefixes the user message with a one-line `[hush run_id=… node=…]`
tag) and writes every SSE event to `runs/<run_id>/events.jsonl`. Restart
recovery: `runs/<run_id>/state.json` holds `sessionId` + `node`; `hush resume <run_id>`
re-enters the graph at that node and continues in the same session
(`previous_turn_id: "auto"`).
