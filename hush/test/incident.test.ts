import { describe, expect, it, vi } from "vitest";

import { LIMITS, type NodeFn } from "../src/graph.js";
import { runIncident, type IncidentDependencies } from "../src/incident.js";
import { RunState } from "../src/state.js";
import type { HarnessClient } from "../src/trueforge.js";
import { action, alert, evidence, incident } from "./helpers.js";

const start = new Date("2026-08-29T12:00:00.000Z");

/** A clock that walks these instants and then holds at the last one. */
function sequence(...instants: Date[]): () => Date {
  const queue = [...instants];
  let current = instants[0] ?? start;
  return () => {
    current = queue.shift() ?? current;
    return current;
  };
}

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
    runWithTimeout: async (operation) => operation,
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
    // initialState, then the loop entry, then the first budget check.
    const deps = dependencies(
      { N0: watch },
      sequence(start, start, new Date(start.getTime() + 901_000))
    );

    const result = await runIncident({ until: "N3" }, deps.value, vi.fn());

    expect(watch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ node: "N9", outcome: "escalated" });
    expect(result.timeline.at(-1)?.event).toBe("run_timeout");
    expect(deps.saved.at(-1)?.node).toBe("N9");
  });

  it("aborts an in-flight node when the immutable deadline expires", async () => {
    let signal: AbortSignal | undefined;
    const watch: NodeFn = async (_state, context) => {
      signal = context.signal;
      return new Promise(() => undefined);
    };
    const deps = dependencies({ N0: watch });
    deps.value.runWithTimeout = async (_operation, _timeoutMs, onTimeout) => {
      onTimeout();
      return undefined;
    };

    const result = await runIncident({ until: "N3" }, deps.value, vi.fn());

    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ node: "N9", outcome: "escalated" });
    expect(deps.saved.at(-1)?.timeline.at(-1)?.event).toBe("run_timeout");
  });
});

describe("B4 resume runner", () => {
  it("creates and checkpoints a session before an early escalation", async () => {
    const page = vi.fn();
    const report = vi.fn<NodeFn>().mockResolvedValue({});
    const deps = dependencies({ N10: report });
    const openSession = vi.fn().mockResolvedValue("session-created");
    deps.value.createHarness = vi
      .fn()
      .mockResolvedValue({ openSession } as unknown as HarnessClient);
    deps.value.page = page;
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      node: "N9",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 2, parseRetries: 0, verifyAttempts: 2 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(openSession).toHaveBeenCalledOnce();
    expect(openSession).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(deps.saved[0]).toMatchObject({
      node: "N9",
      sessionId: "session-created"
    });
    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "session-created" })
    );
    expect(deps.logs).toContainEqual({
      runId: "inc-20260829-abcd",
      sessionId: "session-created",
      event: "paged_human"
    });
    expect(result.sessionId).toBe("session-created");
  });

  it("bounds and aborts session creation before an early escalation", async () => {
    let signal: AbortSignal | undefined;
    const page = vi.fn();
    const deps = dependencies({});
    deps.value.createHarness = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockImplementation((value?: AbortSignal) => {
        signal = value;
        return new Promise<string>(() => undefined);
      })
    } as unknown as HarnessClient);
    deps.value.page = page;
    deps.value.runWithTimeout = async (_operation, _timeoutMs, onTimeout) => {
      onTimeout();
      return undefined;
    };
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      node: "N9",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 2, parseRetries: 0, verifyAttempts: 2 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(signal?.aborted).toBe(true);
    expect(result.node).toBe("N9");
    expect(result.sessionId).toBeUndefined();
    expect(result.timeline.at(-1)?.event).toBe("run_timeout");
    expect(page).not.toHaveBeenCalled();
  });

  it("gives a resumed run a full budget from the moment it resumes", async () => {
    // I2 kills TrueForge during N2 and resumes afterwards. Charging the run for
    // the time it spent stopped escalated it on the first iteration instead of
    // continuing the incident.
    const enrich = vi.fn<NodeFn>().mockResolvedValue({
      evidence: [
        evidence("redfish"),
        evidence("netbox"),
        evidence("kubernetes")
      ]
    });
    const escalate = vi.fn<NodeFn>();
    const resumedAt = new Date(start.getTime() + 3_600_000);
    const deps = dependencies(
      { N2: enrich, N3: async () => ({ actions: [action()] }), N9: escalate },
      () => resumedAt
    );
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      sessionId: "session-existing",
      node: "N2",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
      timeline: []
    };

    const result = await runIncident(
      { until: "N3" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(enrich).toHaveBeenCalledOnce();
    expect(escalate).not.toHaveBeenCalled();
    expect(result.node).toBe("N4");
    expect(result.outcome).toBeUndefined();
    expect(result.timeline.map((item) => item.event)).toContain("run_resumed");
    expect(result.runStartedAt).toBe(start.toISOString());
  });

  it("carries spent budget across resumes so restarts cannot extend the run", async () => {
    // Excluding stopped time must not hand every resume a fresh full budget,
    // or repeated restarts run past RUN_TIMEOUT_S forever (Qodo, PR #20).
    const resumedAt = new Date(start.getTime() + 3_600_000);
    const enrich = vi.fn<NodeFn>();
    const escalate = vi.fn<NodeFn>().mockResolvedValue({});
    const deps = dependencies(
      { N2: enrich, N9: escalate },
      sequence(resumedAt, new Date(resumedAt.getTime() + 1_000))
    );
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      budgetSpentMs: LIMITS.RUN_TIMEOUT_S * 1000 - 500,
      sessionId: "session-existing",
      node: "N2",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(enrich).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "escalated" });
    expect(result.timeline.map((item) => item.event)).toContain("run_timeout");
  });

  it("never hands budget back when the wall clock steps backwards", async () => {
    // clock() is the wall clock and NTP can step it back. A negative
    // budgetSpentMs would fail the schema's own nonnegative check and make the
    // checkpoint unloadable (Qodo, PR #20).
    const deps = dependencies(
      {
        N2: async () => ({
          evidence: [
            evidence("redfish"),
            evidence("netbox"),
            evidence("kubernetes")
          ]
        }),
        N3: async () => ({ actions: [action()] })
      },
      // loop entry, the run_resumed stamp, one 5 s tick, then a step back.
      sequence(
        start,
        start,
        new Date(start.getTime() + 5_000),
        new Date(start.getTime() - 3_600_000)
      )
    );
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      budgetSpentMs: 1_000,
      sessionId: "session-existing",
      node: "N2",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
      timeline: []
    };

    await runIncident({ until: "N3" }, deps.value, vi.fn(), checkpoint);

    for (const saved of deps.saved) {
      expect(saved.budgetSpentMs).toBeGreaterThanOrEqual(1_000);
      expect(() => RunState.parse(saved)).not.toThrow();
    }
    // The 5 s it ran before the step back is kept; the step back adds nothing.
    expect(deps.saved.at(-1)?.budgetSpentMs).toBe(6_000);
  });

  it("records the budget it spent on every checkpoint", async () => {
    const deps = dependencies(
      {
        N2: async () => ({
          evidence: [
            evidence("redfish"),
            evidence("netbox"),
            evidence("kubernetes")
          ]
        }),
        N3: async () => ({ actions: [action()] })
      },
      sequence(start, new Date(start.getTime() + 4_000))
    );
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      budgetSpentMs: 10_000,
      sessionId: "session-existing",
      node: "N2",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
      timeline: []
    };

    await runIncident({ until: "N3" }, deps.value, vi.fn(), checkpoint);

    // 10 s carried in, plus the 4 s this resume spent.
    expect(deps.saved.at(-1)?.budgetSpentMs).toBe(14_000);
  });

  it("still escalates a resumed run that runs past its own budget", async () => {
    const resumedAt = new Date(start.getTime() + 3_600_000);
    const enrich = vi.fn<NodeFn>();
    const deps = dependencies(
      { N2: enrich },
      sequence(resumedAt, new Date(resumedAt.getTime() + 901_000))
    );
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      sessionId: "session-existing",
      node: "N2",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(enrich).not.toHaveBeenCalled();
    expect(result).toMatchObject({ node: "N9", outcome: "escalated" });
    expect(result.timeline.at(-1)?.event).toBe("run_timeout");
  });

  it("does not page when the session checkpoint save finishes after timeout", async () => {
    let releaseCheckpoint!: () => void;
    let markCheckpointStarted!: () => void;
    const checkpointStarted = new Promise<void>((resolve) => {
      markCheckpointStarted = resolve;
    });
    const pendingCheckpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const page = vi.fn();
    const deps = dependencies({});
    deps.value.createHarness = vi.fn().mockResolvedValue({
      openSession: vi.fn().mockResolvedValue("session-created")
    } as unknown as HarnessClient);
    deps.value.page = page;
    let saves = 0;
    deps.value.save = async () => {
      saves += 1;
      if (saves === 1) {
        markCheckpointStarted();
        await pendingCheckpoint;
      }
    };
    deps.value.runWithTimeout = async (_operation, _timeoutMs, onTimeout) => {
      void _operation.catch(() => undefined);
      await checkpointStarted;
      onTimeout();
      return undefined;
    };
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      node: "N9",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 2, parseRetries: 0, verifyAttempts: 2 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );
    releaseCheckpoint();
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.node).toBe("N9");
    expect(result.sessionId).toBeUndefined();
    expect(result.timeline.at(-1)?.event).toBe("run_timeout");
    expect(page).not.toHaveBeenCalled();
  });

  it("continues a checkpoint through escalation and report with the same session", async () => {
    const report = vi.fn<NodeFn>().mockResolvedValue({});
    const deps = dependencies({
      N9: async () => ({ outcome: "escalated" }),
      N10: report
    });
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      sessionId: "session-existing",
      node: "N9",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 2, parseRetries: 0, verifyAttempts: 2 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(result).toMatchObject({
      node: "DONE",
      sessionId: "session-existing",
      outcome: "escalated"
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-existing" }),
      expect.anything()
    );
    expect(deps.value.createHarness).toHaveBeenCalledWith("inc-20260829-abcd");
  });

  it("allows expired checkpoints to complete terminal nodes", async () => {
    const expired = new Date(start.getTime() + 901_000);
    const report = vi.fn<NodeFn>().mockResolvedValue({});
    const deps = dependencies(
      {
        N9: async () => ({ outcome: "escalated" }),
        N10: report
      },
      () => expired
    );
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      sessionId: "session-existing",
      node: "N9",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 2, parseRetries: 0, verifyAttempts: 2 },
      timeline: []
    };

    const result = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(result.node).toBe("DONE");
    expect(report).toHaveBeenCalledOnce();
  });

  it("retries N10 after a report timeout without paging again", async () => {
    const page = vi.fn<NodeFn>().mockResolvedValue({ outcome: "escalated" });
    const report = vi.fn<NodeFn>().mockResolvedValue({});
    const deps = dependencies({ N9: page, N10: report });
    deps.value.runWithTimeout = async (_operation, _timeoutMs, onTimeout) => {
      onTimeout();
      return undefined;
    };
    const checkpoint: RunState = {
      graphId: "hush-incident",
      runId: "inc-20260829-abcd",
      runStartedAt: start.toISOString(),
      sessionId: "session-existing",
      node: "N10",
      outcome: "recovered",
      alerts: [],
      evidence: [],
      actions: [],
      counters: { replans: 2, parseRetries: 0, verifyAttempts: 2 },
      timeline: []
    };

    const timedOut = await runIncident(
      { until: "DONE" },
      deps.value,
      vi.fn(),
      checkpoint
    );

    expect(timedOut.node).toBe("N10");
    expect(timedOut.outcome).toBe("recovered");
    expect(timedOut.timeline.at(-1)).toMatchObject({
      nodeId: "N10",
      event: "report_timeout"
    });
    expect(page).not.toHaveBeenCalled();

    const resumedDeps = dependencies({ N9: page, N10: report });
    const resumed = await runIncident(
      { until: "DONE" },
      resumedDeps.value,
      vi.fn(),
      timedOut
    );

    expect(resumed.node).toBe("DONE");
    expect(page).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(2);
  });
});
