import { z } from "zod";

import type { NodeFn } from "../graph.js";
import { Evidence } from "../state.js";
import { lastJsonBlock } from "../trueforge.js";
import { harnessClient, render, timeline } from "./shared.js";

const Output = z.object({ evidence: z.array(Evidence) });
const schema = JSON.stringify({ evidence: ["Evidence"] });

export const enrich: NodeFn = async (state, context) => {
  if (!state.incident) throw new Error("N2 requires an incident");
  if (!state.sessionId) throw new Error("N2 requires a session");
  const result = await harnessClient(context.harness).turn(
    state.sessionId,
    await render("enrich", {
      incident: JSON.stringify(state.incident),
      schema
    }),
    { runId: state.runId, nodeId: "N2" }
  );
  const spawned = result.events.filter(
    (event) => (event as { type: string }).type === "thread.created"
  ).length;
  const output = Output.parse(lastJsonBlock(result.text));
  if (spawned < 3)
    return {
      timeline: [
        timeline(context.clock(), "N2", "subagents_spawned", {
          count: spawned
        }),
        timeline(context.clock(), "N2", "subagent_count_low", {
          count: spawned
        })
      ]
    };
  const required = ["redfish", "netbox", "kubernetes"] as const;
  const present = new Set(output.evidence.map((item) => item.layer));
  const missing = required.filter((layer) => !present.has(layer));
  const retried = state.timeline.some(
    (item) => item.nodeId === "N2" && item.event === "enrich_missing_layers"
  );
  const fallback = retried
    ? missing.map((layer) => ({
        id: `ev-${layer}-fallback`,
        layer,
        summary: `${layer} enrichment unavailable after retry`,
        data: { reason: "missing from two enrichment turns" },
        source: "fallback" as const
      }))
    : [];
  return {
    evidence:
      retried || missing.length === 0 ? [...output.evidence, ...fallback] : [],
    timeline: [
      timeline(context.clock(), "N2", "subagents_spawned", { count: spawned }),
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
