import type { NodeFn } from "../graph.js";
import { timeline } from "./shared.js";

export const escalate: NodeFn = async (state, context) => {
  if (!state.sessionId) throw new Error("N9 requires a session");
  const message = `PAGE incident ${state.runId}: automated recovery exhausted`;
  const record = {
    graph_id: state.graphId,
    run_id: state.runId,
    node_id: "N9" as const,
    session_id: state.sessionId,
    message
  };
  (context.page ?? ((value) => console.error(JSON.stringify(value))))(record);
  context.log("N9", "paged_human", record);
  return {
    outcome: "escalated",
    timeline: [timeline(context.clock(), "N9", "paged_human", record)]
  };
};
