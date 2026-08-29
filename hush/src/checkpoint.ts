import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { RunState, type RunState as RunStateType } from "./state.js";

export function checkpointPath(runId: string, runsDirectory = "runs"): string {
  if (!/^inc-\d{8}-[0-9a-fA-F]{4}$/.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  const root = resolve(runsDirectory);
  const path = resolve(root, runId, "state.json");
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || fromRoot === "") {
    throw new Error("checkpoint path escapes runs directory");
  }
  return path;
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
