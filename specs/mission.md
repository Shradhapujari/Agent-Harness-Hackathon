# Hush — Mission

> Project name: **Hush** (formerly "DC-Sentinel" in `hackathon-brief.html` / `AGENTS.md`; the brief keeps the old name, the code uses `hush`).

> 40 alarms in → 1 root cause out → 0 humans paged → 1 approval before anything irreversible.

## 1. Problem

One physical failure in a data center (CRAC cooling unit dies, host OS hangs, PSU
drops) never produces one alert. It produces a cascade across independent
monitoring layers: BMC/Redfish sensors, Prometheus rules, Kubernetes node/pod
state, tenant-facing app errors. A NOC engineer sees 40+ alarms that are really
one root cause and must correlate them by hand under time pressure.

Existing products (BigPanda, Moogsoft, PagerDuty AIOps) stop at "here is the
probable root cause". A human still drains the node, checks the BMC, and
power-cycles the server.

## 2. What we build

Hush is an **autonomous triager-operator agent** running on the
TrueForge agent harness. Per incident it:

1. Ingests the live alarm stream (Alertmanager).
2. Correlates it down to one root cause (deterministic grouping + LLM classification).
3. Enriches across three layers in parallel via subagents: hardware (Redfish),
   inventory (NetBox), orchestration/metrics (Kubernetes, Prometheus).
4. Proposes ranked remediation actions with an explicit evidence chain.
5. Executes safe actions automatically (cordon/drain/reschedule).
6. **Pauses at a human approval gate** before any destructive action
   (power-cycle, shutdown).
7. Verifies recovery and writes an incident report with the full timeline.

Every step is a node in an explicit execution graph (see `specs/graph.md`).
The harness does the reasoning and every tool call; the graph gives it
typed state, edge contracts, termination limits, and an audit trail.

## 3. Demo scenarios (exactly two)

| # | Scenario | Root cause | Auto action | Approval-gated action |
|---|---|---|---|---|
| A | CRAC failure cascade | Rack R4 cooling lost; inlet 22→36 °C on 12 nodes; hottest nodes thermal-trip | cordon + drain hottest nodes, reschedule pods | `GracefulShutdown` of nodes above 90 °C to prevent thermal damage |
| B | Hung node | `R4-N04` OS hung; BMC says `PowerState=On`, `Hung=true` | cordon node, reschedule pods | `ForceRestart` of `R4-N04` via Redfish |

Both scenarios are fired by one chaos command and are deterministic and repeatable.

## 4. Success criteria (what "done" means)

Functional:

- [ ] `chaos crac` produces ≥ 40 firing alerts in Alertmanager within 90 s.
- [ ] Agent produces exactly one incident with one root cause; ≥ 90 % of alerts tagged as symptom/noise of that incident.
- [ ] Agent spawns ≥ 3 subagents (redfish / netbox / k8s+prom) in parallel during enrichment.
- [ ] Safe action (drain) executes without approval; destructive Redfish reset **cannot** execute without a recorded human `allow`.
- [ ] Deny path works: a denied action is logged and the agent proposes an alternative, never retries the same call.
- [ ] Verification node confirms recovery (temps falling / node `Ready`) and alerts resolved.
- [ ] Incident report (`reports/<run_id>.md`) contains: timeline, evidence per layer, actions with approver + timestamp.
- [ ] Session survives a TrueForge restart mid-incident and resumes from the last node.

Hackathon requirements (all mandatory for submission, see `specs/roadmap.md` §Submission):

- [ ] Public repo, README a stranger can follow to run the full demo on macOS.
- [ ] Every substantive change lands via a PR reviewed by Qodo; README has a "Qodo Code Review Evidence" section linking ≥ 1 merged PR.
- [ ] ~3-minute demo video showing: alarm flood → subagents → approval card → power-cycle → recovery.
- [ ] Blog post published (Field Report track).
- [ ] No keys or personal data in the repo or video.

## 5. Prize-track mapping

| Track | What judges look for | Where we hit it |
|---|---|---|
| Double-O — Best use of TrueForge (DGX Spark) | harness does the work: MCP tools, sandbox, approvals, subagents, persistent sessions | 5 MCP servers; `require_approval_for_tools` on Redfish reset; `create_sub_agent` fan-out for enrichment; sandbox runs the evidence-plotting script; one persistent session per incident |
| Q Branch — Code quality (Mac Mini) | hackathon repo treated like real software; Qodo reviewed PRs | typed Python + TS, pure/deterministic correlation with tests, CI (ruff/mypy/pytest/eslint/tsc/vitest), Qodo on every PR from PR #1 |
| Savile Row — Best UI (iPad) | a stranger can drive it; approval gates visible | TrueForge chat UI + Generative UI incident card/thermal table; approval Allow/Deny card is the centerpiece |
| Field Report — Blog (Keychron) | problem, solution, harness usage, lessons | `docs/blog.md` drafted during build from the run log |
| Bright Data (AirPods) — optional stretch | live web data that survives site changes | enricher subagent pulls vendor thermal-spec page for the node model via Bright Data MCP; degrade gracefully if absent |

A team can win only one track; we submit to all and let judges pick.

## 6. Non-goals (say no)

- Real Ignition/SCADA integration (decision D1).
- NetBox writes (D3). Multi-rack topology, > 2 scenarios, real thermal physics.
- A bespoke web dashboard beyond TrueForge UI + Generative UI cards.
- k8s actions beyond cordon/drain/uncordon (D4). Destructive ops only via Redfish behind approval.

## 7. Team

Two people, two laptops, both run the full stack locally. Work is split by
layer (see `specs/roadmap.md`): **Person A** owns the simulated data center
and the MCP tool servers; **Person B** owns the agent, the execution graph,
CI/Qodo, and the demo/blog. Integration checkpoints are defined so neither
blocks the other; MCP tool contracts in `specs/graph.md` are the interface.
