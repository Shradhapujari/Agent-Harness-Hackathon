import type { NodeId } from "./graph.js";

export type LogSink = (line: string) => void;

export function createLogger(
  graphId: string,
  runId: string,
  sink: LogSink = console.log
): (nodeId: NodeId, event: string, detail?: unknown) => void {
  return (nodeId, event, detail) => {
    sink(
      JSON.stringify({
        graph_id: graphId,
        run_id: runId,
        node_id: nodeId,
        event,
        ...(detail === undefined ? {} : { detail })
      })
    );
  };
}
