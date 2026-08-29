import { CommanderError } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";

describe("Hush CLI", () => {
  it("executes an incident command and writes its summary", () => {
    const output: unknown[] = [];
    const program = createProgram((summary) => output.push(summary));

    program.parse(["node", "hush", "incident", "--scenario", "crac"]);

    expect(output).toEqual([
      {
        command: "incident",
        scenario: "crac",
        until: "DONE"
      }
    ]);
  });

  it("executes a resume command and writes its summary", () => {
    const output: unknown[] = [];
    const program = createProgram((summary) => output.push(summary));

    program.parse(["node", "hush", "resume", "inc-20260829-abcd"]);

    expect(output).toEqual([{ command: "resume", runId: "inc-20260829-abcd" }]);
  });

  it("rejects an unsupported incident scenario", () => {
    const errors: string[] = [];
    const program = createProgram(undefined, (error): never => {
      throw error;
    });
    program.configureOutput({ writeErr: (message) => errors.push(message) });

    expect(() => {
      program.parse(["node", "hush", "incident", "--scenario", "unknown"]);
    }).toThrow(CommanderError);
    expect(errors.join("")).toContain("Allowed choices are crac, hang");
  });
});
