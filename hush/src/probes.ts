import type { ProbeSnapshot, Probes } from "./graph.js";
import type { RunState } from "./state.js";

type Fetch = typeof fetch;

export class HttpProbes implements Probes {
  constructor(
    private readonly fetcher: Fetch = fetch,
    private readonly bmcUrl = process.env.HUSH_BMC_URL ??
      "http://127.0.0.1:8100",
    private readonly alertmanagerUrl = process.env.HUSH_ALERTMANAGER_URL ??
      "http://127.0.0.1:9093",
    private readonly kubernetesUrl = process.env.HUSH_KUBERNETES_URL ??
      "http://127.0.0.1:8001"
  ) {}

  async snapshot(
    _state: RunState,
    signal?: AbortSignal
  ): Promise<ProbeSnapshot> {
    const [bmc, alerts, nodes] = await Promise.all([
      json(this.fetcher, `${this.bmcUrl}/chaos/status`, signal),
      json(
        this.fetcher,
        `${this.alertmanagerUrl}/api/v2/alerts?active=true`,
        signal
      ),
      json(this.fetcher, `${this.kubernetesUrl}/api/v1/nodes`, signal)
    ]);
    const bmcNodes = asArray(record(bmc).nodes).map((value) => {
      const node = record(value);
      return {
        systemId: String(node.system_id ?? ""),
        power: String(node.power ?? ""),
        hung: Boolean(node.hung),
        cpuTempC: Number(node.cpu_temp_c)
      };
    });
    const firingAlerts = asArray(alerts)
      .filter((value) => record(record(value).status).state === "active")
      .map((value) => String(record(value).fingerprint ?? ""));
    const readyNodes = asArray(record(nodes).items)
      .filter((value) =>
        asArray(record(record(value).status).conditions).some((condition) => {
          const item = record(condition);
          return item.type === "Ready" && item.status === "True";
        })
      )
      .map((value) => String(record(record(value).metadata).name ?? ""));
    return { nodes: bmcNodes, firingAlerts, readyNodes };
  }
}

async function json(fetcher: Fetch, url: string, signal?: AbortSignal) {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error(`probe ${url} failed: ${response.status}`);
  return response.json() as Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
