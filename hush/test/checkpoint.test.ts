import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkpointPath,
  loadCheckpoint,
  saveCheckpoint
} from "../src/checkpoint.js";
import { state } from "./helpers.js";

describe("checkpoint", () => {
  it("writes atomically and validates a loaded state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hush-checkpoint-"));
    const current = state();
    await saveCheckpoint(current, directory);

    expect(await loadCheckpoint(current.runId, directory)).toEqual(current);
    expect(
      JSON.parse(
        await readFile(checkpointPath(current.runId, directory), "utf8")
      )
    ).toEqual(current);
  });
});
