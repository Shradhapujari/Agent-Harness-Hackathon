export type ToolPolicy = {
  kind: "safe" | "destructive" | "read";
  server: string;
};

export const REGISTRY: Readonly<Record<string, ToolPolicy>> = {
  "kubernetes.cordon_node": { kind: "safe", server: "kubernetes" },
  "kubernetes.drain_node": { kind: "safe", server: "kubernetes" },
  "kubernetes.uncordon_node": { kind: "safe", server: "kubernetes" },
  "alertmanager.silence_alerts": { kind: "safe", server: "alertmanager" },
  "redfish.reset_system": { kind: "destructive", server: "redfish" }
};

export function toolPolicy(tool: string): ToolPolicy | undefined {
  return REGISTRY[tool];
}
