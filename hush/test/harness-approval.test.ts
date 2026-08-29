import { describe, expect, it, vi } from "vitest";

const createTurnStream = vi.fn();
const listEvents = vi.fn();

vi.mock("@truefoundry/trueforge-sdk", () => ({
  TrueForge: class {
    sessions = { createTurnStream, listEvents };
  }
}));

const { Harness } = await import("../src/trueforge.js");

/** The streamed events of a turn whose destructive call was held at the gate. */
function heldTurn(): unknown[] {
  return [
    // The live stream reports a model message with no tool calls on it at all.
    { type: "model.message", id: "src-1", threadId: "main" },
    {
      type: "tool.approval_required",
      threadId: "main",
      toolCalls: [{ id: "call-1", sourceEventId: "src-1" }]
    },
    { type: "turn.done", state: { status: "done" } }
  ];
}

function storedEvents(
  toolInfo: Record<string, unknown>,
  args: string
): unknown {
  return {
    data: [
      {
        event: {
          type: "model.message",
          id: "src-1",
          toolCalls: [
            { id: "call-1", toolInfo, function: { name: "x", arguments: args } }
          ]
        }
      }
    ]
  };
}

describe("Harness approval resolution", () => {
  it("resolves a held MCP call from the stored event the stream omits", async () => {
    createTurnStream.mockResolvedValue(heldTurn());
    listEvents.mockResolvedValue(
      storedEvents(
        { name: "reset_system", serverName: "redfish" },
        '{"system_id":"R4-N04","reset_type":"ForceRestart"}'
      )
    );

    const result = await new Harness("hush-operator").turn("s1", "reset it", {
      runId: "r1",
      nodeId: "N7"
    });

    expect(listEvents).toHaveBeenCalledWith("s1", undefined, {
      abortSignal: undefined
    });
    expect(result.pendingApproval).toEqual({
      threadId: "main",
      toolCallId: "call-1",
      tool: "redfish.reset_system",
      args: { system_id: "R4-N04", reset_type: "ForceRestart" }
    });
  });

  it("unwraps a held call made through TrueForge's own call_tool", async () => {
    createTurnStream.mockResolvedValue(heldTurn());
    listEvents.mockResolvedValue(
      storedEvents(
        { type: "truefoundry-system", name: "call_tool" },
        '{"mcp_server":"redfish","tool_name":"reset_system","input":{"system_id":"R4-N04"}}'
      )
    );

    const result = await new Harness("hush-operator").turn("s1", "reset it", {
      runId: "r1",
      nodeId: "N7"
    });

    expect(result.pendingApproval?.tool).toBe("redfish.reset_system");
    expect(result.pendingApproval?.args).toEqual({ system_id: "R4-N04" });
  });

  it("forwards the run's abort signal to the lookup", async () => {
    createTurnStream.mockResolvedValue(heldTurn());
    listEvents.mockResolvedValue(
      storedEvents({ name: "reset_system", serverName: "redfish" }, "{}")
    );
    const controller = new AbortController();

    await new Harness("hush-operator").turn(
      "s1",
      "reset it",
      { runId: "r1", nodeId: "N7" },
      controller.signal
    );

    expect(listEvents).toHaveBeenCalledWith("s1", undefined, {
      abortSignal: controller.signal
    });
  });

  it("still reports a call it cannot find in the stored events", async () => {
    createTurnStream.mockResolvedValue(heldTurn());
    listEvents.mockResolvedValue({ data: [] });

    await expect(
      new Harness("hush-operator").turn("s1", "reset it", {
        runId: "r1",
        nodeId: "N7"
      })
    ).rejects.toThrow("approval event referenced unknown tool call call-1");
  });
});
