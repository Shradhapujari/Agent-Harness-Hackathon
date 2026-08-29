# AGENTS.md — stealth (hackathon project)

## Tooling rules (agent behavior)

- **Large file writes must be chunked.** Never emit one huge Write call for a big
  HTML/markdown file — it can stall/abort. Pattern:
  1. `Write` skeleton with HTML comments as insertion markers (e.g. `<!-- PART1 -->`)
  2. Sequential `Edit` calls replacing each marker (keep each call small, ~≤8KB)
  3. Verify with grep for leftover markers + `<h2>` listing
- Verify any generated file after final edit (size + structure grep).

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
