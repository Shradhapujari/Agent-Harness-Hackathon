import { describe, expect, it, vi } from "vitest";

import type { NodeFn } from "../src/graph.js";
import { runIncident, type IncidentDependencies } from "../src/incident.js";
import type { RunState } from "../src/state.js";
import type { HarnessClient } from "../src/trueforge.js";
import { action, alert, evidence, incident } from "./helpers.js";

const start = new Date("2026-08-29T12:00:00.000Z");

function dependencies(
  nodes: NonNullable<IncidentDependencies["nodes"]>,
  clock: () => Date = () => start
) {
  const saved: RunState[] = [];
  const logs: Array<{ runId: string; sessionId?: string; event: string }> = [];
  const value: IncidentDependencies = {
    clock,
    createHarness: vi.fn().mockResolvedValue({} as unknown as HarnessClient),
    save: async (state) => {
      saved.push(structuredClone(state));
    },
    log: (state) => (_nodeId, event) => {
      logs.push({ runId: state.runId, sessionId: state.sessionId, event });
    },
    loadPrompt: async () => "unused",
    nodes
  };
  return { value, saved, logs };
}

describe("B3 incident runner", () => {
  it("injects I/O, logs N0, and checkpoints the node after completed N3", async () => {
    const nodes: Record<"N0" | "N1" | "N2" | "N3", NodeFn> = {
      N0: async (_state, context) => {
        context.log("N0", "watch_poll");
        return {
          runId: "inc-20260829-abcd",
          alerts: Array.from({ length: 15 }, (_, index) =>
            alert({ fingerprint: `fp-${index}` })
          ),
          timeline: [
            { ts: start.toISOString(), nodeId: "N0", event: "storm_detected" }
          ]
        };
      },
      N1: async () => ({ sessionId: "session-1", incident }),
      N2: async () => ({
        evidence: [
          evidence("redfish"),
          evidence("netbox"),
          evidence("kubernetes")
        ]
      }),
      N3: async () => ({ actions: [action()] })
    };
    const deps = dependencies(nodes);

    const result = await runIncident(
      { scenario: "hang", until: "N3" },
      deps.value,
      vi.fn()
    );

    expect(result.node).toBe("N4");
    expect(deps.saved.at(-1)?.node).toBe("N4");
    expect(deps.logs).toContainEqual({
      runId: "inc-20260829-0000",
      sessionId: undefined,
      event: "watch_poll"
    });
    expect(deps.value.createHarness).toHaveBeenCalledWith("inc-20260829-abcd");
  });

  it("checkpoints an escalation when the run timeout is exceeded", async () => {
    const watch = vi.fn<NodeFn>();
    const times = [
      start,
      new Date(start.getTime() + 901_000),
      new Date(start.getTime() + 901_000)
    ];
    const deps = dependencies({ N0: watch }, () => times.shift() ?? times[0]!);

    const result = await runIncident({ until: "N3" }, deps.value, vi.fn());

    expect(watch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ node: "N9", outcome: "escalated" });
    expect(result.timeline.at(-1)?.event).toBe("run_timeout");
    expect(deps.saved.at(-1)?.node).toBe("N9");
  });
});
