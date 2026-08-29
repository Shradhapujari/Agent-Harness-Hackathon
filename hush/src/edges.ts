import { LIMITS, type EdgeFn, type NodeId } from "./graph.js";
import { toolPolicy } from "./registry.js";
import type { Action, RunState } from "./state.js";

function nextProposed(state: RunState): Action | undefined {
  return state.actions
    .filter((action) => action.status === "proposed")
    .sort((left, right) => left.rank - right.rank)[0];
}

const n0: EdgeFn = (state) => {
  const firing = state.alerts.filter((alert) => alert.status === "firing");
  if (firing.length < LIMITS.STORM_MIN) return "N0";
  const observedAt = [...state.timeline]
    .reverse()
    .find((item) => item.nodeId === "N0")?.ts;
  if (!observedAt) return "N0";
  const cutoff = Date.parse(observedAt) - LIMITS.WINDOW_S * 1000;
  const recent = firing.filter((alert) => {
    const startedAt = Date.parse(alert.startsAt);
    return startedAt >= cutoff && startedAt <= Date.parse(observedAt);
  });
  return recent.length >= LIMITS.STORM_MIN ? "N1" : "N0";
};

const n1: EdgeFn = (state) => {
  if (state.incident && state.incident.primary.length > 0) return "N2";
  return state.counters.parseRetries < LIMITS.PARSE_RETRIES_MAX ? "N1" : "N9";
};

const n2: EdgeFn = (state) => {
  const layers = new Set(state.evidence.map((item) => item.layer));
  return layers.has("redfish") &&
    layers.has("netbox") &&
    layers.has("kubernetes")
    ? "N3"
    : "N2";
};

const n3: EdgeFn = (state) => {
  const history = state.actions.filter(
    (action) => action.status !== "proposed"
  );
  const valid = state.actions
    .filter((action) => action.status === "proposed" && toolPolicy(action.tool))
    .sort((left, right) => left.rank - right.rank)
    .slice(0, LIMITS.ACTIONS_MAX);
  state.actions.splice(0, state.actions.length, ...history, ...valid);
  return valid.length > 0 ? "N4" : "N9";
};

const n4: EdgeFn = (state) => {
  const action =
    state.actions.find((item) => item.id === state.pendingActionId) ??
    nextProposed(state);
  if (!action) return "N8";
  const policy = toolPolicy(action.tool);
  if (!policy || policy.kind === "read") return "N9";
  action.kind = policy.kind;
  state.pendingActionId = action.id;
  return policy.kind === "safe" ? "N5" : "N6";
};

const n6: EdgeFn = (state) => {
  const decided = state.actions.find(
    (action) => action.id === state.pendingActionId
  );
  if (decided?.status === "approved") return "N7";
  return state.counters.replans < LIMITS.REPLANS_MAX ? "N3" : "N9";
};

const afterExec: EdgeFn = (state) => (nextProposed(state) ? "N4" : "N8");

const n8: EdgeFn = (state) => {
  if (state.outcome === "recovered") return "N10";
  return state.counters.verifyAttempts < LIMITS.VERIFY_ATTEMPTS_MAX
    ? "N3"
    : "N9";
};

export const EDGES: Record<NodeId, EdgeFn> = {
  N0: n0,
  N1: n1,
  N2: n2,
  N3: n3,
  N4: n4,
  N5: afterExec,
  N6: n6,
  N7: afterExec,
  N8: n8,
  N9: () => "N10",
  N10: () => "DONE",
  DONE: () => "DONE"
};
