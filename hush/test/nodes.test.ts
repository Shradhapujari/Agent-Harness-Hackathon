import { describe, expect, it, vi } from "vitest";

import { LIMITS, type Ctx } from "../src/graph.js";
import { enrich } from "../src/nodes/enrich.js";
import { plan } from "../src/nodes/plan.js";
import { triage } from "../src/nodes/triage.js";
import { createWatch } from "../src/nodes/watch.js";
import { action, alert, evidence, incident, state } from "./helpers.js";

const now = new Date("2026-08-29T12:00:00.000Z");

function context(harness: unknown): Ctx {
  return {
    harness: harness as Ctx["harness"],
    approval: {},
    probes: {},
    clock: () => now,
    log: vi.fn(),
    loadPrompt: async () => "{{alerts}}{{incident}}{{context}}{{schema}}"
  };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

describe("N0 watch", () => {
  const active = (count: number, startsAt: string, prefix = "fp") =>
    Array.from({ length: count }, (_, index) => ({
      fingerprint: `${prefix}-${index}`,
      labels: {
        alertname: "InletTempHigh",
        severity: "warning",
        layer: "bmc",
        rack: "R4"
      },
      startsAt,
      status: { state: "active", silencedBy: [], inhibitedBy: [] }
    }));

  it("polls until a firing storm and maps Alertmanager values", async () => {
    const raw = active(LIMITS.STORM_MIN, "2026-08-29T11:59:30.000Z");
    const inactive = ["suppressed", "unprocessed"].map((status, index) => ({
      ...raw[index]!,
      fingerprint: `ignored-${status}`,
      status: { state: status, silencedBy: [], inhibitedBy: [] }
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([...raw.slice(1), ...inactive]))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([...raw, ...inactive]))
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const patch = await createWatch(fetcher, sleep)(state(), context({}));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(patch.runId).toMatch(/^inc-20260829-[0-9a-f]{4}$/u);
    expect(patch.alerts).toHaveLength(LIMITS.STORM_MIN);
    expect(patch.alerts?.every((item) => item.status === "firing")).toBe(true);
    expect(patch.timeline?.[0]).toMatchObject({
      event: "storm_detected",
      detail: { firing: LIMITS.STORM_MIN, burst: LIMITS.STORM_MIN }
    });
  });

  it("accepts a burst that started long before the poll", async () => {
    // The cascade is posted by `hush-chaos` and the operator starts the run by
    // hand afterwards, so a storm is routinely older than WINDOW_S when N0
    // first sees it. Requiring the earliest alert to be recent closed the gate
    // permanently (I2).
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(active(LIMITS.STORM_MIN, "2026-08-29T09:00:00.000Z"))
        )
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const patch = await createWatch(fetcher, sleep)(state(), context({}));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(patch.timeline?.[0]).toMatchObject({ event: "storm_detected" });
  });

  it("keeps polling while alerts are too sparse to be one burst", async () => {
    // Alerts spread wider than WINDOW_S are a busy fleet, not a storm; a stale
    // one left over from an earlier run must not hold the gate shut either.
    const sparse = Array.from(
      { length: LIMITS.STORM_MIN },
      (_, index) =>
        active(
          1,
          new Date(
            Date.parse("2026-08-29T10:00:00.000Z") +
              index * (LIMITS.WINDOW_S + 1) * 1000
          ).toISOString(),
          `sparse-${index}`
        )[0]!
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sparse)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            ...sparse.slice(0, 1),
            ...active(LIMITS.STORM_MIN, "2026-08-29T11:59:30.000Z")
          ])
        )
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    const patch = await createWatch(fetcher, sleep)(state(), context({}));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(patch.alerts).toHaveLength(LIMITS.STORM_MIN + 1);
    expect(patch.timeline?.[0]).toMatchObject({
      detail: { firing: LIMITS.STORM_MIN + 1, burst: LIMITS.STORM_MIN }
    });
  });
});

describe("N1 triage", () => {
  it("inserts alert template values containing dollar patterns verbatim", async () => {
    const harness = {
      openSession: vi.fn().mockResolvedValue("session-1"),
      turn: vi.fn().mockResolvedValue({ text: fenced(incident), events: [] })
    };
    const dollarName = "$&-$`-$'";

    await triage(
      state({ alerts: [{ ...alert(), name: dollarName }] }),
      context(harness)
    );

    expect(harness.turn.mock.calls[0]?.[1]).toContain(
      `"n":${JSON.stringify(dollarName)}`
    );
  });

  it("opens a session and validates a non-empty primary set", async () => {
    const harness = {
      openSession: vi.fn().mockResolvedValue("session-1"),
      turn: vi.fn().mockResolvedValue({ text: fenced(incident), events: [] })
    };

    const patch = await triage(state({ alerts: [alert()] }), context(harness));

    expect(patch.sessionId).toBe("session-1");
    expect(patch.incident).toEqual(incident);
    expect(harness.turn).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining('"f":"fp-1"'),
      { runId: "inc-20260829-abcd", nodeId: "N1" },
      undefined
    );
  });

  it("does not start a turn when cancellation arrives during session creation", async () => {
    const controller = new AbortController();
    const harness = {
      openSession: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("deadline exceeded"));
        return "session-1";
      }),
      turn: vi.fn()
    };
    const cancelledContext = {
      ...context(harness),
      signal: controller.signal
    };

    await expect(
      triage(state({ alerts: [alert()] }), cancelledContext)
    ).rejects.toThrow("deadline exceeded");
    expect(harness.openSession).toHaveBeenCalledWith(controller.signal);
    expect(harness.turn).not.toHaveBeenCalled();
  });

  it("increments parse retries and records the validation error", async () => {
    const harness = {
      openSession: vi.fn().mockResolvedValue("session-1"),
      turn: vi
        .fn()
        .mockResolvedValue({ text: fenced({ nope: true }), events: [] })
    };

    const patch = await triage(state({ alerts: [alert()] }), context(harness));

    expect(patch.counters?.parseRetries).toBe(1);
    expect(patch.timeline?.[0]).toMatchObject({ event: "parse_error" });
  });
});

describe("N2 enrich", () => {
  it("bounds insufficient subagent fan-out then marks fallback escalation", async () => {
    const layers = [
      evidence("redfish"),
      evidence("netbox"),
      evidence("kubernetes")
    ];
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({ evidence: layers }),
        events: [{ type: "thread.created" }, { type: "thread.created" }]
      })
    };

    const first = await enrich(
      state({ sessionId: "session-1", incident }),
      context(harness)
    );
    const second = await enrich(
      state({
        sessionId: "session-1",
        incident,
        timeline: first.timeline ?? []
      }),
      context(harness)
    );

    expect(first.evidence).toBeUndefined();
    expect(first.timeline?.map((item) => item.event)).toEqual([
      "subagents_spawned",
      "subagent_count_low"
    ]);
    expect(second.evidence).toEqual(layers);
    expect(second.timeline?.map((item) => item.event)).toContain(
      "enrich_fallback_escalation"
    );
  });

  it("bounds malformed output retries and appends the prior error", async () => {
    const harness = {
      openSession: vi.fn(),
      turn: vi
        .fn()
        .mockResolvedValue({ text: fenced({ nope: true }), events: [] })
    };
    const first = await enrich(
      state({ sessionId: "session-1", incident }),
      context(harness)
    );
    const second = await enrich(
      state({
        sessionId: "session-1",
        incident,
        counters: first.counters,
        timeline: first.timeline ?? []
      }),
      context(harness)
    );

    expect(first.counters?.parseRetries).toBe(1);
    expect(harness.turn.mock.calls[1][1]).toContain(
      "Previous validation error:"
    );
    expect(second.counters?.parseRetries).toBe(2);
    expect(second.evidence).toHaveLength(3);
    expect(second.timeline?.map((item) => item.event)).toContain(
      "enrich_fallback_escalation"
    );
  });

  it("retries one missing layer then records explicit fallback evidence", async () => {
    const available = [evidence("redfish"), evidence("kubernetes")];
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({ evidence: available }),
        events: Array.from({ length: 3 }, () => ({ type: "thread.created" }))
      })
    };
    const first = await enrich(
      state({ sessionId: "session-1", incident }),
      context(harness)
    );
    const second = await enrich(
      state({
        sessionId: "session-1",
        incident,
        timeline: first.timeline ?? []
      }),
      context(harness)
    );

    expect(first.evidence).toEqual([]);
    expect(second.evidence).toEqual([
      ...available,
      expect.objectContaining({ layer: "netbox", source: "fallback" })
    ]);
  });
});

describe("N3 plan", () => {
  it("strips unknown tools, caps plans, overrides kind, and makes stable keys", async () => {
    const proposals = [
      {
        tool: "redfish.reset_system",
        args: { reset_type: "ForceRestart", system_id: "R4-N04" },
        reason: "Recover the hung host.",
        evidence: ["ev-redfish"]
      },
      {
        tool: "shell.rm",
        args: {},
        reason: "invalid",
        evidence: ["ev-redfish"]
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        tool: "kubernetes.drain_node",
        args: { name: `node-${index}` },
        reason: "Evacuate workloads.",
        evidence: ["ev-kubernetes"]
      }))
    ];
    const harness = {
      openSession: vi.fn(),
      turn: vi
        .fn()
        .mockResolvedValue({ text: fenced({ actions: proposals }), events: [] })
    };
    const input = state({
      sessionId: "session-1",
      incident,
      evidence: [evidence("redfish"), evidence("kubernetes")]
    });

    const first = await plan(input, context(harness));
    const second = await plan(input, context(harness));

    expect(first.actions).toHaveLength(4);
    expect(first.actions?.map((item) => item.rank)).toEqual([1, 2, 3, 4]);
    expect(first.actions?.[0]).toMatchObject({
      tool: "redfish.reset_system",
      kind: "destructive",
      status: "proposed"
    });
    expect(first.actions?.some((item) => item.tool === "shell.rm")).toBe(false);
    expect(first.actions?.[0].idempotencyKey).toBe(
      second.actions?.[0].idempotencyKey
    );
  });

  it("rejects denied canonical actions and missing evidence, and owns collision-free ids", async () => {
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: [
            {
              id: "model-controlled",
              tool: "redfish.reset_system",
              args: { system_id: "R4-N04", reset_type: "ForceRestart" },
              reason: "Retry a denied action.",
              evidence: ["ev-redfish"]
            },
            {
              id: "act-1",
              tool: "kubernetes.drain_node",
              args: { name: "R4-N04" },
              reason: "Unsupported evidence.",
              evidence: ["ev-missing"]
            },
            {
              id: "act-1",
              tool: "kubernetes.cordon_node",
              args: { name: "R4-N04" },
              reason: "Prevent new scheduling.",
              evidence: ["ev-kubernetes"]
            }
          ]
        }),
        events: []
      })
    };
    const input = state({
      sessionId: "session-1",
      incident,
      evidence: [evidence("redfish"), evidence("kubernetes")],
      actions: [
        {
          id: "act-1",
          rank: 1,
          kind: "destructive",
          tool: "redfish.reset_system",
          args: { reset_type: "ForceRestart", system_id: "R4-N04" },
          idempotencyKey: "prior",
          reason: "Operator denied it.",
          evidence: ["ev-redfish"],
          status: "denied"
        }
      ]
    });

    const patch = await plan(input, context(harness));

    expect(patch.actions).toEqual([
      expect.objectContaining({
        id: "act-2",
        tool: "kubernetes.cordon_node"
      }),
      // The controller's close-out silence, appended because the model's plan
      // had none (I3).
      expect.objectContaining({
        id: "act-3",
        tool: "alertmanager.silence_alerts",
        kind: "safe"
      })
    ]);
  });

  it("bounds malformed output and escalates through an empty plan", async () => {
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({ text: "not json", events: [] })
    };

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("redfish")],
        actions: [action()]
      }),
      context(harness)
    );

    expect(harness.turn).toHaveBeenCalledTimes(2);
    expect(harness.turn.mock.calls[1]?.[1]).toContain(
      "Previous validation error"
    );
    expect(patch.actions).toEqual([
      expect.objectContaining({ id: "act-1", status: "skipped" })
    ]);
    expect(patch.timeline?.[0]?.event).toBe("plan_parse_error");
  });

  it("keeps the pending plan when a replan accepts nothing", async () => {
    // After a denial the model tends to re-propose only the call it was just
    // refused. Superseding anyway discarded the escalation the first plan had
    // already staged and routed the run straight to N9 (I2).
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: [
            {
              tool: "redfish.reset_system",
              args: { system_id: "R4-N04", reset_type: "GracefulRestart" },
              reason: "Retry the call the operator just refused.",
              evidence: ["ev-kubernetes"]
            }
          ]
        }),
        events: []
      })
    };
    const refused = action({
      id: "act-1",
      kind: "destructive",
      tool: "redfish.reset_system",
      args: { system_id: "R4-N04", reset_type: "GracefulRestart" },
      status: "denied"
    });
    const escalation = action({
      id: "act-2",
      rank: 2,
      kind: "destructive",
      tool: "redfish.reset_system",
      args: { system_id: "R4-N04", reset_type: "ForceRestart" },
      status: "proposed"
    });

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("kubernetes")],
        actions: [refused, escalation]
      }),
      context(harness)
    );

    expect(patch.actions).toEqual([]);
    expect(patch.timeline?.[0]).toMatchObject({
      event: "plan_created",
      detail: { accepted: 0, kept: 1 }
    });
  });

  it("supersedes obsolete proposed actions while retaining their audit record", async () => {
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: [
            {
              tool: "kubernetes.cordon_node",
              args: { name: "R4-N04" },
              reason: "Use the revised plan.",
              evidence: ["ev-kubernetes"]
            }
          ]
        }),
        events: []
      })
    };

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("kubernetes")],
        actions: [action()]
      }),
      context(harness)
    );

    expect(patch.actions).toEqual([
      expect.objectContaining({ id: "act-1", status: "skipped" }),
      expect.objectContaining({
        id: "act-2",
        tool: "kubernetes.cordon_node",
        status: "proposed"
      }),
      expect.objectContaining({
        id: "act-3",
        tool: "alertmanager.silence_alerts",
        status: "proposed"
      })
    ]);
  });

  it("appends a close-out silence, ranked last, when the plan omits one", async () => {
    // Without it the incident's own symptom alerts keep firing, and N8 cannot
    // call a recovered machine recovered however healthy the probes read (I3).
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: [
            {
              tool: "redfish.reset_system",
              args: { system_id: "R4-N04", reset_type: "ForceRestart" },
              reason: "Recover the hung host.",
              evidence: ["ev-redfish"]
            }
          ]
        }),
        events: []
      })
    };

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("redfish")]
      }),
      context(harness)
    );

    expect(patch.actions).toHaveLength(2);
    expect(patch.actions?.[1]).toMatchObject({
      tool: "alertmanager.silence_alerts",
      kind: "safe",
      rank: 2,
      args: { matchers: ["rack=R4", "node=R4-N04"], duration_s: 900 },
      evidence: ["ev-redfish"]
    });
  });

  it("replaces the lowest-ranked action when the plan fills every slot", async () => {
    // Dropping the close-out at the cap leaves the storm firing, which is the
    // failure it exists to prevent (I3).
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: Array.from({ length: 4 }, (_, index) => ({
            tool: "kubernetes.drain_node",
            args: { name: `node-${index}` },
            reason: "Evacuate workloads.",
            evidence: ["ev-redfish"]
          }))
        }),
        events: []
      })
    };

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("redfish")]
      }),
      context(harness)
    );

    expect(patch.actions).toHaveLength(4);
    expect(patch.actions?.[3]).toMatchObject({
      tool: "alertmanager.silence_alerts",
      rank: 4
    });
  });

  it("appends its own close-out when the model's silence names another scope", async () => {
    // Alertmanager ANDs matchers, so a silence carrying `rack=R2` clears
    // nothing in R4 however it is named (I3).
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: [
            {
              tool: "alertmanager.silence_alerts",
              args: {
                matchers: ["rack=R2"],
                duration_s: 600,
                comment: "wrong"
              },
              reason: "Silence the wrong rack.",
              evidence: ["ev-redfish"]
            }
          ]
        }),
        events: []
      })
    };

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("redfish")]
      }),
      context(harness)
    );

    expect(patch.actions).toHaveLength(2);
    expect(patch.actions?.[1]?.args).toMatchObject({
      matchers: ["rack=R4", "node=R4-N04"]
    });
  });

  it("leaves the model's own silence alone", async () => {
    const harness = {
      openSession: vi.fn(),
      turn: vi.fn().mockResolvedValue({
        text: fenced({
          actions: [
            {
              tool: "alertmanager.silence_alerts",
              args: { matchers: ["rack=R4"], duration_s: 600, comment: "mine" },
              reason: "Silence the residual storm.",
              evidence: ["ev-redfish"]
            }
          ]
        }),
        events: []
      })
    };

    const patch = await plan(
      state({
        sessionId: "session-1",
        incident,
        evidence: [evidence("redfish")]
      }),
      context(harness)
    );

    expect(patch.actions).toHaveLength(1);
    expect(patch.actions?.[0]?.args).toMatchObject({ comment: "mine" });
  });
});
