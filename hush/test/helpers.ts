import type {
  Action,
  Alert,
  Evidence,
  Incident,
  RunState
} from "../src/state.js";

export const alert = (overrides: Partial<Alert> = {}): Alert => ({
  fingerprint: "fp-1",
  name: "HostHung",
  severity: "critical",
  labels: { layer: "hardware", node: "R4-N04" },
  startsAt: "2026-08-29T12:00:00.000Z",
  status: "firing",
  ...overrides
});

export const incident: Incident = {
  id: "inc-test",
  rootCause: {
    kind: "host_hang",
    scope: { rack: "R4", nodes: ["R4-N04"] },
    confidence: 0.95,
    rationale: "The BMC reports a hung host."
  },
  primary: ["fp-1"],
  symptoms: [],
  noise: []
};

export const evidence = (layer: Evidence["layer"]): Evidence => ({
  id: `ev-${layer}`,
  layer,
  summary: `${layer} evidence`,
  data: {},
  source: "live"
});

export const action = (overrides: Partial<Action> = {}): Action => ({
  id: "act-1",
  rank: 1,
  kind: "safe",
  tool: "kubernetes.drain_node",
  args: { name: "R4-N04" },
  idempotencyKey: "inc-test:kubernetes.drain_node:1",
  reason: "Move workloads from the failed host.",
  evidence: ["ev-kubernetes"],
  status: "proposed",
  ...overrides
});

export const state = (overrides: Partial<RunState> = {}): RunState => ({
  graphId: "hush-incident",
  runId: "inc-test",
  node: "N0",
  alerts: [],
  evidence: [],
  actions: [],
  counters: { replans: 0, parseRetries: 0, verifyAttempts: 0 },
  timeline: [],
  ...overrides
});
