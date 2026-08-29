import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
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

async function assertSafeRunDirectory(
  path: string,
  runsDirectory: string,
  create: boolean
): Promise<void> {
  const root = resolve(runsDirectory);
  const runDirectory = dirname(path);
  await mkdir(root, { recursive: true });
  if (create) {
    try {
      await mkdir(runDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const stat = await lstat(runDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("checkpoint run directory must be a real directory");
  }
  const canonicalRoot = await realpath(root);
  const canonicalRunDirectory = await realpath(runDirectory);
  const fromRoot = relative(canonicalRoot, canonicalRunDirectory);
  if (fromRoot.startsWith("..") || fromRoot === "") {
    throw new Error("checkpoint path escapes runs directory");
  }
}

export async function saveCheckpoint(
  state: RunStateType,
  runsDirectory = "runs"
): Promise<void> {
  const path = checkpointPath(state.runId, runsDirectory);
  const temporary = `${path}.tmp`;
  await assertSafeRunDirectory(path, runsDirectory, true);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await assertSafeRunDirectory(path, runsDirectory, false);
  await rename(temporary, path);
}

export async function loadCheckpoint(
  runId: string,
  runsDirectory = "runs"
): Promise<RunStateType> {
  const path = checkpointPath(runId, runsDirectory);
  await assertSafeRunDirectory(path, runsDirectory, false);
  const raw = await readFile(path, "utf8");
  return RunState.parse(JSON.parse(raw));
}
