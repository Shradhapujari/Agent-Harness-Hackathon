import { randomBytes } from "node:crypto";

import { LIMITS, type NodeFn } from "../graph.js";
import { Alert, type Alert as AlertValue } from "../state.js";
import { timeline } from "./shared.js";

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number) => Promise<void>;

function mapAlert(value: unknown): AlertValue | undefined {
  const raw = value as Record<string, unknown>;
  const labels = (raw.labels ?? {}) as Record<string, string>;
  const state = (raw.status as { state?: string } | undefined)?.state;
  if (state !== "active") return undefined;
  return Alert.parse({
    fingerprint: raw.fingerprint,
    name: labels.alertname,
    severity: labels.severity ?? "warning",
    labels,
    startsAt: raw.startsAt,
    status: "firing"
  });
}

export function createWatch(
  fetcher: Fetch = globalThis.fetch,
  sleep: Sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
): NodeFn {
  return async (state, context) => {
    const base = process.env.HUSH_ALERTMANAGER_URL ?? "http://localhost:9093";
    for (;;) {
      const response = await fetcher(`${base}/api/v2/alerts?active=true`);
      if (!response.ok)
        throw new Error(`Alertmanager returned HTTP ${response.status}`);
      const alerts = ((await response.json()) as unknown[])
        .map(mapAlert)
        .filter((alert): alert is AlertValue => alert !== undefined);
      const firing = alerts;
      const observed = context.clock();
      const cutoff = observed.getTime() - LIMITS.WINDOW_S * 1000;
      const earliest = Math.min(
        ...firing.map((alert) => Date.parse(alert.startsAt))
      );
      if (
        firing.length >= LIMITS.STORM_MIN &&
        earliest >= cutoff &&
        earliest <= observed.getTime()
      ) {
        const date = observed.toISOString().slice(0, 10).replaceAll("-", "");
        const runId = `inc-${date}-${randomBytes(2).toString("hex")}`;
        return {
          runId,
          alerts,
          timeline: [
            timeline(observed, "N0", "storm_detected", {
              firing: firing.length,
              earliest: new Date(earliest).toISOString()
            })
          ]
        };
      }
      context.log("N0", "watch_poll", { firing: firing.length });
      await sleep(5_000);
    }
  };
}

export const watch = createWatch();
