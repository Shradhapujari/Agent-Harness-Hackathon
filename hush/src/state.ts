import { z } from "zod";

export const Alert = z.object({
  fingerprint: z.string(),
  name: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  labels: z.record(z.string()),
  startsAt: z.string().datetime(),
  status: z.enum(["firing", "resolved"])
});

export const Incident = z.object({
  id: z.string(),
  rootCause: z.object({
    kind: z.enum([
      "crac_failure",
      "host_hang",
      "psu_failure",
      "thermal_single",
      "unknown"
    ]),
    scope: z.object({
      rack: z.string().optional(),
      nodes: z.array(z.string())
    }),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(600)
  }),
  primary: z.array(z.string()),
  symptoms: z.array(z.string()),
  noise: z.array(z.string())
});

export const Evidence = z.object({
  id: z.string(),
  layer: z.enum(["redfish", "netbox", "kubernetes", "prometheus", "web"]),
  summary: z.string().max(300),
  data: z.unknown(),
  source: z.enum(["live", "fallback"]).default("live")
});

export const Action = z.object({
  id: z.string(),
  rank: z.number().int(),
  kind: z.enum(["safe", "destructive"]),
  tool: z.string(),
  args: z.record(z.unknown()),
  idempotencyKey: z.string(),
  reason: z.string().max(300),
  evidence: z.array(z.string()),
  status: z
    .enum(["proposed", "approved", "denied", "executed", "failed", "skipped"])
    .default("proposed"),
  decidedBy: z.string().optional(),
  decidedAt: z.string().datetime().optional(),
  result: z.unknown().optional()
});

export const RunState = z.object({
  graphId: z.literal("hush-incident"),
  runId: z.string().regex(/^inc-\d{8}-[0-9a-fA-F]{4}$/),
  runStartedAt: z.string().datetime().optional(),
  /** Milliseconds this run has spent actually running, across all resumes. */
  budgetSpentMs: z.number().nonnegative().optional(),
  sessionId: z.string().optional(),
  pendingActionId: z.string().optional(),
  scenarioHint: z.string().optional(),
  node: z.enum([
    "N0",
    "N1",
    "N2",
    "N3",
    "N4",
    "N5",
    "N6",
    "N7",
    "N8",
    "N9",
    "N10",
    "DONE"
  ]),
  alerts: z.array(Alert),
  incident: Incident.optional(),
  evidence: z.array(Evidence),
  actions: z.array(Action),
  counters: z.object({
    replans: z.number(),
    parseRetries: z.number(),
    verifyAttempts: z.number()
  }),
  timeline: z.array(
    z.object({
      ts: z.string().datetime(),
      nodeId: z.string(),
      event: z.string(),
      detail: z.unknown().optional()
    })
  ),
  outcome: z.enum(["recovered", "escalated", "aborted"]).optional()
});

export type Alert = z.infer<typeof Alert>;
export type Incident = z.infer<typeof Incident>;
export type Evidence = z.infer<typeof Evidence>;
export type Action = z.infer<typeof Action>;
export type RunState = z.infer<typeof RunState>;
