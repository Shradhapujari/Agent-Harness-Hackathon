import type { NodeFn } from "../graph.js";
import { timeline } from "./shared.js";

export const escalate: NodeFn = async (state, context) => {
  const message = `PAGE incident ${state.runId}: automated recovery exhausted`;
  (context.page ?? console.error)(message);
  return {
    outcome: "escalated",
    timeline: [timeline(context.clock(), "N9", "paged_human", message)]
  };
};
