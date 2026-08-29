import type { RunState } from "./state.js";

export type NodeId = RunState["node"];

export interface Harness {
  readonly [key: string]: unknown;
}

export interface ApprovalBridge {
  readonly [key: string]: unknown;
}

export interface Probes {
  readonly [key: string]: unknown;
}

export type NodeFn = (
  state: RunState,
  context: Ctx
) => Promise<Partial<RunState>>;
export type EdgeFn = (state: RunState) => NodeId;

export interface Ctx {
  harness: Harness;
  approval: ApprovalBridge;
  probes: Probes;
  clock: () => Date;
  log: (nodeId: NodeId, event: string, detail?: unknown) => void;
  loadPrompt?: (name: string) => Promise<string>;
  signal?: AbortSignal;
}

export const LIMITS = {
  STORM_MIN: 15,
  WINDOW_S: 120,
  ACTIONS_MAX: 4,
  REPLANS_MAX: 2,
  PARSE_RETRIES_MAX: 2,
  VERIFY_ATTEMPTS_MAX: 2,
  VERIFY_TIMEOUT_S: 180,
  APPROVAL_TIMEOUT_S: 600,
  RUN_TIMEOUT_S: 900
} as const;

export interface Graph {
  nodes: Record<NodeId, NodeFn>;
  edges: Record<NodeId, EdgeFn>;
}

function mergeById<T extends { id: string }>(
  current: T[],
  patch: T[] = []
): T[] {
  return [
    ...current.filter((item) => !patch.some((next) => next.id === item.id)),
    ...patch
  ];
}

export function merge(state: RunState, patch: Partial<RunState>): RunState {
  return {
    ...state,
    ...patch,
    evidence: mergeById(state.evidence, patch.evidence),
    actions: mergeById(state.actions, patch.actions),
    timeline: [...state.timeline, ...(patch.timeline ?? [])]
  };
}

export async function run(
  graph: Graph,
  initial: RunState,
  context: Ctx,
  save: (state: RunState) => Promise<void>
): Promise<RunState> {
  const now = context.clock();
  let state: RunState = {
    ...initial,
    runStartedAt: initial.runStartedAt ?? now.toISOString()
  };
  const started = Date.parse(state.runStartedAt!);

  while (state.node !== "DONE") {
    if (
      context.clock().getTime() - started > LIMITS.RUN_TIMEOUT_S * 1000 &&
      state.node !== "N10" &&
      state.node !== "N9"
    ) {
      state = merge(state, {
        node: "N9",
        timeline: [
          {
            ts: context.clock().toISOString(),
            nodeId: state.node,
            event: "run_timeout"
          }
        ]
      });
    }

    const patch = await graph.nodes[state.node](state, context);
    state = merge(state, patch);
    const next = state.node === "N10" ? "DONE" : graph.edges[state.node](state);
    context.log(state.node, "edge", { next });
    state = { ...state, node: next };
    await save(state);
  }

  return state;
}
