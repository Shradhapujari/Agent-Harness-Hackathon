import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { saveCheckpoint } from "./checkpoint.js";
import { EDGES } from "./edges.js";
import { merge, type Ctx, type NodeId } from "./graph.js";
import { createLogger } from "./log.js";
import { enrich } from "./nodes/enrich.js";
import { plan } from "./nodes/plan.js";
import { triage } from "./nodes/triage.js";
import { watch } from "./nodes/watch.js";
import type { RunState } from "./state.js";
import { createHarness } from "./trueforge.js";

export type IncidentOptions = {
  scenario?: "crac" | "hang";
  until: "N3";
};

const B3_NODES = { N0: watch, N1: triage, N2: enrich, N3: plan } as const;

function initialState(
  now: Date,
  scenario?: IncidentOptions["scenario"]
): RunState {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    graphId: "hush-incident",
    runId: `inc-${date}-0000`,
    node: "N0",
    scenarioHint: scenario,
    alerts: [],
    evidence: [],
    actions: [],
    counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
    timeline: []
  };
}

export async function runIncident(
  options: IncidentOptions,
  write: (value: unknown) => void = console.log
): Promise<RunState> {
  let state = initialState(new Date(), options.scenario);
  let context: Ctx = {
    harness: {},
    approval: {},
    probes: {},
    clock: () => new Date(),
    log: () => undefined
  };

  while (state.node in B3_NODES) {
    const node = state.node as keyof typeof B3_NODES;
    if (node !== "N0" && !("turn" in context.harness)) {
      const eventsPath = `runs/${state.runId}/events.jsonl`;
      mkdirSync(dirname(eventsPath), { recursive: true });
      const harness = await createHarness((event) => {
        appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      });
      context = {
        ...context,
        harness: harness as unknown as Ctx["harness"],
        log: createLogger(state.graphId, state.runId, state.sessionId)
      };
    }

    state = merge(state, await B3_NODES[node](state, context));
    const completed = node;
    if (completed === options.until) {
      await saveCheckpoint(state);
      break;
    }
    state = { ...state, node: EDGES[completed](state) as NodeId };
    await saveCheckpoint(state);
  }

  write({
    runId: state.runId,
    incident: state.incident,
    evidence: state.evidence,
    actions: state.actions
  });
  return state;
}
