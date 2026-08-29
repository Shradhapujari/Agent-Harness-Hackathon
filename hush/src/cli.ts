import { Command, Option } from "commander";
import type { CommanderError } from "commander";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { saveCheckpoint } from "./checkpoint.js";
import { runIncident, type IncidentDependencies } from "./incident.js";
import { createLogger } from "./log.js";
import { filePromptLoader } from "./nodes/shared.js";
import { createHarness } from "./trueforge.js";

export type CommandSummary = {
  command: "incident" | "resume";
  scenario?: "crac" | "hang";
  until?: "N3";
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
        .choices(["N3"])
        .default("N3")
    )
    .action(
      async (options: {
        scenario: CommandSummary["scenario"];
        until: "N3";
      }) => {
        if (execute) await runIncident(options, incidentDependencies);
        else write(commandSummary("incident", options.scenario, options.until));
      }
    );

  program.command("resume").action(() => {
    write(commandSummary("resume"));
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
