import { readFile } from "node:fs/promises";

import type { HarnessClient } from "../trueforge.js";

export function harnessClient(value: unknown): HarnessClient {
  const candidate = value as Partial<HarnessClient>;
  if (
    typeof candidate.openSession !== "function" ||
    typeof candidate.turn !== "function"
  )
    throw new Error("node requires a harness client");
  return candidate as HarnessClient;
}

export async function render(
  name: "triage" | "enrich" | "plan" | "exec" | "verify",
  values: Record<string, string>,
  load: (name: string) => Promise<string> = filePromptLoader
): Promise<string> {
  let template = await load(name);
  for (const [key, value] of Object.entries(values))
    template = template.replaceAll(`{{${key}}}`, () => value);
  return template;
}

export function filePromptLoader(name: string): Promise<string> {
  return readFile(new URL(`../../prompts/${name}.md`, import.meta.url), "utf8");
}

export function timeline(
  now: Date,
  nodeId: string,
  event: string,
  detail?: unknown
) {
  return {
    ts: now.toISOString(),
    nodeId,
    event,
    ...(detail === undefined ? {} : { detail })
  };
}
