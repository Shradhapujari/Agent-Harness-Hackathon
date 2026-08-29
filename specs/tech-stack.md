# Hush — Tech Stack (locked)

Decisions here are final for the hackathon. Re-open only per the brief's
Decision Log (`hackathon-brief.html` §7). Every layer is a real API; only the
hardware is simulated.

## 1. Runtime matrix

| Layer | Tool | Version / how it runs | Port | Owner |
|---|---|---|---|---|
| Agent harness | **TrueForge** (`npx @truefoundry/trueforge@latest`) | Node ≥ 22.14 (laptop has 24.x); local mode, SQLite | 8790 | B |
| LLM | OpenAI `openai/gpt-5.6-luna` (the only supported model; no fallback) | API key in TrueForge Settings → Models (never in repo) | — | B |
| Graph controller | **`hush/`** TypeScript, `@truefoundry/trueforge-sdk`, `zod`, `vitest` | `npm run incident -- --scenario crac` | — | B |
| Hardware/BMC | **`mock-bmc/`** FastAPI Redfish (exists) + new `/metrics` | `uvicorn app.main:app --port 8100` | 8100 | A |
| Metrics | **Prometheus** v2.x (docker) scraping `mock-bmc:/metrics` (k8s-layer symptoms are posted by the chaos CLI; k8s truth is read live via the kubernetes MCP) | `infra/docker-compose.yml` | 9090 | A |
| Alarm bus | **Alertmanager** v0.27+ (docker) | `infra/docker-compose.yml` | 9093 | A |
| Orchestration | **kind** 3-node cluster (`hush`), demo workloads | `kind create cluster --config infra/kind/cluster.yaml` | 6443 (kubeconfig) | A |
| Inventory | **NetBox** via `netbox-docker` (Postgres + Redis), seeded read-only | `infra/docker-compose.yml` profile `netbox` | 8000 | A |
| Chaos | **`chaos/`** Python CLI (`hush-chaos crac|hang|clear`) | drives mock-bmc `/chaos/*`, Alertmanager `/api/v2/alerts`, `docker pause` on kind node | — | A |
| MCP servers | **`mcp/`** Python, `mcp[cli]` FastMCP, transport `streamable-http` | one process per server | 9101–9105 | A |
| Sandbox | **Daytona** (only provider TrueForge supports today) | API key in TrueForge Settings → Sandbox providers | — | B |
| Skill | `skills/hush-triage/SKILL.md` imported from the public GitHub repo | needs sandbox enabled | — | B |
| Code review | **Qodo** GitHub app on the repo; `/agentic_review` on every PR | required for submission | — | B |
| CI | GitHub Actions: ruff, mypy, pytest (Python) · eslint, tsc, vitest (TS) | `.github/workflows/ci.yml` | — | B |

Ports are fixed so both laptops match and README commands are copy-paste.

## 2. Why these (one line each)

- **TrueForge local mode**: zero infra, persistent sessions in SQLite, native approvals/subagents/sandbox. Hosted mode is out of scope.
- **One LLM (`openai/gpt-5.6-luna`)**: one tested reasoning path keeps demo behavior and evaluation reproducible; Hush does not silently fall back to another model.
- **Remote MCP over streamable-http**: TrueForge registers MCP servers by URL (`manifest.type: "remote"`); no stdio. FastMCP gives a URL in ~20 lines.
- **Five MCP servers, not one**: separate identity, tool allow-lists, and approval policy per layer (graph-engineering principle: tools scoped per mandate).
- **Prometheus rules on real mock-BMC metrics**: thermal/PSU alerts fire from scraped data, not scripted; chaos injector only adds the k8s/app symptom layer synthetically to reach the 40-alert storm.
- **kind + `docker pause`**: pausing a kind worker container makes a genuine `NotReady` node in ~40 s, so drain/cordon are real k8s API calls.
- **NetBox via netbox-docker**: real inventory API. If it fails to come up, `mcp/netbox` falls back to `infra/netbox/seed.json` with `source: "fallback"` in every response (fallback-chain edge, still honest in the report).
- **TS controller + Python tools**: SDK is TypeScript; existing mock is Python. Each person stays in one language.

## 3. Repository layout

```
.
├── specs/                 mission.md · tech-stack.md · graph.md · roadmap.md
├── mock-bmc/              existing Redfish mock (+ app/metrics.py)
├── infra/
│   ├── docker-compose.yml prometheus · alertmanager · mock-bmc · netbox stack
│   ├── prometheus/        prometheus.yml · rules/hush.yml
│   ├── alertmanager/      alertmanager.yml
│   ├── kind/              cluster.yaml · workloads.yaml
│   └── netbox/            seed.py · seed.json
├── chaos/                 hush_chaos/ (cli.py, scenarios.py, alerts.py) + tests/
├── mcp/                   hush_mcp/ (alertmanager.py, redfish.py, kubernetes.py,
│                          prometheus.py, netbox.py, correlate.py, common.py) + tests/
├── hush/                  TS controller: src/{graph,nodes,state,trueforge,approval,report}
│                          + test/ · scripts/register.ts (idempotent TrueForge setup)
├── skills/hush-triage/    SKILL.md (+ references/runbook.md)
├── reports/               generated incident reports (gitignored except samples/)
├── docs/                  blog.md · demo-script.md · architecture.svg
├── .github/workflows/     ci.yml
├── .pr_agent.toml         Qodo config (optional)
└── README.md              stranger-runnable quickstart + Qodo evidence section
```

## 4. Conventions (Code Quality track)

- Python 3.12+ (`uv` for envs), `ruff` (lint+format), `mypy --strict` on `mcp/` and `chaos/`, `pytest` with `httpx` test clients; no network in unit tests.
- TypeScript strict, ESM, `eslint` + `prettier`, `vitest`; pure node logic has 100 % branch coverage target, I/O adapters mocked by interface.
- Every MCP tool: docstring = tool description, typed params, returns JSON-serialisable dict, never raises to the model — returns `{ "error": {...} }`.
- Destructive tools carry the word `reset`/`shutdown` in their name and are listed in `require_approval_for_tools`; read tools are prefixed `get_`/`list_`/`query_` and exposed via `@read-only` where possible.
- Structured logging: JSON lines with `graph_id`, `run_id`, `node_id`, `session_id` on every line (`hush/src/log.ts`, `mcp/hush_mcp/common.py`).
- Idempotency: every side-effecting tool takes `idempotency_key`; repeated calls with the same key are no-ops that return the first result.
- Conventional Commits; one PR per roadmap task; PR template asks "Qodo findings addressed?".
- Secrets only in env / TrueForge settings; `.env.example` documents names; `gitleaks` step in CI.

## 5. Environment variables

| Name | Used by | Default |
|---|---|---|
| `HUSH_BMC_URL` | mcp/redfish, chaos | `http://127.0.0.1:8100` |
| `MOCK_BMC_USER` / `MOCK_BMC_PASSWORD` | mock-bmc, mcp/redfish | `root` / `password0` |
| `HUSH_ALERTMANAGER_URL` | mcp/alertmanager, chaos | `http://127.0.0.1:9093` |
| `HUSH_PROMETHEUS_URL` | mcp/prometheus | `http://127.0.0.1:9090` |
| `HUSH_NETBOX_URL` / `HUSH_NETBOX_TOKEN` | mcp/netbox | `http://127.0.0.1:8000` / seeded token |
| `KUBECONFIG` | mcp/kubernetes, chaos | `~/.kube/config` (context `kind-hush`) |
| `TRUEFORGE_BASE_URL` | hush controller, register script | `http://localhost:8790` |
| `HUSH_MODEL` | register script | `openai/gpt-5.6-luna` (do not override with another model) |
| `HUSH_APPROVAL_MODE` | hush controller | `terminal` (or `ui`) |

## 6. Laptop prerequisites (both people)

```bash
# macOS
brew install --cask docker            # Docker Desktop; start it once
brew install kind kubectl helm uv gitleaks
node -v   # >= 22.14
uv python install 3.12
# Docker Desktop: give it >= 6 GB RAM (kind 3 nodes + netbox + prom)
```
