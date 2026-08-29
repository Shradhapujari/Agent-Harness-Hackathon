import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

  it("rejects run ids that could escape the checkpoint directory", () => {
    expect(() => checkpointPath("../outside")).toThrow("invalid run id");
    expect(() => checkpointPath("inc-test")).toThrow("invalid run id");
  });

  it("rejects a run directory linked outside the checkpoint directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hush-checkpoint-root-"));
    const outside = await mkdtemp(join(tmpdir(), "hush-checkpoint-outside-"));
    const current = state();
    await symlink(outside, join(directory, current.runId), "junction");
    const outsideCheckpoint = join(outside, "state.json");
    await writeFile(outsideCheckpoint, "outside\n", "utf8");

    await expect(saveCheckpoint(current, directory)).rejects.toThrow(
      "checkpoint run directory must be a real directory"
    );
    expect(await readFile(outsideCheckpoint, "utf8")).toBe("outside\n");

    await writeFile(outsideCheckpoint, `${JSON.stringify(current)}\n`, "utf8");
    await expect(loadCheckpoint(current.runId, directory)).rejects.toThrow(
      "checkpoint run directory must be a real directory"
    );
  });
});
