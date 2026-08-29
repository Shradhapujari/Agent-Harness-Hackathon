import { z } from "zod";

import { LIMITS, type NodeFn } from "../graph.js";
import { Evidence } from "../state.js";
import { lastJsonBlock } from "../trueforge.js";
import { harnessClient, render, timeline } from "./shared.js";

const Output = z.object({ evidence: z.array(Evidence) });
// A field-level example, not the type's name: given `["Evidence"]` the model
// returned an array of the string "Evidence", then objects with no `id` and
// layers outside the enum, and burned both parse retries doing it (I2).
const schema = JSON.stringify({
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
const required = ["redfish", "netbox", "kubernetes"] as const;

function fallbackEvidence(
  layers: readonly (typeof required)[number][],
  reason: string
) {
  return layers.map((layer) => ({
    id: `ev-${layer}-fallback`,
    layer,
    summary: `${layer} enrichment unavailable after bounded retry`,
    data: { reason },
    source: "fallback" as const
  }));
}

export const enrich: NodeFn = async (state, context) => {
  if (!state.incident) throw new Error("N2 requires an incident");
  if (!state.sessionId) throw new Error("N2 requires a session");
  const priorError = [...state.timeline]
    .reverse()
    .find((item) => item.nodeId === "N2" && item.event === "parse_error");
  const result = await harnessClient(context.harness).turn(
    state.sessionId,
    await render(
      "enrich",
      {
        incident: JSON.stringify(state.incident),
        schema: `${schema}${priorError ? `\nPrevious validation error: ${String(priorError.detail)}` : ""}`
      },
      context.loadPrompt
    ),
    { runId: state.runId, nodeId: "N2" },
    context.signal
  );
  const spawned = result.events.filter(
    (event) => (event as { type: string }).type === "thread.created"
  ).length;
  let output: z.infer<typeof Output>;
  try {
    output = Output.parse(lastJsonBlock(result.text));
  } catch (error) {
    const parseRetries = state.counters.parseRetries + 1;
    const nodeRetries =
      state.timeline.filter(
        (item) => item.nodeId === "N2" && item.event === "parse_error"
      ).length + 1;
    const exhausted = nodeRetries >= LIMITS.PARSE_RETRIES_MAX;
    return {
      counters: { ...state.counters, parseRetries },
      ...(exhausted
        ? {
            evidence: fallbackEvidence(
              required,
              "invalid N2 output after two attempts"
            )
          }
        : {}),
      timeline: [
        timeline(context.clock(), "N2", "parse_error", String(error)),
        ...(exhausted
          ? [
              timeline(context.clock(), "N2", "enrich_fallback_escalation", {
                reason: "parse retries exhausted"
              })
            ]
          : [])
      ]
    };
  }
  const fanoutRetried = state.timeline.some(
    (item) => item.nodeId === "N2" && item.event === "subagent_count_low"
  );
  if (spawned < 3 && !fanoutRetried)
    return {
      timeline: [
        timeline(context.clock(), "N2", "subagents_spawned", {
          count: spawned
        }),
        timeline(context.clock(), "N2", "subagent_count_low", {
          count: spawned,
          retry: true
        })
      ]
    };
  const present = new Set(output.evidence.map((item) => item.layer));
  const missing = required.filter((layer) => !present.has(layer));
  const retried = state.timeline.some(
    (item) => item.nodeId === "N2" && item.event === "enrich_missing_layers"
  );
  const fallback =
    retried || fanoutRetried
      ? fallbackEvidence(
          missing,
          fanoutRetried
            ? "insufficient subagent fan-out after retry"
            : "missing from two enrichment turns"
        )
      : [];
  return {
    evidence:
      retried || fanoutRetried || missing.length === 0
        ? [...output.evidence, ...fallback]
        : [],
    timeline: [
      timeline(context.clock(), "N2", "subagents_spawned", { count: spawned }),
      ...(fanoutRetried && spawned < 3
        ? [
            timeline(context.clock(), "N2", "enrich_fallback_escalation", {
              reason: "subagent fan-out remained below three",
              count: spawned
            })
          ]
        : []),
      ...(missing.length > 0
        ? [
            timeline(context.clock(), "N2", "enrich_missing_layers", {
              missing,
              fallback: retried
            })
          ]
        : [])
    ]
  };
};
