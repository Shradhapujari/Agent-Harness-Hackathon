import { EDGES } from "./edges.js";
import { LIMITS, merge, type Ctx, type NodeFn } from "./graph.js";
import { enrich } from "./nodes/enrich.js";
import { escalate } from "./nodes/escalate.js";
import { execDestructive, execSafe, requestApproval } from "./nodes/exec.js";
import { plan } from "./nodes/plan.js";
import { report } from "./nodes/report.js";
import { route } from "./nodes/route.js";
import { triage } from "./nodes/triage.js";
import { verify } from "./nodes/verify.js";
import { watch } from "./nodes/watch.js";
import type { RunState } from "./state.js";
import type { HarnessClient } from "./trueforge.js";

export type IncidentOptions = {
  scenario?: "crac" | "hang";
  until?: "N3" | "DONE";
};

export type IncidentDependencies = {
  clock: () => Date;
  createHarness: (runId: string) => Promise<HarnessClient>;
  save: (state: RunState) => Promise<void>;
  log: (state: RunState) => Ctx["log"];
  loadPrompt: NonNullable<Ctx["loadPrompt"]>;
  approval?: Ctx["approval"];
  probes?: Ctx["probes"];
  sleep?: Ctx["sleep"];
  writeReport?: NonNullable<Ctx["writeReport"]>;
  readEvents?: NonNullable<Ctx["readEvents"]>;
  page?: Ctx["page"];
  runWithTimeout: <T>(
    operation: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void
  ) => Promise<T | undefined>;
  nodes?: Partial<Record<RunState["node"], NodeFn>>;
};

const DEFAULT_NODES: Record<RunState["node"], NodeFn> = {
  N0: watch,
  N1: triage,
  N2: enrich,
  N3: plan,
  N4: route,
  N5: execSafe,
  N6: requestApproval,
  N7: execDestructive,
  N8: verify,
  N9: escalate,
  N10: report,
  DONE: async () => ({})
};

function initialState(
  now: Date,
  scenario?: IncidentOptions["scenario"]
): RunState {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    graphId: "hush-incident",
    runId: `inc-${date}-0000`,
    runStartedAt: now.toISOString(),
    node: "N0",
    scenarioHint: scenario,
    alerts: [],
    evidence: [],
    actions: [],
    counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
    timeline: []
  };
}

export async function runIncident(
  options: IncidentOptions,
  dependencies: IncidentDependencies,
  write: (value: unknown) => void = console.log,
  checkpoint?: RunState
): Promise<RunState> {
  let state =
    checkpoint ?? initialState(dependencies.clock(), options.scenario);
  const nodes = { ...DEFAULT_NODES, ...dependencies.nodes };
  let harness: HarnessClient | undefined;

  // RUN_TIMEOUT_S bounds the time this run *spends*, not the wall clock since
  // it started. Measuring from `runStartedAt` charged the run for the hours it
  // sat stopped, so `hush resume` after a TrueForge restart escalated on its
  // first iteration (I2); handing every resume a fresh full budget instead
  // would let repeated restarts run past the bound forever. So: carry the
  // spent time in the checkpoint and give a resume only what is left.
  // `runStartedAt` still records when the incident began, for the report.
  //
  // The meter only ever runs forward. `clock()` is the wall clock, which an NTP
  // correction can step backwards; subtracting two readings of it could hand
  // budget back, and a negative `budgetSpentMs` would fail the schema's own
  // nonnegative check and make the checkpoint unloadable. A clock that goes
  // backwards just stops the meter until it catches up.
  let spentMs = state.budgetSpentMs ?? 0;
  let lastTick = dependencies.clock().getTime();
  const spent = () => {
    const now = dependencies.clock().getTime();
    if (now > lastTick) spentMs += now - lastTick;
    lastTick = now;
    return spentMs;
  };
  const remainingMs = () => LIMITS.RUN_TIMEOUT_S * 1000 - spent();
  // Stamps the spent time onto every checkpoint without touching `state`: the
  // N9 session checkpoint deliberately assigns `state` only after its save
  // resolves and the abort check passes, and that ordering has to hold.
  const stamped = (next: RunState): RunState => ({
    ...next,
    budgetSpentMs: spent()
  });
  const save = (next: RunState) => dependencies.save(stamped(next));

  // Marks the restart in the report's timeline. It rides along on the next
  // checkpoint the loop writes rather than forcing one of its own: an extra
  // write here buys no durability, since the checkpoint being resumed from is
  // already on disk.
  if (checkpoint) {
    state = merge(state, {
      timeline: [
        {
          ts: dependencies.clock().toISOString(),
          nodeId: state.node,
          event: "run_resumed"
        }
      ]
    });
  }

  while (state.node !== "DONE") {
    const remaining = remainingMs();
    const terminal = state.node === "N9" || state.node === "N10";
    if (remaining <= 0 && !terminal) {
      state = merge(state, {
        node: "N9",
        outcome: "escalated",
        timeline: [
          {
            ts: dependencies.clock().toISOString(),
            nodeId: state.node,
            event: "run_timeout"
          }
        ]
      });
      await save(state);
      break;
    }

    const node = state.node as keyof typeof nodes;
    if (node !== "N0" && harness === undefined)
      harness = await dependencies.createHarness(state.runId);
    const controller = new AbortController();
    const operation = async () => {
      if (node === "N9" && !state.sessionId) {
        const sessionId = await harness!.openSession(controller.signal);
        controller.signal.throwIfAborted();
        const checkpoint = merge(state, { sessionId });
        await save(checkpoint);
        controller.signal.throwIfAborted();
        state = checkpoint;
      }
      const context: Ctx = {
        harness: (harness ?? {}) as Ctx["harness"],
        approval: (dependencies.approval ?? {}) as Ctx["approval"],
        probes: (dependencies.probes ?? {}) as Ctx["probes"],
        clock: dependencies.clock,
        log: dependencies.log(state),
        loadPrompt: dependencies.loadPrompt,
        signal: controller.signal,
        sleep: dependencies.sleep,
        writeReport: dependencies.writeReport,
        readEvents: dependencies.readEvents,
        page: dependencies.page
      };
      return nodes[node](state, context);
    };
    const patch = await dependencies.runWithTimeout(
      operation(),
      terminal ? LIMITS.RUN_TIMEOUT_S * 1000 : remaining,
      () => controller.abort()
    );
    if (patch === undefined) {
      if (node === "N10") {
        state = merge(state, {
          timeline: [
            {
              ts: dependencies.clock().toISOString(),
              nodeId: "N10",
              event: "report_timeout"
            }
          ]
        });
        await save(state);
        break;
      }
      state = merge(state, {
        node: terminal ? node : "N9",
        ...(terminal ? {} : { outcome: "escalated" as const }),
        timeline: [
          {
            ts: dependencies.clock().toISOString(),
            nodeId: state.node,
            event: "run_timeout"
          }
        ]
      });
      await save(state);
      break;
    }
    state = merge(state, patch);
    const completed = node;
    state = { ...state, node: EDGES[completed](state) };
    await save(state);
    if (completed === options.until) break;
  }

  state = stamped(state);
  write({
    runId: state.runId,
    incident: state.incident,
    evidence: state.evidence,
    actions: state.actions
  });
  return state;
}
