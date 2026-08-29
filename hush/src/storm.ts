import { LIMITS } from "./graph.js";
import type { Alert } from "./state.js";

/**
 * The largest set of alerts whose start times all fall inside one
 * `WINDOW_S`-wide span — the burst a storm detector is looking for.
 *
 * The window slides over the alerts' own start times; it is not anchored to
 * "now". Anchoring it to now (the first cut, found at I2) made a storm
 * undetectable `WINDOW_S` after it began: the operator is started by hand after
 * `hush-chaos`, so by the time N0 first polls, the whole cascade is already
 * older than the window and the gate never opens again. It also let one stale
 * alert — a node still cooling down from an earlier run — hold the gate shut
 * forever, because the oldest alert was the one being measured.
 */
export function stormBurst(
  alerts: Alert[],
  windowMs: number = LIMITS.WINDOW_S * 1000
): Alert[] {
  const sorted = alerts
    .map((alert) => ({ alert, at: Date.parse(alert.startsAt) }))
    .sort((left, right) => left.at - right.at);
  let best: Alert[] = [];
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right]!.at - sorted[left]!.at > windowMs) left += 1;
    if (right - left + 1 > best.length)
      best = sorted.slice(left, right + 1).map((item) => item.alert);
  }
  return best;
}

/** Alerts still firing, in the order the caller supplied them. */
export function firingAlerts(alerts: Alert[]): Alert[] {
  return alerts.filter((alert) => alert.status === "firing");
}

/** E0: `STORM_MIN` firing alerts started inside one `WINDOW_S` window. */
export function isStorm(alerts: Alert[]): boolean {
  return stormBurst(firingAlerts(alerts)).length >= LIMITS.STORM_MIN;
}
