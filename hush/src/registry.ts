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
