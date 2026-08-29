/**
 * Re-record the I1 fixtures against a live stack and a running TrueForge.
 *
 *     cd hush && npx tsx scripts/i1-record.ts
 *
 * Two turns are recorded: a read-only listing and a destructive reset that the
 * harness must hold at the approval gate, then deny. The raw event stream stays
 * in the gitignored `runs/<runId>/`; only the slimmed turns below are kept as
 * fixtures, so no full model transcript is committed.
 */
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { createLogger } from "../src/log.js";
import { Harness, type TurnResult } from "../src/trueforge.js";

const RUN_ID = "i1-crac";
const NODE_ID = "N7";
const EVENTS = `runs/${RUN_ID}/events.jsonl`;

/** Events worth keeping: the turn's shape and its tool traffic, not its prose. */
const KEEP = new Set([
  "turn.created",
  "mcp.initialize",
  "tool.response",
  "tool.approval_required",
  "turn.done"
]);

function slim(turn: TurnResult): TurnResult {
  return {
    ...turn,
    events: turn.events.filter((event) => KEEP.has(event.type))
  };
}

await mkdir(`runs/${RUN_ID}`, { recursive: true });
// Truncate first: appending would blend this session with an earlier one and
// leave a plausible-looking timeline that never happened.
await writeFile(EVENTS, "");

const sink = (event: TrueForgeApi.TurnStreamingEvent): void => {
  appendFileSync(EVENTS, `${JSON.stringify(event)}\n`);
};
const harness = new Harness("hush-operator", sink);
const sessionId = await harness.openSession();
const log = createLogger("hush", RUN_ID, sessionId);
log(NODE_ID, "session.opened");

const tag = { runId: RUN_ID, nodeId: NODE_ID };
const listing = await harness.turn(
  sessionId,
  "List the systems on the BMC.",
  tag
);
log(NODE_ID, "turn.recorded", {
  turn: "listing",
  events: listing.events.length
});

const reset = await harness.turn(
  sessionId,
  "N7 execute. Call exactly the supplied tool once with exactly the supplied arguments.\n" +
    'Action: {"tool": "redfish.reset_system", "args": {"system_id": "R4-N04", ' +
    '"reset_type": "ForceRestart", "idempotency_key": "i1-crac-R4-N04", "run_id": "i1-crac"}}',
  tag
);
const pending = reset.pendingApproval;
if (pending === undefined) {
  // Overwriting the fixture with a half-recording would leave FakeHarness — and
  // therefore CI — with no approval to replay.
  log(NODE_ID, "recording.failed", { reason: "no approval was requested" });
  throw new Error("no approval was requested; fixtures left untouched");
}
log(NODE_ID, "approval.pending", { tool: pending.tool });

const denied = await harness.approve(
  sessionId,
  pending,
  false,
  "I1 recording: the lab stays as it is."
);
log(NODE_ID, "approval.denied", { tool: pending.tool });

const approvalEvent = reset.events.find(
  (event) => event.type === "tool.approval_required"
);
await writeFile(
  "test/fixtures/events/approval.json",
  `${JSON.stringify(approvalEvent, null, 2)}\n`
);
await writeFile(
  "test/fixtures/session-crac.jsonl",
  `${[listing, reset, denied].map((turn) => JSON.stringify(slim(turn))).join("\n")}\n`
);
log(NODE_ID, "fixtures.written", { turns: 3 });
