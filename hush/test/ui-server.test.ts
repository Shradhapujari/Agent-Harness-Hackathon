import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const port = 43_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
let server: Server;
let runsDirectory: string;

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("local UI server did not become ready");
}

describe("local UI server", () => {
  beforeAll(async () => {
    runsDirectory = await mkdtemp(join(tmpdir(), "hush-ui-runs-"));
    process.env.HUSH_UI_PORT = String(port);
    process.env.HUSH_RUNS_DIRECTORY = runsDirectory;
    server = (await import("../src/ui-server.js")).server;
    await waitUntilReady();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves the operator console and reports unavailable dependencies", async () => {
    const [page, styles, script, status] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/styles.css`),
      fetch(`${baseUrl}/app.js`),
      fetch(`${baseUrl}/api/status`)
    ]);

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Incident control");
    // The regions the operator has to read to answer "how many alarms, and
    // what is the agent doing about them" all have to be on the one page.
    for (const region of [
      'id="alarm-count"',
      'id="split-bar"',
      'id="lanes"',
      'id="relay-list"',
      'id="relay-caption"',
      'id="timeline"',
      'id="approval-drawer"'
    ])
      expect(html).toContain(region);

    // The checkpoint appears from a poll rather than a click, so it has to
    // announce itself and be able to take focus.
    expect(html).toMatch(/id="approval-drawer"[\s\S]*?role="dialog"/u);
    expect(html).toMatch(/id="approval-drawer"[\s\S]*?tabindex="-1"/u);

    expect(styles.status).toBe(200);
    const css = await styles.text();
    // Linear's canvas token and the approval drawer's off-screen rest state.
    expect(css).toContain("--canvas: #010102");
    expect(css).toContain("transform: translateY(100%)");

    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      server: { ok: true },
      services: {
        bmc: { ok: expect.any(Boolean) },
        alertmanager: { ok: expect.any(Boolean) }
      }
    });
  });

  it("rejects an unknown scenario before creating side effects", async () => {
    const response = await fetch(`${baseUrl}/api/incidents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl
      },
      body: JSON.stringify({ scenario: "unknown" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "scenario must be hang or crac"
    });
  });

  it("rejects cross-origin mutation requests", async () => {
    const response = await fetch(`${baseUrl}/api/incidents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: JSON.stringify({ scenario: "hang" })
    });

    expect(response.status).toBe(403);
  });

  it("binds approval decisions to both the run and action", async () => {
    const runId = "inc-20260829-abcd";
    const actionId = "act-1";
    const toolCallId = "call-1";
    const runDirectory = join(runsDirectory, runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "approval-pending.json"),
      JSON.stringify({
        runId,
        action: { id: actionId },
        pending: {
          toolCallId,
          tool: "redfish.reset_system",
          args: { system_id: "R4-N04", reset_type: "ForceRestart" }
        }
      }),
      "utf8"
    );

    const stale = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        runId: "inc-20260829-ffff",
        actionId,
        toolCallId,
        allow: true
      })
    });
    expect(stale.status).toBe(409);

    const current = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ runId, actionId, toolCallId, allow: true })
    });
    expect(current.status).toBe(202);
    await expect(
      readFile(join(runDirectory, "approval-decision.json"), "utf8").then(
        JSON.parse
      )
    ).resolves.toMatchObject({ runId, actionId, toolCallId, allow: true });
  });

  it("rejects a blank denial reason at the server boundary", async () => {
    const response = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        runId: "inc-20260829-abcd",
        actionId: "act-1",
        toolCallId: "call-2",
        allow: false,
        reason: "   "
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "a reason is required to deny an action"
    });
  });
});
