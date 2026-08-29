import { readFile } from "node:fs/promises";

import { TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

const servers: TrueForgeApi.McpServerManifest[] = [
  {
    name: "alertmanager",
    url: "http://127.0.0.1:9101/mcp",
    description: "Alertmanager alerts and deterministic correlation",
    type: "remote"
  },
  {
    name: "redfish",
    url: "http://127.0.0.1:9102/mcp",
    description: "Mock BMC power, thermal, SEL, and reset operations",
    type: "remote"
  },
  {
    name: "kubernetes",
    url: "http://127.0.0.1:9103/mcp",
    description: "kind cluster node and pod operations",
    type: "remote"
  },
  {
    name: "prometheus",
    url: "http://127.0.0.1:9104/mcp",
    description: "PromQL over mock-BMC metrics",
    type: "remote"
  },
  {
    name: "netbox",
    url: "http://127.0.0.1:9105/mcp",
    description: "Read-only NetBox inventory",
    type: "remote"
  }
];

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790"
});
for (const manifest of servers) {
  await client.settings.mcpServers.createOrUpdate({ manifest });
  console.log(`registered connector ${manifest.name}`);
}

const agent = JSON.parse(
  await readFile(new URL("../agent.json", import.meta.url), "utf8")
) as TrueForgeApi.CreateAgentRequest;
agent.manifest.instructions = await readFile(
  new URL("../prompts/system.md", import.meta.url),
  "utf8"
);
agent.manifest.model.name = process.env.HUSH_MODEL ?? agent.manifest.model.name;

const existing = (await client.agents.list()).data.find(
  (candidate) => candidate.name === agent.name
);
if (existing === undefined) {
  await client.agents.create(agent);
  console.log(`created agent ${agent.name}`);
} else {
  await client.agents.update(existing.id, { manifest: agent.manifest });
  console.log(`updated agent ${agent.name}`);
}
