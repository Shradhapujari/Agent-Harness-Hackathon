import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { stdin, stdout } from "node:process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ApprovalBridge } from "./graph.js";

type Decide = NonNullable<ApprovalBridge["decide"]>;
type Request = Parameters<Decide>[0];
type Decision = Awaited<ReturnType<Decide>>;

export class TerminalApproval implements ApprovalBridge {
  async decide(request: Request): Promise<Decision> {
    const blastRadius = request.evidence.find(
      (item) => item.layer === "netbox"
    );
    stdout.write(
      [
        "\n=== Hush approval required ===",
        `run: ${request.runId}`,
        `root cause: ${request.incident?.rootCause.kind ?? "unknown"}`,
        `action: ${request.action.tool} ${JSON.stringify(request.action.args)}`,
        `reason: ${request.action.reason}`,
        `blast radius: ${blastRadius?.summary ?? "unknown"}`,
        `evidence: ${request.action.evidence.join(", ")}`,
        "allow | deny [reason]\n"
      ].join("\n")
    );
    const reader = createInterface({ input: stdin, output: stdout });
    const timeout = AbortSignal.timeout(request.timeoutS * 1000);
    try {
      const answer = await reader.question("> ", { signal: timeout });
      const [command, ...words] = answer.trim().split(/\s+/u);
      const allow = command?.toLowerCase() === "allow";
      return {
        allow,
        by: `human:${userInfo().username}`,
        at: new Date().toISOString(),
        ...(!allow
          ? {
              reason:
                words.join(" ") || (timeout.aborted ? "timeout" : "denied")
            }
          : {})
      };
    } catch (error) {
      if (!timeout.aborted) throw error;
      return {
        allow: false,
        by: `human:${userInfo().username}`,
        at: new Date().toISOString(),
        reason: "approval timeout"
      };
    } finally {
      reader.close();
    }
  }
}

export type UiDecisionPoller = (
  request: Request,
  signal: AbortSignal
) => Promise<Decision>;

export class UiApproval implements ApprovalBridge {
  constructor(private readonly poll: UiDecisionPoller) {}
  async decide(request: Request): Promise<Decision> {
    stdout.write(`Approve in TrueForge UI -> session ${request.sessionId}\n`);
    const signal = AbortSignal.timeout(request.timeoutS * 1000);
    try {
      return await this.poll(request, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      return {
        allow: false,
        by: "human:trueforge-ui",
        at: new Date().toISOString(),
        reason: "approval timeout"
      };
    }
  }
}

export class WebApproval implements ApprovalBridge {
  constructor(
    private readonly runsDirectory = "runs",
    private readonly pollMilliseconds = 350
  ) {}

  async decide(request: Request): Promise<Decision> {
    const pendingPath = join(
      this.runsDirectory,
      request.runId,
      "approval-pending.json"
    );
    const decisionPath = join(
      this.runsDirectory,
      request.runId,
      "approval-decision.json"
    );
    await mkdir(dirname(pendingPath), { recursive: true });
    await rm(decisionPath, { force: true });
    const expectedArgs = {
      ...request.action.args,
      idempotency_key: request.action.idempotencyKey,
      run_id: request.runId
    };
    if (
      request.pending.tool !== request.action.tool ||
      !isDeepStrictEqual(request.pending.args, expectedArgs)
    ) {
      throw new Error("pending approval does not match planned action");
    }
    await writeFile(
      pendingPath,
      `${JSON.stringify(
        {
          runId: request.runId,
          sessionId: request.sessionId,
          action: request.action,
          pending: request.pending,
          incident: request.incident,
          evidence: request.evidence,
          requestedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const deadline = Date.now() + request.timeoutS * 1000;
    try {
      while (Date.now() < deadline) {
        try {
          const raw = JSON.parse(
            await readFile(decisionPath, "utf8")
          ) as Partial<Decision> & {
            runId?: string;
            actionId?: string;
            toolCallId?: string;
            tool?: string;
            args?: unknown;
          };
          if (
            raw.actionId !== request.action.id ||
            raw.runId !== request.runId ||
            raw.toolCallId !== request.pending.toolCallId ||
            raw.tool !== request.pending.tool ||
            !isDeepStrictEqual(raw.args, request.pending.args) ||
            typeof raw.allow !== "boolean"
          ) {
            throw new Error("approval decision does not match pending action");
          }
          return {
            allow: raw.allow,
            by: "human:hush-console",
            at: new Date().toISOString(),
            ...(raw.reason ? { reason: String(raw.reason).slice(0, 300) } : {})
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.pollMilliseconds)
        );
      }
      return {
        allow: false,
        by: "human:hush-console",
        at: new Date().toISOString(),
        reason: "approval timeout"
      };
    } finally {
      await rm(pendingPath, { force: true });
      await rm(decisionPath, { force: true });
    }
  }
}

export function createApprovalBridge(
  mode = process.env.HUSH_APPROVAL_MODE ?? "terminal",
  uiPoller?: UiDecisionPoller
): ApprovalBridge {
  if (mode === "terminal") return new TerminalApproval();
  if (mode === "web") return new WebApproval();
  if (mode === "ui" && uiPoller) return new UiApproval(uiPoller);
  // Falling back to the terminal here used to look harmless. It is not: the
  // operator who asked for `ui` is watching the TrueForge chat while the run
  // blocks on a stdin prompt nobody is reading, and APPROVAL_TIMEOUT_S then
  // denies the action on their behalf. Approval is the safety gate, so the
  // channel it is served on is not something to substitute quietly (I2).
  if (mode === "ui")
    throw new Error(
      "HUSH_APPROVAL_MODE=ui needs a UI decision poller; a TrueForge UI click " +
        "resumes the held tool call itself, so the controller cannot gate it " +
        "(see docs/i2-findings.md). Use HUSH_APPROVAL_MODE=terminal."
    );
  throw new Error(`unknown HUSH_APPROVAL_MODE: ${mode}`);
}
