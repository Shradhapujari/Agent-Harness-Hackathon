import { describe, expect, it, vi } from "vitest";

import {
  TerminalApproval,
  UiApproval,
  createApprovalBridge,
  type UiDecisionPoller
} from "../src/approval.js";
import { LIMITS } from "../src/graph.js";
import { action, incident } from "./helpers.js";

const request = {
  runId: "inc-20260829-abcd",
  sessionId: "session-1",
  action: action({
    kind: "destructive" as const,
    tool: "redfish.reset_system"
  }),
  incident,
  evidence: [],
  pending: {
    threadId: "thread-1",
    toolCallId: "call-1",
    tool: "redfish.reset_system",
    args: {}
  },
  timeoutS: LIMITS.APPROVAL_TIMEOUT_S
};

describe("approval bridge selection", () => {
  it("serves the terminal bridge by default and by name", () => {
    expect(createApprovalBridge(undefined)).toBeInstanceOf(TerminalApproval);
    expect(createApprovalBridge("terminal")).toBeInstanceOf(TerminalApproval);
  });

  it("serves the ui bridge only when a poller is wired in", () => {
    const poll = vi.fn() as unknown as UiDecisionPoller;

    expect(createApprovalBridge("ui", poll)).toBeInstanceOf(UiApproval);
  });

  it("refuses ui mode without a poller rather than swapping in the terminal", () => {
    // Substituting quietly left the operator watching the TrueForge chat while
    // the run blocked on a stdin prompt nobody was reading, and the approval
    // timeout then denied the action for them (I2).
    expect(() => createApprovalBridge("ui")).toThrow(
      /needs a UI decision poller/u
    );
  });

  it("rejects a mode it does not implement", () => {
    expect(() => createApprovalBridge("slack")).toThrow(
      /unknown HUSH_APPROVAL_MODE/u
    );
  });

  it("returns the polled decision in ui mode", async () => {
    const decision = {
      allow: true,
      by: "human:trueforge-ui",
      at: "2026-08-29T12:00:00.000Z"
    };

    const bridge = new UiApproval(async () => decision);

    await expect(bridge.decide(request)).resolves.toEqual(decision);
  });

  it("denies on a ui approval timeout instead of hanging", async () => {
    const bridge = new UiApproval(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        })
    );

    const result = await bridge.decide({ ...request, timeoutS: 0.01 });

    expect(result).toMatchObject({ allow: false, reason: "approval timeout" });
  });
});
