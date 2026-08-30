import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const port = 43_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
let server: Server;

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
    process.env.HUSH_UI_PORT = String(port);
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
    expect(await page.text()).toContain("Incident observatory");
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "unknown" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "scenario must be hang or crac"
    });
  });
});
