import { describe, expect, it } from "vitest";

import { Action, Alert, Evidence, RunState } from "../src/state.js";
import { action, alert, evidence, state } from "./helpers.js";

describe("state schemas", () => {
  it("applies evidence and action defaults", () => {
    expect(
      Evidence.parse({ ...evidence("netbox"), source: undefined }).source
    ).toBe("live");
    expect(Action.parse({ ...action(), status: undefined }).status).toBe(
      "proposed"
    );
  });

  it("rejects invalid checkpoint state", () => {
    expect(() => RunState.parse({ ...state(), graphId: "other" })).toThrow();
    expect(() => RunState.parse({ ...state(), runId: "../outside" })).toThrow();
    expect(() => Action.parse({ ...action(), kind: "read" })).toThrow();
    expect(() => Alert.parse({ ...alert(), startsAt: "later" })).toThrow();
  });
});
