# AGENTS.md — Hush hackathon project

## Operating principles

These rules apply to every coding agent. They are intentionally short and
project-specific: prefer a reliable, reviewable demo over speculative polish.

1. **Think before coding.** Read the relevant spec and existing implementation
   first. State material assumptions and tradeoffs; do not silently choose among
   meaningfully different interpretations.
2. **Simplicity first.** Implement the smallest change that meets the stated
   acceptance criteria. Do not add frameworks, configuration knobs, abstractions,
   or edge-case handling without a concrete use in this demo.
3. **Make surgical changes.** Touch only files required for the task. Preserve
   existing style and ownership boundaries. Mention unrelated issues; do not
   refactor or delete them. Every changed line must trace to the request or a
   locked project decision.
4. **Execute to a verifiable goal.** For multi-step work, identify concise
   success checks, run the relevant checks after editing, and report what was
   verified versus what requires credentials, cloud access, or human review.

## Repository orientation

- **Product:** Hush, an autonomous data-center triager/operator. The old brief
  calls it DC-Sentinel; new code and docs use Hush.
- **Source of truth:** `specs/mission.md` defines scope, `specs/tech-stack.md`
  defines locked technology choices, `specs/graph.md` defines state/graph/tool
  contracts, and `specs/roadmap.md` defines sequencing and ownership.
- **Ownership:** Person A owns `mock-bmc/`, infrastructure, chaos, and MCP
  servers. Person B owns `hush/`, harness integration, CI/Qodo, and demo/blog.
  The MCP contracts in `specs/graph.md` are the integration boundary.
- **Work sequence:** Complete B0 before B1, then B2. Do not build around
  guessed TrueForge API fields; record a real B0 event before typing the adapter.

## Safety and demo invariants

- Never put API keys, tokens, local SQLite data, run logs, or generated reports
  in Git. Use `.env.example` only for variable names and safe placeholders.
- Keep node logic deterministic and unit-testable; isolate network and harness
  I/O behind interfaces.
- Every destructive Redfish action (`reset` or `shutdown`) requires the harness
  approval gate. Kubernetes is limited to cordon, drain, uncordon, and
  reschedule; NetBox is read-only.
- Side-effecting MCP calls require idempotency keys. Keep structured logs keyed
  by graph, run, node, and session IDs.

## Tooling rules

- **Large file writes must be chunked.** Write a skeleton with insertion markers,
  replace each marker in small edits (about 8 KB or less), then verify no marker
  remains and inspect the resulting structure.
- Verify generated files after the final edit (size plus an appropriate structure
  check). Do not hand-edit generated lockfiles.
- Use the local toolchain: Python 3.12 with `uv`; TypeScript ESM/strict with npm.
  Run the narrowest relevant test/lint/build commands before handoff.
- One roadmap phase per branch and PR. Branch each new phase from the latest
  `origin/main` only after its predecessor merges (for example,
  `feat/person-b-b0`, then `feat/person-b-b1`). Use Conventional Commits. Qodo
  must review every substantive PR; address High findings before merge and
  record the result in the PR template.

## Project decisions (locked, see hackathon-brief.html §7 Decision Log)

- D1: Skip Ignition SCADA → alarm-bus pattern (Alertmanager). Closed.
- D2: Custom mock BMC (FastAPI/Redfish) over DMTF static mockup. Closed.
- D3: NetBox read-only. Closed.
- D4: k8s actions = drain/cordon/reschedule only; destructive ops go through
  approval gate in Redfish layer. Closed.

## Stack summary

- kind (k8s 3-node) + Prometheus + Alertmanager + custom Redfish BMC + NetBox (read)
- Agent: harness MCP tools, subagents (correlate/classify/enrich), approval gates
- Qodo on every PR from first commit (Code Quality track requirement)
