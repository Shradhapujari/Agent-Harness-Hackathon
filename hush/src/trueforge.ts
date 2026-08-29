import { readFile } from "node:fs/promises";

import { TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export type PendingApproval = {
  threadId: string;
  toolCallId: string;
  tool: string;
  args: unknown;
};
export interface TurnResult {
  text: string;
  events: TrueForgeApi.TurnStreamingEvent[];
  pendingApproval?: PendingApproval;
}
export interface HarnessClient {
  openSession(signal?: AbortSignal): Promise<string>;
  turn(
    sessionId: string,
    message: string,
    tag: { runId: string; nodeId: string },
    signal?: AbortSignal
  ): Promise<TurnResult>;
  approve(
    sessionId: string,
    pending: PendingApproval,
    allow: boolean,
    reason?: string,
    signal?: AbortSignal
  ): Promise<TurnResult>;
}

export class Harness implements HarnessClient {
  private readonly client: TrueForge;
  constructor(
    private readonly agentName = "hush-operator",
    private readonly sink: (
      event: TrueForgeApi.TurnStreamingEvent
    ) => void = () => undefined
  ) {
    this.client = new TrueForge({
      baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
      timeoutInSeconds: 900
    });
  }
  async openSession(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const response = await this.client.sessions.create(
      { agent: { name: this.agentName } },
      { abortSignal: signal }
    );
    return response.data.id;
  }
  async turn(
    sessionId: string,
    message: string,
    tag: { runId: string; nodeId: string },
    signal?: AbortSignal
  ): Promise<TurnResult> {
    return this.stream(
      sessionId,
      [
        {
          type: "user.message",
          content: `[hush run_id=${tag.runId} node=${tag.nodeId}]\n${message}`
        }
      ],
      signal
    );
  }
  async approve(
    sessionId: string,
    pending: PendingApproval,
    allow: boolean,
    reason?: string,
    signal?: AbortSignal
  ): Promise<TurnResult> {
    return this.stream(
      sessionId,
      [
        {
          type: "user.tool_approval",
          threadId: pending.threadId,
          toolCallId: pending.toolCallId,
          approval: allow
            ? { status: "allow" }
            : { status: "deny", ...(reason === undefined ? {} : { reason }) }
        }
      ],
      signal
    );
  }
  private async stream(
    sessionId: string,
    input: TrueForgeApi.TurnInputItem[],
    signal?: AbortSignal
  ): Promise<TurnResult> {
    signal?.throwIfAborted();
    try {
      const stream = await this.client.sessions.createTurnStream(
        sessionId,
        { input, previousTurnId: "auto" },
        { abortSignal: signal }
      );
      const result: TurnResult = { text: "", events: [] };
      const calls = new Map<string, { tool: string; args: unknown }>();
      for await (const event of stream) {
        signal?.throwIfAborted();
        this.sink(event);
        result.events.push(event);
        if (event.type === "model.message.delta")
          result.text += event.content ?? "";
        if (event.type === "model.message")
          for (const call of event.toolCalls ?? [])
            calls.set(call.id, {
              tool: call.toolInfo.name,
              args: parseToolArguments(call.function.arguments)
            });
        if (event.type === "tool.approval_required") {
          const reference = event.toolCalls[0];
          if (reference === undefined)
            throw new Error("approval event contained no tool call references");
          const call = calls.get(reference.id);
          if (call === undefined)
            throw new Error(
              `approval event referenced unknown tool call ${reference.id}`
            );
          result.pendingApproval = {
            threadId: event.threadId,
            toolCallId: reference.id,
            ...call
          };
        }
        if (event.type === "turn.done") break;
      }
      return result;
    } catch (error) {
      if (!signal?.aborted) throw error;
      await this.client.sessions.cancel(sessionId).catch(() => undefined);
      throw signal.reason ?? error;
    }
  }
}

export class FakeHarness implements HarnessClient {
  private cursor = 0;
  private constructor(
    private readonly turns: TurnResult[],
    private readonly sink: (
      event: TrueForgeApi.TurnStreamingEvent
    ) => void = () => undefined
  ) {}
  static async fromFile(
    path: string,
    sink?: (event: TrueForgeApi.TurnStreamingEvent) => void
  ): Promise<FakeHarness> {
    const lines = (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "");
    return new FakeHarness(
      lines.map((line) => JSON.parse(line) as TurnResult),
      sink
    );
  }
  async openSession(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return "fake-session";
  }
  async turn(
    _sessionId?: string,
    _message?: string,
    _tag?: { runId: string; nodeId: string },
    signal?: AbortSignal
  ): Promise<TurnResult> {
    signal?.throwIfAborted();
    return this.next();
  }
  async approve(
    _sessionId?: string,
    _pending?: PendingApproval,
    _allow?: boolean,
    _reason?: string,
    signal?: AbortSignal
  ): Promise<TurnResult> {
    signal?.throwIfAborted();
    return this.next();
  }
  private next(): TurnResult {
    const turn = this.turns[this.cursor++];
    if (turn === undefined) throw new Error("fake harness fixture exhausted");
    for (const event of turn.events) this.sink(event);
    return turn;
  }
}

export async function createHarness(
  sink?: (event: TrueForgeApi.TurnStreamingEvent) => void
): Promise<HarnessClient> {
  if (process.env.HUSH_FAKE_HARNESS === "1") {
    const fixture = process.env.HUSH_FAKE_HARNESS_FIXTURE;
    if (!fixture)
      throw new Error(
        "HUSH_FAKE_HARNESS_FIXTURE is required until I1 records session-crac.jsonl"
      );
    return FakeHarness.fromFile(fixture, sink);
  }
  return new Harness("hush-operator", sink);
}
export function lastJsonBlock(text: string): unknown {
  const match = [...text.matchAll(/```json\s*([\s\S]*?)```/giu)].at(-1);
  if (match?.[1] === undefined) throw new Error("no json block");
  return JSON.parse(match[1]);
}
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
