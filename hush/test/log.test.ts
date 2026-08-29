import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/log.js";

describe("structured logger", () => {
  it("includes graph, run, and node identifiers", () => {
    const sink = vi.fn();
    const log = createLogger("hush-incident", "inc-test", "session-1", sink);
    log("N4", "edge", { next: "N5" });
    expect(JSON.parse(sink.mock.calls[0][0])).toEqual({
      graph_id: "hush-incident",
      run_id: "inc-test",
      node_id: "N4",
      session_id: "session-1",
      event: "edge",
      detail: { next: "N5" }
    });
  });

  it("omits absent detail", () => {
    const lines: string[] = [];
    createLogger("hush-incident", "inc-test", undefined, (line) =>
      lines.push(line)
    )("N0", "poll");
    expect(JSON.parse(lines[0])).not.toHaveProperty("detail");
    expect(JSON.parse(lines[0])).toHaveProperty("session_id", null);
  });
});
