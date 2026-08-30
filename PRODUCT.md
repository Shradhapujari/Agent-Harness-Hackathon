# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are data-center operators and hackathon reviewers running Hush locally. They need to create a repeatable incident, understand what the agent is doing, and make the one safety-critical human decision without switching among several opaque tools. This is inferred from the repository mission, demo script, and the requested local UI.

## Product Purpose

Hush turns a noisy infrastructure alarm storm into one evidence-backed incident, gathers cross-layer evidence, proposes remediation, executes safe actions, pauses before destructive Redfish actions, verifies recovery, and leaves an audit trail. Success in this surface means a reviewer can follow that entire story end to end and can clearly tell simulation, agent reasoning, tool execution, and human authority apart.

## Positioning

Hush combines deterministic safety policy with an agentic investigation: code owns action classification and recovery checks, while the agent correlates, enriches, and plans across infrastructure systems.

## Operating Context

The product is demonstrated on a local machine against a simulated rack, Alertmanager, Prometheus, Kubernetes, MCP tools, and the TrueForge harness. The repeatable scenarios are a hung Kubernetes host and a rack-wide CRAC cooling failure. Operators need a live incident timeline, evidence, proposed actions, approval details, and final outcome.

## Capabilities and Constraints

- Trigger only the existing mock-BMC chaos scenarios and use their documented request fields.
- Start and observe the existing Hush incident graph; do not introduce a second orchestration model.
- Make every Redfish reset or shutdown decision explicit and human-controlled.
- Show structured records keyed by graph, run, node, and session IDs.
- Keep side-effecting calls idempotent and NetBox read-only.
- The local console may expose unavailable-service and demo-empty states, but must not portray synthetic fallback data as live evidence.
- Exact TrueForge event fields remain governed by recorded B0 fixtures; the UI must not guess them.

## Brand Commitments

The product name is Hush. Its voice is calm, precise, and operational: noisy infrastructure is reduced to one legible incident without minimizing risk.

## Evidence on Hand

The repository contains the mission and acceptance criteria in `specs/mission.md`, graph and state contracts in `specs/graph.md`, locked stack choices in `specs/tech-stack.md`, implementation sequencing in `specs/roadmap.md`, the TypeScript graph runner in `hush/src`, and real chaos endpoints in `mock-bmc/app/chaos.py`. No customer claims or production deployment evidence is available and none should be fabricated.

## Product Principles

- Make the incident understandable before making it impressive.
- Keep human authority unmistakable at the destructive boundary.
- Distinguish observed evidence, model interpretation, and executed effects.
- Prefer a repeatable local demonstration over speculative production breadth.
- Preserve the audit trail from alarm to outcome.

## Accessibility & Inclusion

The console must be keyboard operable, retain visible focus, avoid color-only status communication, respect reduced-motion preferences, and remain usable from laptop through narrow mobile widths.
