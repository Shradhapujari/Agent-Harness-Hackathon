import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHarness,
  FakeHarness,
  lastJsonBlock,
  unwrapToolCall
} from "../src/trueforge.js";

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

  it("loads the configured fixture and sends replayed events to the sink", async () => {
    const events: TrueForgeApi.TurnStreamingEvent[] = [];
    const directory = await mkdtemp(join(tmpdir(), "hush-factory-"));
    const fixture = join(directory, "turns.jsonl");
    await writeFile(
      fixture,
      `${JSON.stringify({ text: "fixture turn", events: [{ type: "turn.done" }] })}\n`,
      "utf8"
    );
    vi.stubEnv("HUSH_FAKE_HARNESS", "1");
    vi.stubEnv("HUSH_FAKE_HARNESS_FIXTURE", fixture);

    const harness = await createHarness((event) => events.push(event));
    const turn = await harness.turn("fake-session", "ignored", {
      runId: "inc-test",
      nodeId: "N1"
    });

    expect(turn.text).toContain("fixture");
    expect(events).toEqual(turn.events);
  });

  it("does not consume or emit a fake turn after cancellation", async () => {
    const events: TrueForgeApi.TurnStreamingEvent[] = [];
    const directory = await mkdtemp(join(tmpdir(), "hush-cancelled-"));
    const fixture = join(directory, "turns.jsonl");
    await writeFile(
      fixture,
      `${JSON.stringify({ text: "unused", events: [{ type: "turn.done" }] })}\n`,
      "utf8"
    );
    const harness = await FakeHarness.fromFile(fixture, (event) =>
      events.push(event)
    );
    const controller = new AbortController();
    controller.abort(new Error("deadline exceeded"));

    await expect(
      harness.turn(
        "fake-session",
        "ignored",
        { runId: "inc-test", nodeId: "N1" },
        controller.signal
      )
    ).rejects.toThrow("deadline exceeded");
    expect(events).toEqual([]);
    await expect(harness.turn()).resolves.toMatchObject({ text: "unused" });
  });

  it("explains that fake mode needs the I1 recording", async () => {
    vi.stubEnv("HUSH_FAKE_HARNESS", "1");
    vi.stubEnv("HUSH_FAKE_HARNESS_FIXTURE", undefined);

    await expect(createHarness()).rejects.toThrow(
      "HUSH_FAKE_HARNESS_FIXTURE is required until I1 records session-crac.jsonl"
    );
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
    expect(request.manifest.model.name).toBe("openai/gpt-5-6-luna");
    expect(redfish?.requireApprovalForTools).toEqual(["reset_system"]);
    expect(request.manifest.skills).toEqual([{ name: "hush-triage" }]);
  });
});

describe("unwrapToolCall", () => {
  it("qualifies an MCP call with the server that owns it", () => {
    // Shape recorded from a live approval at I1.
    expect(
      unwrapToolCall(
        { name: "reset_system", serverName: "redfish" },
        { system_id: "R4-N04", reset_type: "ForceRestart" }
      )
    ).toEqual({
      tool: "redfish.reset_system",
      args: { system_id: "R4-N04", reset_type: "ForceRestart" }
    });
  });

  it("names the MCP tool TrueForge hid inside its call_tool envelope", () => {
    expect(
      unwrapToolCall(
        { name: "call_tool" },
        {
          mcp_server: "redfish",
          tool_name: "reset_system",
          input: { system_id: "R4-N04" }
        }
      )
    ).toEqual({
      tool: "redfish.reset_system",
      args: { system_id: "R4-N04" }
    });
  });

  it("passes anything that is not an envelope straight through", () => {
    expect(
      unwrapToolCall({ name: "create_sub_agent" }, { instructions: "…" })
    ).toEqual({ tool: "create_sub_agent", args: { instructions: "…" } });
    expect(unwrapToolCall({ name: "call_tool" }, "not-json")).toEqual({
      tool: "call_tool",
      args: "not-json"
    });
  });
});

describe("recorded I1 session", () => {
  it("replays the held approval without a TrueForge connection", async () => {
    const harness = await FakeHarness.fromFile(
      new URL("./fixtures/session-crac.jsonl", import.meta.url).pathname
    );
    await harness.turn();
    const reset = await harness.turn();

    expect(reset.pendingApproval?.tool).toBe("redfish.reset_system");
    expect(reset.events.some((e) => e.type === "tool.approval_required")).toBe(
      true
    );
    expect(JSON.stringify(reset.events)).not.toContain("reasoningContent");
  });
});
