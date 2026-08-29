// I1 recorder (temporary): drive the real harness once and keep the fixtures.
import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";

import { Harness } from "../src/trueforge.js";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

const RUN = "i1-crac";
const EVENTS = `runs/${RUN}/events.jsonl`;
await mkdir(`runs/${RUN}`, { recursive: true });

const sink = (event: TrueForgeApi.TurnStreamingEvent): void => {
  appendFileSync(EVENTS, `${JSON.stringify(event)}\n`);
};
const harness = new Harness("hush-operator", sink);
const session = await harness.openSession();
console.log("session", session);

const turns: Awaited<ReturnType<Harness["turn"]>>[] = [];
const listing = await harness.turn(session, "List the systems on the BMC.", {
  runId: RUN,
  nodeId: "I1"
});
turns.push(listing);
const called = listing.events
  .filter((e) => e.type === "model.message")
  .flatMap(
    (e) =>
      (e as { toolCalls?: { toolInfo: { name: string } }[] }).toolCalls ?? []
  )
  .map((c) => c.toolInfo.name);
console.log("tools called:", called.join(", ") || "(none)");
console.log("text:", listing.text.slice(0, 300));

let reset;
try {
  reset = await harness.turn(
    session,
    "N7 execute. Call exactly the supplied tool once with exactly the supplied arguments.\n" +
      'Action: {"tool": "redfish.reset_system", "args": {"system_id": "R4-N04", ' +
      '"reset_type": "ForceRestart", "idempotency_key": "i1-crac-R4-N04", "run_id": "i1-crac"}}',
    { runId: RUN, nodeId: "I1" }
  );
  turns.push(reset);
} catch (error) {
  console.log("adapter threw:", (error as Error).message);
  reset = undefined;
}
console.log("pendingApproval:", JSON.stringify(reset?.pendingApproval));

if (reset?.pendingApproval !== undefined) {
  const raw = reset.events.find((e) => e.type === "tool.approval_required");
  await writeFile(
    "test/fixtures/events/approval.json",
    `${JSON.stringify(raw, null, 2)}\n`
  );
  const denied = await harness.approve(
    session,
    reset.pendingApproval,
    false,
    "I1 recording: the lab stays as it is."
  );
  turns.push(denied);
  console.log("after deny:", denied.text.slice(0, 200));
}

await writeFile(
  "test/fixtures/session-crac.jsonl",
  turns.map((t) => JSON.stringify(t)).join("\n") + "\n"
);
console.log("turns recorded:", turns.length);
