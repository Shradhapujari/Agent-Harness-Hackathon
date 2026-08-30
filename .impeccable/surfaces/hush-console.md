# Hush Local Incident Console

## Mode

Operate

## Task

Trigger one documented mock fault, watch the existing Hush graph work end to end, understand its evidence and proposed effects, and decide a destructive action from the same local surface.

## Important States

- Local services unavailable or partially ready
- No incident / nominal baseline
- Fault injected while Alertmanager forms the storm
- Agent graph progressing through N0–N10
- Evidence and action records accumulating
- Exact destructive action awaiting approval
- Denied action replanning
- Recovered, escalated, or failed run

## Success Check

A reviewer can identify service readiness, current graph node, root cause, evidence provenance, planned and completed actions, human decision, and final outcome within one screen flow.

## Direction

Use the incident-observatory world in `DESIGN.md`. The signal field is dominant, the relay is chronological, and approval is the only interruptive surface.
