import { describe, expect, it } from "vitest";

import { LIMITS } from "../src/graph.js";
import { firingAlerts, isStorm, stormBurst } from "../src/storm.js";
import { alert } from "./helpers.js";

const at = (seconds: number, fingerprint: string) =>
  alert({
    fingerprint,
    startsAt: new Date(
      Date.parse("2026-08-29T12:00:00.000Z") + seconds * 1000
    ).toISOString()
  });

describe("storm detection", () => {
  it("returns the densest window, not the most recent alerts", () => {
    const alerts = [
      at(0, "a"),
      at(1, "b"),
      at(2, "c"),
      at(10_000, "far-1"),
      at(10_001, "far-2")
    ];

    expect(stormBurst(alerts).map((item) => item.fingerprint)).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("groups alerts exactly WINDOW_S apart and splits anything wider", () => {
    const edge = [at(0, "a"), at(LIMITS.WINDOW_S, "b")];
    const beyond = [at(0, "a"), at(LIMITS.WINDOW_S + 1, "b")];

    expect(stormBurst(edge)).toHaveLength(2);
    expect(stormBurst(beyond)).toHaveLength(1);
  });

  it("is unaffected by how long ago the burst started", () => {
    const old = Array.from({ length: LIMITS.STORM_MIN }, (_, index) =>
      alert({
        fingerprint: `fp-${index}`,
        startsAt: new Date(
          Date.parse("2020-01-01T00:00:00.000Z") + index * 1000
        ).toISOString()
      })
    );

    expect(isStorm(old)).toBe(true);
  });

  it("counts only firing alerts", () => {
    const alerts = Array.from({ length: LIMITS.STORM_MIN }, (_, index) =>
      at(index, `fp-${index}`)
    );
    const resolved = alerts.map((item) => ({
      ...item,
      status: "resolved" as const
    }));

    expect(isStorm(alerts)).toBe(true);
    expect(firingAlerts(resolved)).toEqual([]);
    expect(isStorm(resolved)).toBe(false);
    expect(isStorm(alerts.slice(1))).toBe(false);
  });

  it("handles an empty stream", () => {
    expect(stormBurst([])).toEqual([]);
    expect(isStorm([])).toBe(false);
  });

  it("detects the storm a single hung host produces", () => {
    // chaos/hush_chaos/alerts.py posts 8 symptoms for `hush-chaos hang`, all in
    // one call; Prometheus adds HostHung a few seconds later. STORM_MIN has to
    // sit under that or scenario B never starts (I2).
    const hang = [
      ...Array.from({ length: 8 }, (_, index) => at(0, `symptom-${index}`)),
      at(5, "HostHung")
    ];

    expect(isStorm(hang)).toBe(true);
  });
});
