import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHarness, FakeHarness, lastJsonBlock } from "../src/trueforge.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lastJsonBlock", () => {
  it("returns the last fenced JSON value", () => {
    expect(
      lastJsonBlock('```json\n{"old":true}\n```\n```JSON\n{"ok":true}\n```')
    ).toEqual({ ok: true });
  });

  it("rejects output without a JSON fence", () => {
    expect(() => lastJsonBlock('{"ok":true}')).toThrow("no json block");
  });
});

describe("FakeHarness", () => {
  it("replays recorded turns without a TrueForge connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hush-harness-"));
    const fixture = join(directory, "turns.jsonl");
    await writeFile(
      fixture,
      `${JSON.stringify({ text: "first", events: [] })}\n${JSON.stringify({ text: "approved", events: [] })}\n`,
      "utf8"
    );
    const harness = await FakeHarness.fromFile(fixture);

    await expect(harness.openSession()).resolves.toBe("fake-session");
    await expect(harness.turn()).resolves.toMatchObject({ text: "first" });
    await expect(harness.approve()).resolves.toMatchObject({
      text: "approved"
    });
    await expect(harness.turn()).rejects.toThrow("fixture exhausted");
  });

  it("loads the default fixture and sends replayed events to the sink", async () => {
    const events: TrueForgeApi.TurnStreamingEvent[] = [];
    vi.stubEnv("HUSH_FAKE_HARNESS", "1");
    vi.stubEnv("HUSH_FAKE_HARNESS_FIXTURE", undefined);

    const harness = await createHarness((event) => events.push(event));
    const turn = await harness.turn("fake-session", "ignored", {
      runId: "inc-test",
      nodeId: "N1"
    });

    expect(turn.text).toContain("fixture");
    expect(events).toEqual(turn.events);
  });
});

describe("agent manifest", () => {
  it("locks destructive Redfish calls behind approval", async () => {
    const request = JSON.parse(
      await readFile(new URL("../agent.json", import.meta.url), "utf8")
    ) as TrueForgeApi.CreateAgentRequest;
    const redfish = request.manifest.mcpServers?.find(
      (server) => server.name === "redfish"
    );

    expect(request.manifest.mcpServers).toHaveLength(5);
    expect(redfish?.requireApprovalForTools).toEqual(["reset_system"]);
    expect(request.manifest.skills).toEqual([{ name: "hush-triage" }]);
  });
});
