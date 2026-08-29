import { Incident } from "../state.js";
import { lastJsonBlock } from "../trueforge.js";
import type { NodeFn } from "../graph.js";
import { harnessClient, render, timeline } from "./shared.js";

const schema = JSON.stringify({
  id: "string",
  rootCause: {
    kind: "crac_failure|host_hang|psu_failure|thermal_single|unknown",
    scope: { rack: "string?", nodes: ["string"] },
    confidence: "number 0..1",
    rationale: "string"
  },
  primary: ["fingerprint"],
  symptoms: ["fingerprint"],
  noise: ["fingerprint"]
});

export const triage: NodeFn = async (state, context) => {
  const harness = harnessClient(context.harness);
  const sessionId = state.sessionId ?? (await harness.openSession());
  const compact = state.alerts.map((alert) => ({
    f: alert.fingerprint,
    n: alert.name,
    sev: alert.severity,
    l: Object.fromEntries(
      ["layer", "rack", "node", "tenant"]
        .filter((key) => alert.labels[key] !== undefined)
        .map((key) => [key, alert.labels[key]])
    ),
    t: alert.startsAt,
    st: alert.status
  }));
  const priorError = [...state.timeline]
    .reverse()
    .find((item) => item.nodeId === "N1" && item.event === "parse_error");
  const message = await render(
    "triage",
    {
      alerts: JSON.stringify(compact),
      schema: `${schema}${priorError ? `\nPrevious validation error: ${String(priorError.detail)}` : ""}`
    },
    context.loadPrompt
  );
  const result = await harness.turn(sessionId, message, {
    runId: state.runId,
    nodeId: "N1"
  });
  try {
    const incident = Incident.parse(lastJsonBlock(result.text));
    if (incident.primary.length === 0)
      throw new Error("primary must contain at least one fingerprint");
    return {
      sessionId,
      incident,
      timeline: [
        timeline(
          context.clock(),
          "N1",
          "incident_identified",
          incident.rootCause
        )
      ]
    };
  } catch (error) {
    return {
      sessionId,
      counters: {
        ...state.counters,
        parseRetries: state.counters.parseRetries + 1
      },
      timeline: [timeline(context.clock(), "N1", "parse_error", String(error))]
    };
  }
};
