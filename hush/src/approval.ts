import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { stdin, stdout } from "node:process";

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

export function createApprovalBridge(
  mode = process.env.HUSH_APPROVAL_MODE ?? "terminal",
  uiPoller?: UiDecisionPoller
): ApprovalBridge {
  if (mode === "terminal") return new TerminalApproval();
  if (mode === "ui" && uiPoller) return new UiApproval(uiPoller);
  if (mode === "ui") {
    stdout.write(
      "TrueForge UI clicks resume tools before controller checkpointing; using terminal approval mode.\n"
    );
    return new TerminalApproval();
  }
  throw new Error(`unknown HUSH_APPROVAL_MODE: ${mode}`);
}
