import { createHash } from "node:crypto";
import { z } from "zod";

import { LIMITS, type NodeFn } from "../graph.js";
import { REGISTRY } from "../registry.js";
import { lastJsonBlock } from "../trueforge.js";
import { harnessClient, render, timeline } from "./shared.js";

const Proposal = z.object({
  id: z.string().optional(),
  tool: z.string(),
  args: z.record(z.unknown()),
  reason: z.string().max(300),
  evidence: z.array(z.string()).min(1)
});
const Output = z.object({ actions: z.array(Proposal) });
const schema = JSON.stringify({
  actions: [
    {
      tool: "registry tool",
      args: {},
      reason: "string",
      evidence: ["evidence id"]
    }
  ]
});

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const plan: NodeFn = async (state, context) => {
  if (!state.incident) throw new Error("N3 requires an incident");
  if (!state.sessionId) throw new Error("N3 requires a session");
  const denied = state.actions
    .filter((action) => action.status === "denied")
    .map(({ tool, args, reason }) => ({ tool, args, reason }));
  const result = await harnessClient(context.harness).turn(
    state.sessionId,
    await render("plan", {
      context: JSON.stringify({
        incident: state.incident,
        evidence: state.evidence.map(({ id, layer, summary, source }) => ({
          id,
          layer,
          summary,
          source
        })),
        denied
      }),
      schema
    }),
    { runId: state.runId, nodeId: "N3" }
  );
  const parsed = Output.parse(lastJsonBlock(result.text)).actions;
  const proposals = parsed
    .filter((proposal) => REGISTRY[proposal.tool] !== undefined)
    .slice(0, LIMITS.ACTIONS_MAX);
  const actions = proposals.map((proposal, index) => {
    const policy = REGISTRY[proposal.tool]!;
    const digest = createHash("sha256")
      .update(stable(proposal.args))
      .digest("hex")
      .slice(0, 12);
    return {
      ...proposal,
      id: proposal.id ?? `act-${state.actions.length + index + 1}`,
      rank: index + 1,
      kind: policy.kind as "safe" | "destructive",
      idempotencyKey: `${state.runId}:${proposal.tool}:${digest}`,
      status: "proposed" as const
    };
  });
  return {
    actions,
    timeline: [
      timeline(context.clock(), "N3", "plan_created", {
        accepted: actions.length,
        stripped: proposals.length !== parsed.length
      })
    ]
  };
};
