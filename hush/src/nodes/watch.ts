import { randomBytes } from "node:crypto";

import { LIMITS, type NodeFn } from "../graph.js";
import { Alert, type Alert as AlertValue } from "../state.js";
import { firingAlerts, stormBurst } from "../storm.js";
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
      context.signal?.throwIfAborted();
      const response = await fetcher(`${base}/api/v2/alerts?active=true`, {
        signal: context.signal
      });
      if (!response.ok)
        throw new Error(`Alertmanager returned HTTP ${response.status}`);
      const alerts = ((await response.json()) as unknown[])
        .map(mapAlert)
        .filter((alert): alert is AlertValue => alert !== undefined);
      const observed = context.clock();
      // The burst is the storm; `alerts` still carries everything firing,
      // because classifying the rest as symptom or noise is N1's job. The
      // burst is measured over the same set `isStorm` gates on, so the logged
      // count can never disagree with the decision it explains.
      const burst = stormBurst(firingAlerts(alerts));
      if (burst.length >= LIMITS.STORM_MIN) {
        const date = observed.toISOString().slice(0, 10).replaceAll("-", "");
        const runId = `inc-${date}-${randomBytes(2).toString("hex")}`;
        return {
          runId,
          alerts,
          timeline: [
            timeline(observed, "N0", "storm_detected", {
              firing: alerts.length,
              burst: burst.length,
              earliest: burst[0]?.startsAt
            })
          ]
        };
      }
      context.log("N0", "watch_poll", {
        firing: alerts.length,
        burst: burst.length
      });
      await sleep(5_000);
    }
  };
}

export const watch = createWatch();
