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
    const [page, status] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/api/status`)
    ]);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Incident control");
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
    const runDirectory = join(runsDirectory, runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "approval-pending.json"),
      JSON.stringify({ runId, action: { id: actionId } }),
      "utf8"
    );

    const stale = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        runId: "inc-20260829-ffff",
        actionId,
        allow: true
      })
    });
    expect(stale.status).toBe(409);

    const current = await fetch(`${baseUrl}/api/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ runId, actionId, allow: true })
    });
    expect(current.status).toBe(202);
    await expect(
      readFile(join(runDirectory, "approval-decision.json"), "utf8").then(
        JSON.parse
      )
    ).resolves.toMatchObject({ actionId, allow: true });
  });
});
