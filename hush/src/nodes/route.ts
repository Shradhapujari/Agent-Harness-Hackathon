import type { NodeFn } from "../graph.js";
import { REGISTRY } from "../registry.js";
import { timeline } from "./shared.js";

export const route: NodeFn = async (state, context) => {
  const action = state.actions
    .filter((item) => item.status === "proposed")
    .sort((left, right) => left.rank - right.rank)[0];
  if (!action) return {};
  const policy = REGISTRY[action.tool];
  if (!policy || policy.kind === "read")
    throw new Error(`cannot route unregistered action ${action.tool}`);
  return {
    pendingActionId: action.id,
    actions: [{ ...action, kind: policy.kind }],
    timeline: [
      timeline(context.clock(), "N4", "action_routed", {
        actionId: action.id,
        kind: policy.kind
      })
    ]
  };
};
