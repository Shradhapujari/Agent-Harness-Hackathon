import type { NodeFn } from "../graph.js";
import { timeline } from "./shared.js";

const cell = (value: unknown) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

export function reportMarkdown(
  state: Parameters<NodeFn>[0],
  events: unknown[] = []
): string {
  const incident = state.incident;
  const primary = new Set(incident?.primary ?? []);
  const symptom = new Set(incident?.symptoms ?? []);
  const noise = new Set(incident?.noise ?? []);
  const lines = [
    `# Incident ${state.runId} — ${incident?.rootCause.kind ?? "unknown"} on ${incident?.rootCause.scope.nodes.join(", ") ?? "unknown"}`,
    "",
    `outcome: ${state.outcome ?? "escalated"}`,
    "",
    "## Timeline",
    "",
    ...state.timeline.map(
      (item) =>
        `${item.ts} · ${item.nodeId} · ${item.event}${item.detail === undefined ? "" : ` · ${JSON.stringify(item.detail)}`}`
    ),
    "",
    "## Alerts",
    "",
    `total ${state.alerts.length} · primary ${primary.size} · symptoms ${symptom.size} · noise ${noise.size}`,
    "",
    "| fingerprint | name | severity |",
    "|---|---|---|",
    ...state.alerts
      .filter((alert) => primary.has(alert.fingerprint))
      .map(
        (alert) =>
          `| ${cell(alert.fingerprint)} | ${cell(alert.name)} | ${cell(alert.severity)} |`
      ),
    "",
    "## Evidence",
    "",
    "| id | layer | source | summary |",
    "|---|---|---|---|",
    ...state.evidence.map(
      (item) =>
        `| ${cell(item.id)} | ${cell(item.layer)} | ${cell(item.source)} | ${cell(item.summary)} |`
    ),
    "",
    "## Actions",
    "",
    "| rank | tool | args | kind | status | decidedBy | decidedAt |",
    "|---:|---|---|---|---|---|---|",
    ...state.actions.map(
      (action) =>
        `| ${action.rank} | ${cell(action.tool)} | ${cell(JSON.stringify(action.args))} | ${action.kind} | ${action.status} | ${cell(action.decidedBy)} | ${cell(action.decidedAt)} |`
    ),
    "",
    "## Harness trace",
    "",
    `session: ${state.sessionId ?? "none"} · turns: ${count(events, "turn.created")} · subagent threads: ${count(events, "thread.created")} · tool calls: ${count(events, "tool.call")} · tokens: ${tokens(events)}`,
    "",
    "Detailed turns, subagent threads, tool calls, and token events are in the run events.jsonl file.",
    "",
    "## Verification",
    "",
    cell(
      [...state.timeline]
        .reverse()
        .find((item) => item.event === "verification")?.detail ??
        "not completed"
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export const report: NodeFn = async (state, context) => {
  if (!context.writeReport) throw new Error("N10 requires a report writer");
  const events = context.readEvents ? await context.readEvents(state) : [];
  await context.writeReport(state, reportMarkdown(state, events));
  return { timeline: [timeline(context.clock(), "N10", "report_written")] };
};

function eventType(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return String((value as { type?: unknown }).type ?? "");
}

function count(events: unknown[], type: string): number {
  return events.filter((event) => eventType(event) === type).length;
}

function tokens(events: unknown[]): number {
  return events.reduce<number>((total, event) => {
    if (!event || typeof event !== "object") return total;
    const usage = (event as { usage?: { totalTokens?: unknown } }).usage;
    return (
      total + (typeof usage?.totalTokens === "number" ? usage.totalTokens : 0)
    );
  }, 0);
}
