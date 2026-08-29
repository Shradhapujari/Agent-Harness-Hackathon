import { Command } from "commander";
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

export function createProgram(): Command {
  const program = new Command();
  program.name("hush").description("Hush incident operator");

  program
    .command("incident")
    .requiredOption("--scenario <scenario>", "crac or hang")
    .action((options: { scenario: string }) => {
      if (options.scenario !== "crac" && options.scenario !== "hang") {
        throw new Error("scenario must be crac or hang");
      }
      console.log(JSON.stringify(commandSummary("incident", options.scenario)));
    });

  program.command("resume").action(() => {
    console.log(JSON.stringify(commandSummary("resume")));
  });

  return program;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  createProgram().parse();
}
