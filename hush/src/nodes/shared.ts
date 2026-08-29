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
  name: "triage" | "enrich" | "plan",
  values: Record<string, string>
): Promise<string> {
  let template = await readFile(
    new URL(`../../prompts/${name}.md`, import.meta.url),
    "utf8"
  );
  for (const [key, value] of Object.entries(values))
    template = template.replaceAll(`{{${key}}}`, value);
  return template;
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
