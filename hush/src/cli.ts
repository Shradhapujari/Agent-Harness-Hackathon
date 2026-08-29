import { Command, Option } from "commander";
import type { CommanderError } from "commander";
import { pathToFileURL } from "node:url";

import { runIncident } from "./incident.js";

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
  execute = false
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
        if (execute) await runIncident(options);
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await createProgram(undefined, undefined, true).parseAsync();
}
