import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RunState, type RunState as RunStateType } from "./state.js";

export function checkpointPath(runId: string, runsDirectory = "runs"): string {
  return join(runsDirectory, runId, "state.json");
}

export async function saveCheckpoint(
  state: RunStateType,
  runsDirectory = "runs"
): Promise<void> {
  const path = checkpointPath(state.runId, runsDirectory);
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function loadCheckpoint(
  runId: string,
  runsDirectory = "runs"
): Promise<RunStateType> {
  const raw = await readFile(checkpointPath(runId, runsDirectory), "utf8");
  return RunState.parse(JSON.parse(raw));
}
