import { Command, Option } from "commander";
import type { CommanderError } from "commander";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { createApprovalBridge } from "./approval.js";
import { runIncident, type IncidentDependencies } from "./incident.js";
import { createLogger } from "./log.js";
import { filePromptLoader } from "./nodes/shared.js";
import { HttpProbes } from "./probes.js";
import { createHarness } from "./trueforge.js";

export type CommandSummary = {
  command: "incident" | "resume";
  scenario?: "crac" | "hang";
  until?: "N3" | "DONE";
  runId?: string;
};

export function commandSummary(
  command: CommandSummary["command"],
  scenario?: CommandSummary["scenario"],
  until?: CommandSummary["until"]
): CommandSummary {
  return {
    command,
    ...(scenario === undefined ? {} : { scenario }),
    ...(until === undefined ? {} : { until })
  };
}

export function createProgram(
  write: (summary: CommandSummary) => void = (summary) => {
    console.log(JSON.stringify(summary));
  },
  onExit?: (error: CommanderError) => never,
  execute = false,
  incidentDependencies: IncidentDependencies = fileIncidentDependencies()
): Command {
  const program = new Command();
  program.name("hush").description("Hush incident operator");

  const incident = program
    .command("incident")
    .addOption(
      new Option("--scenario <scenario>", "crac or hang").choices([
        "crac",
        "hang"
      ])
    )
    .addOption(
      new Option("--until <node>", "stop after this node")
        .choices(["N3", "DONE"])
        .default("DONE")
    )
    .action(
      async (options: {
        scenario: CommandSummary["scenario"];
        until: "N3" | "DONE";
      }) => {
        if (execute) await runIncident(options, incidentDependencies);
        else write(commandSummary("incident", options.scenario, options.until));
      }
    );

  program
    .command("resume")
    .argument("<run-id>")
    .action(async (runId: string) => {
      if (execute) {
        const checkpoint = await loadCheckpoint(runId);
        await runIncident(
          { until: "DONE" },
          incidentDependencies,
          console.log,
          checkpoint
        );
      } else write({ command: "resume", runId });
    });

  if (onExit !== undefined) {
    program.exitOverride(onExit);
    incident.exitOverride(onExit);
  }

  return program;
}

function fileIncidentDependencies(): IncidentDependencies {
  return {
    clock: () => new Date(),
    createHarness: (runId) => {
      const eventsPath = `runs/${runId}/events.jsonl`;
      mkdirSync(dirname(eventsPath), { recursive: true });
      return createHarness((event) => {
        appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      });
    },
    save: saveCheckpoint,
    log: (state) => createLogger(state.graphId, state.runId, state.sessionId),
    loadPrompt: filePromptLoader,
    approval: createApprovalBridge(),
    probes: new HttpProbes(),
    sleep: (milliseconds, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true }
        );
      }),
    writeReport: async (state, markdown) => {
      await mkdir("reports", { recursive: true });
      await writeFile(`reports/${state.runId}.md`, markdown, "utf8");
    },
    readEvents: async (state) => {
      try {
        return (await readFile(`runs/${state.runId}/events.jsonl`, "utf8"))
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    runWithTimeout: (operation, timeoutMs, onTimeout) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          onTimeout();
          resolve(undefined);
        }, timeoutMs);
        operation.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          }
        );
      })
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await createProgram(undefined, undefined, true).parseAsync();
}
