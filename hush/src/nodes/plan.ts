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

//: The residual storm has to be closed out by *something*. The prompt asks the
//: model for this action, but a plan that omits it leaves the incident's own
//: symptom alerts firing, and N8 can then never call the incident recovered
//: however healthy the hardware reads (I3). So the controller appends it when
//: the model does not: same registry tool, same safe policy, scoped to the
//: incident's own rack and node, ranked last so it runs after the remediation.
const CLOSEOUT_TOOL = "alertmanager.silence_alerts";
const CLOSEOUT_S = 900;

function closeout(
  state: Parameters<NodeFn>[0],
  proposals: z.infer<typeof Proposal>[]
): z.infer<typeof Proposal> | undefined {
  if (proposals.length === 0) return undefined;
  if (proposals.some((proposal) => proposal.tool === CLOSEOUT_TOOL))
    return undefined;
  const scope = state.incident!.rootCause.scope;
  const matchers = [
    `rack=${scope.rack}`,
    ...(scope.nodes.length === 1 ? [`node=${scope.nodes[0]}`] : [])
  ];
  return {
    tool: CLOSEOUT_TOOL,
    args: {
      matchers,
      duration_s: CLOSEOUT_S,
      comment: `hush ${state.runId}: residual ${state.incident!.rootCause.kind} storm`
    },
    reason:
      "Stop the residual symptom storm this incident's remediation leaves behind.",
    evidence: proposals[0]!.evidence.slice(0, 1)
  };
}

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
    .map(({ tool, args, result }) => ({
      tool,
      args,
      reason:
        result && typeof result === "object" && "denialReason" in result
          ? String(result.denialReason)
          : "denied"
    }));
  const deniedKeys = new Set(
    denied.map(({ tool, args }) => `${tool}:${stable(args)}`)
  );
  const message = await render(
    "plan",
    {
      context: JSON.stringify({
        incident: state.incident,
        evidence: state.evidence.map(({ id, layer, summary, source }) => ({
          id,
          layer,
          summary,
          source
        })),
        denied,
        verification: [...state.timeline]
          .reverse()
          .find((item) => item.event === "verification")?.detail
      }),
      schema
    },
    context.loadPrompt
  );
  const harness = harnessClient(context.harness);
  let parsed: z.infer<typeof Proposal>[] | undefined;
  let validationError = "";
  for (let attempt = 0; attempt < LIMITS.PARSE_RETRIES_MAX; attempt += 1) {
    context.signal?.throwIfAborted();
    const result = await harness.turn(
      state.sessionId,
      `${message}${validationError}`,
      { runId: state.runId, nodeId: "N3" },
      context.signal
    );
    try {
      parsed = Output.parse(lastJsonBlock(result.text)).actions;
      break;
    } catch (error) {
      validationError = `\nPrevious validation error: ${String(error)}`;
    }
  }
  if (!parsed) {
    return {
      actions: state.actions
        .filter((action) => action.status === "proposed")
        .map((action) => ({ ...action, status: "skipped" as const })),
      timeline: [
        timeline(context.clock(), "N3", "plan_parse_error", {
          attempts: LIMITS.PARSE_RETRIES_MAX,
          error: validationError.trim()
        })
      ]
    };
  }
  const evidenceIds = new Set(state.evidence.map(({ id }) => id));
  const proposals = parsed
    .filter(
      (proposal) =>
        REGISTRY[proposal.tool] !== undefined &&
        !deniedKeys.has(`${proposal.tool}:${stable(proposal.args)}`) &&
        proposal.evidence.every((id) => evidenceIds.has(id))
    )
    .slice(0, LIMITS.ACTIONS_MAX);
  const appended = closeout(state, proposals);
  if (
    appended &&
    !deniedKeys.has(`${appended.tool}:${stable(appended.args)}`) &&
    proposals.length < LIMITS.ACTIONS_MAX
  )
    proposals.push(appended);
  const actionIds = new Set(state.actions.map(({ id }) => id));
  let nextActionNumber = 1;
  const actions = proposals.map((proposal, index) => {
    const policy = REGISTRY[proposal.tool]!;
    const digest = createHash("sha256")
      .update(stable(proposal.args))
      .digest("hex")
      .slice(0, 12);
    while (actionIds.has(`act-${nextActionNumber}`)) nextActionNumber += 1;
    const id = `act-${nextActionNumber}`;
    actionIds.add(id);
    nextActionNumber += 1;
    return {
      ...proposal,
      id,
      rank: index + 1,
      kind: policy.kind as "safe" | "destructive",
      idempotencyKey: `${state.runId}:${proposal.tool}:${digest}`,
      status: "proposed" as const
    };
  });
  // A replan only supersedes the plan on the table when it has something to put
  // there. After a denial the model often re-proposes only the call it was just
  // refused; everything is stripped, and superseding anyway threw away the
  // escalation the first plan had already staged (a ForceRestart behind the
  // denied GracefulRestart), leaving an empty plan that routed straight to N9
  // instead of offering the operator the stronger action (I2).
  const superseded =
    actions.length > 0
      ? state.actions
          .filter((action) => action.status === "proposed")
          .map((action) => ({ ...action, status: "skipped" as const }))
      : [];
  return {
    actions: [...superseded, ...actions],
    timeline: [
      timeline(context.clock(), "N3", "plan_created", {
        accepted: actions.length,
        stripped: proposals.length !== parsed.length,
        ...(actions.length === 0
          ? {
              kept: state.actions.filter((a) => a.status === "proposed").length
            }
          : {})
      })
    ]
  };
};
