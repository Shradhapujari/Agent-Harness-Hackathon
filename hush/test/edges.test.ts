import { describe, expect, it } from "vitest";

import { EDGES } from "../src/edges.js";
import { LIMITS } from "../src/graph.js";
import { REGISTRY } from "../src/registry.js";
import { action, alert, evidence, incident, state } from "./helpers.js";

describe("graph edges", () => {
  it("detects only a sufficiently dense storm", () => {
    const alerts = Array.from({ length: LIMITS.STORM_MIN }, (_, index) =>
      alert({
        fingerprint: `fp-${index}`,
        startsAt: `2026-08-29T12:00:${String(index).padStart(2, "0")}.000Z`
      })
    );
    const observed = {
      ts: "2026-08-29T12:01:59.000Z",
      nodeId: "N0",
      event: "poll"
    };
    expect(EDGES.N0(state({ alerts, timeline: [observed] }))).toBe("N1");
    expect(
      EDGES.N0(state({ alerts: alerts.slice(1), timeline: [observed] }))
    ).toBe("N0");
    expect(
      EDGES.N0(
        state({
          alerts: [
            ...alerts.slice(0, -1),
            alert({ startsAt: "2026-08-29T12:03:00Z" })
          ],
          timeline: [observed]
        })
      )
    ).toBe("N0");
    const stale = alerts.map((item, index) => ({
      ...item,
      startsAt: `2026-08-29T11:00:${String(index).padStart(2, "0")}.000Z`
    }));
    expect(EDGES.N0(state({ alerts: stale, timeline: [observed] }))).toBe("N0");
    expect(EDGES.N0(state({ alerts }))).toBe("N0");
  });

  it("routes triage success, retries, and exhaustion", () => {
    expect(EDGES.N1(state({ incident }))).toBe("N2");
    expect(
      EDGES.N1(
        state({ counters: { replans: 0, parseRetries: 1, verifyAttempts: 0 } })
      )
    ).toBe("N1");
    expect(
      EDGES.N1(
        state({ counters: { replans: 0, parseRetries: 2, verifyAttempts: 0 } })
      )
    ).toBe("N9");
  });

  it("waits for all required enrichment layers", () => {
    expect(
      EDGES.N2(
        state({
          evidence: [
            evidence("redfish"),
            evidence("netbox"),
            evidence("kubernetes")
          ]
        })
      )
    ).toBe("N3");
    expect(EDGES.N2(state({ evidence: [evidence("redfish")] }))).toBe("N2");
  });

  it("strips unknown and excess actions", () => {
    const actions = [
      action({ id: "bad", tool: "shell.exec" }),
      ...Array.from({ length: 5 }, (_, index) =>
        action({ id: `act-${index}`, rank: index + 1 })
      )
    ];
    const current = state({ actions });
    expect(EDGES.N3(current)).toBe("N4");
    expect(current.actions).toHaveLength(LIMITS.ACTIONS_MAX);
    expect(current.actions.some((item) => item.tool === "shell.exec")).toBe(
      false
    );
    expect(EDGES.N3(state({ actions: [action({ tool: "shell.exec" })] }))).toBe(
      "N9"
    );
  });

  it("caps only the current proposed plan in rank order", () => {
    const history = Array.from({ length: 4 }, (_, index) =>
      action({ id: `old-${index}`, rank: index + 1, status: "denied" })
    );
    const proposed = Array.from({ length: 5 }, (_, index) =>
      action({ id: `new-${index}`, rank: 10 - index })
    );
    const current = state({ actions: [...history, ...proposed] });

    expect(EDGES.N3(current)).toBe("N4");
    expect(current.actions.filter((item) => item.status === "denied")).toEqual(
      history
    );
    expect(
      current.actions
        .filter((item) => item.status === "proposed")
        .map((item) => item.rank)
    ).toEqual([6, 7, 8, 9]);
  });

  it("uses registry policy to route and override model kind", () => {
    const safe = state({ actions: [action({ kind: "destructive" })] });
    expect(EDGES.N4(safe)).toBe("N5");
    expect(safe.actions[0].kind).toBe("safe");
    const destructive = state({
      actions: [action({ tool: "redfish.reset_system", kind: "safe" })]
    });
    expect(EDGES.N4(destructive)).toBe("N6");
    expect(destructive.actions[0].kind).toBe("destructive");
    expect(destructive.pendingActionId).toBe("act-1");
    expect(EDGES.N4(state())).toBe("N8");
    expect(EDGES.N4(state({ actions: [action({ tool: "shell.exec" })] }))).toBe(
      "N9"
    );
    const registry = REGISTRY as unknown as Record<
      string,
      { kind: "read"; server: string }
    >;
    registry["test.read"] = { kind: "read", server: "test" };
    expect(EDGES.N4(state({ actions: [action({ tool: "test.read" })] }))).toBe(
      "N9"
    );
    delete registry["test.read"];
  });

  it("routes approval, denial, execution, verification, and report edges", () => {
    expect(
      EDGES.N6(
        state({
          pendingActionId: "act-1",
          actions: [action({ status: "approved" })]
        })
      )
    ).toBe("N7");
    expect(
      EDGES.N6(
        state({
          pendingActionId: "act-1",
          actions: [action({ status: "denied" })]
        })
      )
    ).toBe("N3");
    expect(
      EDGES.N6(
        state({
          pendingActionId: "act-1",
          actions: [action({ status: "denied" })],
          counters: { replans: 2, parseRetries: 0, verifyAttempts: 0 }
        })
      )
    ).toBe("N9");
    expect(EDGES.N5(state({ actions: [action()] }))).toBe("N4");
    expect(EDGES.N7(state({ actions: [action({ status: "executed" })] }))).toBe(
      "N8"
    );
    expect(EDGES.N8(state({ outcome: "recovered" }))).toBe("N10");
    expect(EDGES.N8(state())).toBe("N3");
    expect(
      EDGES.N8(
        state({ counters: { replans: 0, parseRetries: 0, verifyAttempts: 2 } })
      )
    ).toBe("N9");
    expect(EDGES.N9(state())).toBe("N10");
    expect(EDGES.N10(state())).toBe("DONE");
    expect(EDGES.DONE(state())).toBe("DONE");
  });

  it("routes only on the selected action's approval decision", () => {
    const current = state({
      pendingActionId: "current",
      actions: [
        action({ id: "old", rank: 99, status: "approved" }),
        action({ id: "current", rank: 1, status: "denied" })
      ]
    });
    expect(EDGES.N6(current)).toBe("N3");
  });
});
