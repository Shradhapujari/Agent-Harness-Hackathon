import { describe, expect, it } from "vitest";

import { commandSummary } from "../src/cli.js";

describe("commandSummary", () => {
  it("describes a CRAC incident command", () => {
    expect(commandSummary("incident", "crac")).toEqual({
      command: "incident",
      scenario: "crac"
    });
  });

  it("describes a resume command", () => {
    expect(commandSummary("resume")).toEqual({ command: "resume" });
  });
});
