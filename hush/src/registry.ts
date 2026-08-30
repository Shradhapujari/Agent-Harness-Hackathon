export type ToolPolicy = {
  kind: "safe" | "destructive" | "read";
  server: string;
  // Arguments the controller owns rather than the model. `reason` is the
  // rationale the operator saw at the approval gate, so the BMC's SEL entry
  // records the text a human actually approved (graph.md §5).
  injects?: readonly "reason"[];
};

export const REGISTRY: Readonly<Record<string, ToolPolicy>> = {
  "kubernetes.cordon_node": { kind: "safe", server: "kubernetes" },
  "kubernetes.drain_node": { kind: "safe", server: "kubernetes" },
  "kubernetes.uncordon_node": { kind: "safe", server: "kubernetes" },
  "alertmanager.silence_alerts": { kind: "safe", server: "alertmanager" },
  "redfish.reset_system": {
    kind: "destructive",
    server: "redfish",
    injects: ["reason"]
  }
};

export function toolPolicy(tool: string): ToolPolicy | undefined {
  return REGISTRY[tool];
}

// The one place a tool call's arguments are assembled. N5/N6/N7 send these, and
// the web approval bridge checks the held call against them, so the two cannot
// be built separately: when they were, the injected `reason` made every
// destructive call look like a call nobody planned, and the run died at the
// gate before the operator ever saw it (I3).
export function callArgs(
  action: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    idempotencyKey: string;
  },
  runId: string
): Record<string, unknown> {
  const injects = toolPolicy(action.tool)?.injects ?? [];
  return {
    ...action.args,
    ...(injects.includes("reason") ? { reason: action.reason } : {}),
    idempotency_key: action.idempotencyKey,
    run_id: runId
  };
}
