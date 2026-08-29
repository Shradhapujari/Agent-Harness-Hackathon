import { EDGES } from "./edges.js";
import { LIMITS, merge, type Ctx, type NodeFn } from "./graph.js";
import { enrich } from "./nodes/enrich.js";
import { plan } from "./nodes/plan.js";
import { triage } from "./nodes/triage.js";
import { watch } from "./nodes/watch.js";
import type { RunState } from "./state.js";
import type { HarnessClient } from "./trueforge.js";

export type IncidentOptions = {
  scenario?: "crac" | "hang";
  until: "N3";
};

export type IncidentDependencies = {
  clock: () => Date;
  createHarness: (runId: string) => Promise<HarnessClient>;
  save: (state: RunState) => Promise<void>;
  log: (state: RunState) => Ctx["log"];
  loadPrompt: NonNullable<Ctx["loadPrompt"]>;
  runWithTimeout: <T>(
    operation: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ) => Promise<T | undefined>;
  nodes?: Partial<Record<"N0" | "N1" | "N2" | "N3", NodeFn>>;
};

const DEFAULT_NODES = { N0: watch, N1: triage, N2: enrich, N3: plan } as const;

function initialState(
  now: Date,
  scenario?: IncidentOptions["scenario"]
): RunState {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    graphId: "hush-incident",
    runId: `inc-${date}-0000`,
    runStartedAt: now.toISOString(),
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
  dependencies: IncidentDependencies,
  write: (value: unknown) => void = console.log
): Promise<RunState> {
  let state = initialState(dependencies.clock(), options.scenario);
  const nodes = { ...DEFAULT_NODES, ...dependencies.nodes };
  let harness: HarnessClient | undefined;

  while (state.node in nodes) {
    const remaining =
      LIMITS.RUN_TIMEOUT_S * 1000 -
      (dependencies.clock().getTime() - Date.parse(state.runStartedAt!));
    if (remaining <= 0) {
      state = merge(state, {
        node: "N9",
        outcome: "escalated",
        timeline: [
          {
            ts: dependencies.clock().toISOString(),
            nodeId: state.node,
            event: "run_timeout"
          }
        ]
      });
      await dependencies.save(state);
      break;
    }

    const node = state.node as keyof typeof nodes;
    if (node !== "N0" && harness === undefined)
      harness = await dependencies.createHarness(state.runId);
    const controller = new AbortController();
    const context: Ctx = {
      harness: (harness ?? {}) as Ctx["harness"],
      approval: {},
      probes: {},
      clock: dependencies.clock,
      log: dependencies.log(state),
      loadPrompt: dependencies.loadPrompt,
      signal: controller.signal
    };
    const patch = await dependencies.runWithTimeout(
      nodes[node](state, context),
      remaining,
      () => controller.abort()
    );
    if (patch === undefined) {
      state = merge(state, {
        node: "N9",
        outcome: "escalated",
        timeline: [
          {
            ts: dependencies.clock().toISOString(),
            nodeId: state.node,
            event: "run_timeout"
          }
        ]
      });
      await dependencies.save(state);
      break;
    }
    state = merge(state, patch);
    const completed = node;
    state = { ...state, node: EDGES[completed](state) };
    await dependencies.save(state);
    if (completed === options.until) break;
  }

  write({
    runId: state.runId,
    incident: state.incident,
    evidence: state.evidence,
    actions: state.actions
  });
  return state;
}
