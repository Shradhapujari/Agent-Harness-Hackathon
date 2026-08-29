import { z } from "zod";

import { LIMITS, type NodeFn } from "../graph.js";
import type { Action } from "../state.js";
import {
  lastJsonBlock,
  type PendingApproval,
  type TurnResult
} from "../trueforge.js";
import { harnessClient, render, timeline } from "./shared.js";

const ExecResult = z.object({
  ok: z.boolean(),
  tool: z.string(),
  result: z.unknown(),
  note: z.string().optional()
});
const schema = JSON.stringify({
  ok: true,
  tool: "the supplied tool",
  result: {},
  note: "optional string"
});

type PendingResult = {
  pendingApproval: PendingApproval;
  denialReason?: string;
};

function selected(state: Parameters<NodeFn>[0]): Action {
  const action = state.actions.find(
    (item) => item.id === state.pendingActionId
  );
  if (!action) throw new Error("execution requires a routed action");
  return action;
}

function output(action: Action, result: TurnResult): Action {
  const parsed = ExecResult.safeParse(lastJsonBlock(result.text));
  return {
    ...action,
    status: parsed.success && parsed.data.ok ? "executed" : "failed",
    result: parsed.success ? parsed.data : result.text.slice(0, 500)
  };
}

function pendingFrom(action: Action): PendingResult {
  const value = action.result as Partial<PendingResult> | undefined;
  if (!value?.pendingApproval)
    throw new Error("approved action lost pending approval");
  return value as PendingResult;
}

export const execSafe: NodeFn = async (state, context) => {
  const action = selected(state);
  if (action.kind !== "safe")
    throw new Error("N5 received a destructive action");
  const message = await render(
    "exec",
    {
      action: JSON.stringify({
        tool: action.tool,
        args: {
          ...action.args,
          idempotency_key: action.idempotencyKey,
          run_id: state.runId
        }
      }),
      schema
    },
    context.loadPrompt
  );
  const result = await harnessClient(context.harness).turn(
    state.sessionId!,
    message,
    { runId: state.runId, nodeId: "N5" },
    context.signal
  );
  if (result.pendingApproval)
    throw new Error(`unexpected approval for safe tool ${action.tool}`);
  const updated = output(action, result);
  return {
    actions: [updated],
    pendingActionId: undefined,
    timeline: [
      timeline(context.clock(), "N5", `action_${updated.status}`, action.id)
    ]
  };
};

export const requestApproval: NodeFn = async (state, context) => {
  const action = selected(state);
  if (action.kind !== "destructive")
    throw new Error("N6 received a safe action");
  const message = await render(
    "exec",
    {
      action: JSON.stringify({
        tool: action.tool,
        args: {
          ...action.args,
          idempotency_key: action.idempotencyKey,
          run_id: state.runId
        }
      }),
      schema
    },
    context.loadPrompt
  );
  const harness = harnessClient(context.harness);
  const result = await harness.turn(
    state.sessionId!,
    message,
    { runId: state.runId, nodeId: "N6" },
    context.signal
  );
  if (!result.pendingApproval)
    throw new Error(`destructive tool ${action.tool} bypassed approval`);
  if (!context.approval.decide)
    throw new Error("N6 requires an approval bridge");
  const decision = await context.approval.decide({
    runId: state.runId,
    sessionId: state.sessionId!,
    action,
    incident: state.incident,
    evidence: state.evidence,
    pending: result.pendingApproval,
    timeoutS: LIMITS.APPROVAL_TIMEOUT_S
  });
  context.log("N6", decision.allow ? "approved" : "denied", decision);
  if (!decision.allow) {
    await harness.approve(
      state.sessionId!,
      result.pendingApproval,
      false,
      decision.reason,
      context.signal
    );
  }
  return {
    actions: [
      {
        ...action,
        status: decision.allow ? "approved" : "denied",
        decidedBy: decision.by,
        decidedAt: decision.at,
        result: {
          pendingApproval: result.pendingApproval,
          denialReason: decision.reason
        }
      }
    ],
    counters: {
      ...state.counters,
      replans: state.counters.replans + (decision.allow ? 0 : 1)
    },
    ...(!decision.allow ? { pendingActionId: undefined } : {}),
    timeline: [
      timeline(context.clock(), "N6", decision.allow ? "approved" : "denied", {
        actionId: action.id,
        by: decision.by,
        reason: decision.reason
      })
    ]
  };
};

export const execDestructive: NodeFn = async (state, context) => {
  const action = selected(state);
  if (action.status !== "approved") throw new Error("N7 requires approval");
  const result = await harnessClient(context.harness).approve(
    state.sessionId!,
    pendingFrom(action).pendingApproval,
    true,
    undefined,
    context.signal
  );
  const updated = output(action, result);
  return {
    actions: [updated],
    pendingActionId: undefined,
    timeline: [
      timeline(context.clock(), "N7", `action_${updated.status}`, action.id)
    ]
  };
};
