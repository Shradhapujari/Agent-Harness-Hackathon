import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { stdin, stdout } from "node:process";
import { TrueForge } from "@truefoundry/trueforge-sdk";

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

function trueForgeUiPoller(): UiDecisionPoller {
  const client = new TrueForge({
    baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
    timeoutInSeconds: 900
  });
  return async (request, signal) => {
    while (!signal.aborted) {
      const page = await client.sessions.listTurns(
        request.sessionId,
        undefined,
        { abortSignal: signal }
      );
      const event = page.data
        .flatMap((turn) => turn.input ?? [])
        .find(
          (item) =>
            item.type === "user.tool_approval" &&
            item.toolCallId === request.pending.toolCallId
        );
      if (event?.type === "user.tool_approval") {
        const allow = event.approval.status === "allow";
        return {
          allow,
          by: "human:trueforge-ui",
          at: new Date().toISOString(),
          ...(!allow && "reason" in event.approval
            ? { reason: event.approval.reason }
            : {})
        };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    }
    throw signal.reason ?? new Error("approval timeout");
  };
}

export function createApprovalBridge(
  mode = process.env.HUSH_APPROVAL_MODE ?? "terminal",
  uiPoller?: UiDecisionPoller
): ApprovalBridge {
  if (mode === "terminal") return new TerminalApproval();
  if (mode === "ui") return new UiApproval(uiPoller ?? trueForgeUiPoller());
  throw new Error(`unknown HUSH_APPROVAL_MODE: ${mode}`);
}
