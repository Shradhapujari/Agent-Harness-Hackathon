import { describe, expect, it, vi } from "vitest";

import type { Ctx, ProbeSnapshot } from "../src/graph.js";
import {
  execDestructive,
  execSafe,
  requestApproval
} from "../src/nodes/exec.js";
import { reportMarkdown } from "../src/nodes/report.js";
import { route } from "../src/nodes/route.js";
import { recovered } from "../src/nodes/verify.js";
import { action, alert, evidence, incident, state } from "./helpers.js";

const now = new Date("2026-08-29T12:00:00.000Z");
const fenced = (value: unknown) =>
  `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function context(harness: unknown, approval: Ctx["approval"] = {}): Ctx {
  return {
    harness: harness as Ctx["harness"],
    approval,
    probes: {},
    clock: () => now,
    log: vi.fn(),
    loadPrompt: async () => "{{action}}{{schema}}"
  };
}

describe("B4 route and execute", () => {
  it("routes from registry policy and executes a safe action once", async () => {
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({ ok: true, tool: "kubernetes.drain_node", result: {} }),
        events: []
      })
    };
    const input = state({ sessionId: "session-1", actions: [action()] });
    const routed = await route(input, context(harness));
    const patch = await execSafe(
      { ...input, ...routed, actions: routed.actions! },
      context(harness)
    );

    expect(routed).toMatchObject({ pendingActionId: "act-1" });
    expect(patch.actions?.[0].status).toBe("executed");
    expect(harness.turn.mock.calls[0]?.[1]).toContain(
      '"idempotency_key":"inc-20260829-abcd:kubernetes.drain_node:1"'
    );
  });

  it("checkpoints approval before N7 resumes the destructive turn", async () => {
    const pending = {
      threadId: "thread-1",
      toolCallId: "call-1",
      tool: "redfish.reset_system",
      args: {}
    };
    const harness = {
      openSession: vi.fn(),
      turn: vi
        .fn()
        .mockResolvedValue({ text: "", events: [], pendingApproval: pending }),
      approve: vi.fn().mockResolvedValue({
        text: fenced({ ok: true, tool: "redfish.reset_system", result: {} }),
        events: []
      })
    };
    const destructive = action({
      kind: "destructive",
      tool: "redfish.reset_system",
      args: { system_id: "R4-N04", reset_type: "ForceRestart" }
    });
    const input = state({
      sessionId: "session-1",
      pendingActionId: destructive.id,
      actions: [destructive],
      evidence: [evidence("redfish")]
    });
    const approved = await requestApproval(
      input,
      context(harness, {
        decide: vi.fn().mockResolvedValue({
          allow: true,
          by: "human:test",
          at: now.toISOString()
        })
      })
    );
    expect(approved.actions?.[0]).toMatchObject({ status: "approved" });
    expect(harness.approve).not.toHaveBeenCalled();

    const executed = await execDestructive(
      { ...input, ...approved, actions: approved.actions! },
      context(harness)
    );
    expect(harness.approve).toHaveBeenCalledWith(
      "session-1",
      pending,
      true,
      undefined,
      undefined
    );
    expect(executed.actions?.[0].status).toBe("executed");
  });
});

describe("B4 verification and report", () => {
  const snapshot = (overrides: Partial<ProbeSnapshot> = {}): ProbeSnapshot => ({
    nodes: [{ systemId: "R4-N04", power: "On", hung: false, cpuTempC: 70 }],
    readyNodes: ["R4-N04"],
    firingAlerts: [],
    ...overrides
  });

  it("uses code-owned recovery predicates and requires falling CRAC temperatures", () => {
    const hang = state({ incident, alerts: [alert()] });
    expect(recovered(hang, snapshot())).toBe(true);
    expect(recovered(hang, snapshot({ firingAlerts: ["fp-1"] }))).toBe(false);

    const crac = state({
      incident: {
        ...incident,
        rootCause: { ...incident.rootCause, kind: "crac_failure" }
      }
    });
    expect(
      recovered(
        crac,
        snapshot(),
        snapshot({
          nodes: [
            { systemId: "R4-N04", power: "On", hung: false, cpuTempC: 80 }
          ]
        })
      )
    ).toBe(true);
    expect(recovered(crac, snapshot())).toBe(false);
  });

  it("renders the audit-critical report sections", () => {
    const markdown = reportMarkdown(
      state({
        incident,
        outcome: "recovered",
        sessionId: "session-1",
        alerts: [alert()],
        evidence: [evidence("redfish")],
        actions: [action({ status: "executed" })]
      })
    );
    expect(markdown).toContain("## Timeline");
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("## Actions");
    expect(markdown).toContain("## Harness trace");
    expect(markdown).toContain("outcome: recovered");
  });
});
