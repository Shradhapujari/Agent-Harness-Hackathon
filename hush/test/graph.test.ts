import { describe, expect, it, vi } from "vitest";

import {
  LIMITS,
  merge,
  run,
  type Ctx,
  type Graph,
  type NodeFn
} from "../src/graph.js";
import { action, evidence, state } from "./helpers.js";

const noop: NodeFn = async () => ({});

function context(times: Date[]): Ctx {
  let index = 0;
  return {
    harness: {},
    approval: {},
    probes: {},
    clock: () => times[Math.min(index++, times.length - 1)],
    log: vi.fn()
  };
}

describe("merge", () => {
  it("replaces arrays by id, appends timeline, and overwrites scalars", () => {
    const initial = state({
      evidence: [evidence("redfish")],
      actions: [action()],
      timeline: [{ ts: "one", nodeId: "N0", event: "old" }]
    });
    const result = merge(initial, {
      runId: "inc-new",
      evidence: [
        { ...evidence("redfish"), summary: "new" },
        evidence("netbox")
      ],
      actions: [{ ...action(), status: "executed" }],
      timeline: [{ ts: "two", nodeId: "N1", event: "new" }]
    });

    expect(result.runId).toBe("inc-new");
    expect(result.evidence.map((item) => item.summary)).toEqual([
      "new",
      "netbox evidence"
    ]);
    expect(result.actions[0].status).toBe("executed");
    expect(result.timeline.map((item) => item.event)).toEqual(["old", "new"]);
  });
});

describe("run", () => {
  it("runs nodes, follows edges, and checkpoints after every node", async () => {
    const visits: string[] = [];
    const save = vi.fn();
    const graph = {
      nodes: new Proxy({} as Graph["nodes"], {
        get: (_target, node: string) => async () => {
          visits.push(node);
          return {};
        }
      }),
      edges: new Proxy({} as Graph["edges"], {
        get: (_target, node: string) => () => (node === "N0" ? "N10" : "DONE")
      })
    };
    const now = new Date("2026-08-29T12:00:00Z");

    const result = await run(graph, state(), context([now]), save);

    expect(visits).toEqual(["N0", "N10"]);
    expect(result.node).toBe("DONE");
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("routes a timed-out run through escalation and report", async () => {
    const visits: string[] = [];
    const graph: Graph = {
      nodes: {
        N0: async () => {
          visits.push("N0");
          return {};
        },
        N9: async () => {
          visits.push("N9");
          return {};
        },
        N10: async () => {
          visits.push("N10");
          return {};
        },
        N1: noop,
        N2: noop,
        N3: noop,
        N4: noop,
        N5: noop,
        N6: noop,
        N7: noop,
        N8: noop,
        DONE: noop
      },
      edges: new Proxy({} as Graph["edges"], {
        get: (_target, node: string) => () => (node === "N9" ? "N10" : "DONE")
      })
    };
    const start = new Date("2026-08-29T12:00:00Z");
    const late = new Date(start.getTime() + LIMITS.RUN_TIMEOUT_S * 1000 + 1);

    const result = await run(
      graph,
      state(),
      context([start, late, late, late]),
      vi.fn()
    );

    expect(visits).toEqual(["N9", "N10"]);
    expect(result.timeline[0]).toMatchObject({
      nodeId: "N0",
      event: "run_timeout"
    });
  });
});
