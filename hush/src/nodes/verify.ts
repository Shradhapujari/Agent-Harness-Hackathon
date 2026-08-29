import { z } from "zod";

import { LIMITS, type NodeFn, type ProbeSnapshot } from "../graph.js";
import { Evidence } from "../state.js";
import { lastJsonBlock } from "../trueforge.js";
import { harnessClient, render, timeline } from "./shared.js";

const ModelVerification = z.object({
  recovered: z.boolean(),
  summary: z.string().max(500),
  evidence: z.array(Evidence)
});
const schema = JSON.stringify({
  recovered: true,
  summary: "string, <=500 characters",
  evidence: [
    {
      id: "string, unique within the run",
      layer: "redfish|netbox|kubernetes|prometheus|web",
      summary: "string, <=300 characters",
      data: {},
      source: "live|fallback"
    }
  ]
});

function alertsClear(state: Parameters<NodeFn>[0], snapshot: ProbeSnapshot) {
  const relevant = new Set([
    ...(state.incident?.primary ?? []),
    ...(state.incident?.symptoms ?? [])
  ]);
  return !snapshot.firingAlerts.some((fingerprint) =>
    relevant.has(fingerprint)
  );
}

function kubernetesNode(
  state: Parameters<NodeFn>[0],
  systemId: string
): string {
  return (
    state.alerts.find(
      (alert) =>
        alert.labels.node === systemId &&
        typeof alert.labels.k8s_node === "string"
    )?.labels.k8s_node ?? systemId
  );
}

export function recovered(
  state: Parameters<NodeFn>[0],
  current: ProbeSnapshot,
  previous?: ProbeSnapshot
): boolean {
  if (!state.incident || !alertsClear(state, current)) return false;
  const scoped = state.incident.rootCause.scope.nodes;
  const nodes = scoped.map((id) =>
    current.nodes.find((node) => node.systemId === id)
  );
  if (nodes.some((node) => !node)) return false;
  if (state.incident.rootCause.kind === "host_hang")
    return nodes.every(
      (node) =>
        node!.power === "On" &&
        !node!.hung &&
        current.readyNodes.includes(kubernetesNode(state, node!.systemId))
    );
  if (state.incident.rootCause.kind === "crac_failure") {
    const prior = new Map(
      previous?.nodes.map((node) => [node.systemId, node.cpuTempC]) ?? []
    );
    return nodes.every(
      (node) =>
        node!.power === "Off" ||
        (node!.cpuTempC < 85 &&
          prior.has(node!.systemId) &&
          node!.cpuTempC < prior.get(node!.systemId)!)
    );
  }
  return false;
}

export const verify: NodeFn = async (state, context) => {
  if (!state.incident || !state.sessionId)
    throw new Error("N8 requires incident and session");
  if (!context.probes.snapshot)
    throw new Error("N8 requires deterministic probes");
  const sleep =
    context.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = context.clock().getTime() + LIMITS.VERIFY_TIMEOUT_S * 1000;
  let previous: ProbeSnapshot | undefined;
  let current = await context.probes.snapshot(state, context.signal);
  let isRecovered = recovered(state, current, previous);
  while (!isRecovered && context.clock().getTime() < deadline) {
    previous = current;
    await sleep(15_000, context.signal);
    current = await context.probes.snapshot(state, context.signal);
    isRecovered = recovered(state, current, previous);
  }
  const message = await render(
    "verify",
    {
      context: JSON.stringify({
        deterministicRecovered: isRecovered,
        incident: state.incident
      }),
      schema
    },
    context.loadPrompt
  );
  const result = await harnessClient(context.harness).turn(
    state.sessionId,
    message,
    { runId: state.runId, nodeId: "N8" },
    context.signal
  );
  const parsed = ModelVerification.safeParse(lastJsonBlock(result.text));
  const disagrees = parsed.success && parsed.data.recovered !== isRecovered;
  return {
    outcome: isRecovered ? "recovered" : undefined,
    evidence: parsed.success ? parsed.data.evidence : [],
    counters: {
      ...state.counters,
      verifyAttempts: state.counters.verifyAttempts + 1
    },
    timeline: [
      timeline(context.clock(), "N8", "verification", {
        recovered: isRecovered,
        modelSummary: parsed.success
          ? parsed.data.summary
          : result.text.slice(0, 500)
      }),
      ...(disagrees
        ? [timeline(context.clock(), "N8", "verify_disagreement")]
        : [])
    ]
  };
};
