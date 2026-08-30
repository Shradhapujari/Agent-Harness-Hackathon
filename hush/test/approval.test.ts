import { describe, expect, it, vi } from "vitest";

import {
  TerminalApproval,
  UiApproval,
  WebApproval,
  createApprovalBridge,
  type UiDecisionPoller
} from "../src/approval.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../src/graph.js";
import { action, incident } from "./helpers.js";

const destructiveAction = action({
  kind: "destructive" as const,
  tool: "redfish.reset_system",
  args: { system_id: "R4-N04", reset_type: "ForceRestart" },
  idempotencyKey: "inc-20260829-abcd:redfish.reset_system:1"
});

const request = {
  runId: "inc-20260829-abcd",
  sessionId: "session-1",
  action: destructiveAction,
  incident,
  evidence: [],
  pending: {
    threadId: "thread-1",
    toolCallId: "call-1",
    tool: "redfish.reset_system",
    args: {
      ...destructiveAction.args,
      idempotency_key: destructiveAction.idempotencyKey,
      run_id: "inc-20260829-abcd"
    }
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

  it("serves the local web approval bridge by name", () => {
    expect(createApprovalBridge("web")).toBeInstanceOf(WebApproval);
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

describe("local web approval", () => {
  it("publishes the exact pending action and accepts only its decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hush-approval-"));
    const bridge = new WebApproval(directory, 5);
    const decision = bridge.decide({ ...request, timeoutS: 1 });
    const pendingPath = join(directory, request.runId, "approval-pending.json");
    let pending: { action?: { id?: string } } | undefined;
    for (let attempt = 0; attempt < 20 && !pending; attempt += 1) {
      try {
        pending = JSON.parse(
          await readFile(pendingPath, "utf8")
        ) as typeof pending;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(pending?.action?.id).toBe(request.action.id);
    await writeFile(
      join(directory, request.runId, "approval-decision.json"),
      JSON.stringify({
        runId: request.runId,
        actionId: request.action.id,
        toolCallId: request.pending.toolCallId,
        tool: request.pending.tool,
        args: request.pending.args,
        allow: true
      }),
      "utf8"
    );

    await expect(decision).resolves.toMatchObject({
      allow: true,
      by: "human:hush-console"
    });
  });

  it("fails loud when the held tool call differs from the planned action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hush-approval-"));
    const bridge = new WebApproval(directory, 5);

    await expect(
      bridge.decide({
        ...request,
        pending: { ...request.pending, tool: "redfish.other_operation" }
      })
    ).rejects.toThrow(/does not match planned action/u);
  });

  it("denies and removes the pending record when the web decision times out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hush-approval-"));
    const bridge = new WebApproval(directory, 5);
    const result = await bridge.decide({ ...request, timeoutS: 0.01 });

    expect(result).toMatchObject({ allow: false, reason: "approval timeout" });
    await expect(
      readFile(join(directory, request.runId, "approval-pending.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
