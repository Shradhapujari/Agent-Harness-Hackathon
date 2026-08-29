import { Command, Option } from "commander";
import type { CommanderError } from "commander";
import { pathToFileURL } from "node:url";

export type CommandSummary = {
  command: "incident" | "resume";
  scenario?: "crac" | "hang";
};

export function commandSummary(
  command: CommandSummary["command"],
  scenario?: CommandSummary["scenario"]
): CommandSummary {
  return { command, scenario };
}

export function createProgram(
  write: (summary: CommandSummary) => void = (summary) => {
    console.log(JSON.stringify(summary));
  },
  onExit?: (error: CommanderError) => never
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
    .action((options: { scenario: CommandSummary["scenario"] }) => {
      write(commandSummary("incident", options.scenario));
    });

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
  createProgram().parse();
}
