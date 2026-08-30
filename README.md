# Hush

Hush is an autonomous data-center incident triager and operator. It turns a
large alert storm into one evidence-backed root cause, enriches the incident
across infrastructure systems, proposes remediation, executes safe actions,
and requires a human decision before any destructive Redfish action.

> 40 alarms in → 1 root cause out → 0 humans paged → 1 approval before
> anything irreversible.

Hush is a hackathon project built on the TrueForge agent harness. The data
center hardware is simulated; the APIs, alert flow, Kubernetes operations,
approval gate, and audit trail are real.

![Hush incident execution graph](docs/architecture.svg)

## What happens during an incident

1. Alertmanager supplies the live alert stream.
2. Deterministic code groups related alerts; GPT-5.6-Luna classifies the likely
   root cause.
3. Three subagents gather evidence from Redfish, NetBox, Kubernetes, and
   Prometheus.
4. Hush ranks remediation actions and validates them against a fixed tool
   registry.
5. Safe Kubernetes actions such as cordon and drain can run automatically.
6. Reset or shutdown actions pause at the TrueForge approval gate.
7. Hush verifies recovery and writes an auditable incident report.

The project supports two repeatable demo scenarios: a rack cooling (CRAC)
failure cascade and a hung Kubernetes node.

## Graph engineering

| Stage         | Kind                            | Responsibility                                            | Guardrail                        |
| ------------- | ------------------------------- | --------------------------------------------------------- | -------------------------------- |
| N0 watch      | deterministic                   | Detect an alert storm                                     | Fixed count and time window      |
| N1 triage     | agentic                         | Correlate and classify one incident                       | Typed incident schema            |
| N2 enrich     | agentic + subagents             | Join Redfish, NetBox, Kubernetes, and Prometheus evidence | Three isolated subagents         |
| N3 plan       | agentic                         | Rank evidence-linked actions                              | Fixed tool registry              |
| N4–N7 execute | deterministic + agentic + human | Route safe actions and pause destructive actions          | Code-owned policy and approval   |
| N8–N10 close  | deterministic + agentic         | Verify, escalate if needed, and report                    | Fresh probes and bounded retries |

The complete node and edge contracts are in
[the execution graph specification](specs/graph.md).

## Safety model

- Redfish reset and shutdown actions always require human approval.
- Kubernetes writes are limited to cordon, drain, uncordon, and reschedule.
- NetBox is read-only.
- Side-effecting MCP calls use idempotency keys.
- Code, rather than the model, decides whether a tool is safe or destructive.
- Secrets, local databases, run logs, and generated reports are not committed.

## Technology

Hush uses TrueForge in local mode with **OpenAI GPT-5.6-Luna only**
(`openai/gpt-5-6-luna`). There is no alternate-model fallback. The controller
is strict TypeScript; the mock BMC and planned MCP services are Python 3.12.
The demo stack uses FastAPI/Redfish, Prometheus, Alertmanager, a three-node
kind cluster, NetBox, and remote streamable-HTTP MCP servers.

See [the locked technology choices](specs/tech-stack.md) and
[the execution graph and tool contracts](specs/graph.md) for details.

## Repository map

| Path                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `specs/mission.md`      | Product scope, scenarios, and success criteria                |
| `specs/tech-stack.md`   | Locked tools, versions, ports, and environment variables      |
| `specs/graph.md`        | Execution graph, state, safety policy, and MCP contracts      |
| `specs/roadmap.md`      | Build sequence, ownership, and definitions of done            |
| `hush/`                 | TrueForge controller, graph runner, prompts, and registration |
| `skills/hush-triage/`   | Importable data-center triage runbook                         |
| `docs/architecture.svg` | Incident graph used in this guide                             |
| `docs/i2-findings.md`   | Integration checkpoint 2: hang scenario, approvals, resume    |
| `docs/i3-findings.md`   | Integration checkpoint 3: clean-clone dress rehearsal         |
| `mock-bmc/`             | FastAPI mock BMC with a Redfish-compatible API                |
| `mcp/`                  | The five MCP servers the harness registers                    |
| `chaos/`                | `hush-chaos` scenario CLI (`hang`, `crac`, `clear`)           |
| `infra/`                | docker-compose stack, kind cluster, Prometheus rules, seeds   |
| `scripts/`              | `mcp-up.sh`, `mcp-down.sh`, `smoke.sh`, helper scripts        |
| `.env.example`          | Safe local configuration template; contains no credentials    |

## Current status

The whole stack is on `main`: the simulated data center (mock BMC, Prometheus,
Alertmanager, NetBox, a three-node kind cluster, the five MCP servers, and the
chaos CLI) and the controller (graph runner, TrueForge adapter, triage,
parallel enrichment, planning, approval-gated execution, verification, and
reporting). Both demo scenarios run end to end, and the findings from each
integration checkpoint are in [`docs/`](docs/).

## Get started as a contributor

Prerequisites:

- Git
- Node.js 22.14 or newer
- Python 3.12 and `uv`
- Docker Desktop, `kind`, and `kubectl` for later integration phases

Clone the repository, then create your local environment file:

```bash
git clone <repository-url>
cd Agent-Harness-Hackathon
cp .env.example .env
```

Replace only the safe placeholders in `.env`. Keep
`HUSH_MODEL=openai/gpt-5-6-luna`; Hush supports no other model. Never commit
`.env` or an API key.

Run the checks that are available today:

```bash
make sync                 # uv sync --all-packages; make test type-checks nothing without it
make test                 # ruff, mypy, and pytest across mock-bmc/, mcp/, chaos/, infra/
cd hush
npm ci
npm test
npm run build
npm run lint
```

Run `make sync` before `make test` in a fresh clone: `mypy` reads the installed
workspace packages, and without them it reports errors that are not in the code.

CI runs the same two suites — `make sync && make test` for Python, and the
TypeScript lint, build, and test — plus gitleaks on every pull request.

The mock BMC has its own setup and API examples in
[`mock-bmc/README.md`](mock-bmc/README.md).

## TrueForge setup

Start TrueForge locally:

```bash
npx @truefoundry/trueforge@latest
```

Open `http://localhost:8790`, add an OpenAI API key under **Settings →
Models**, and select `openai/gpt-5-6-luna`. Do not add a model fallback. If the
provider dialog renders empty, configure it over the API instead: put the key in
`~/.hush-openai-key` and run `uv run python scripts/configure_openai.py`, which
never writes it to the repo.

**The sandbox is off** (`config.sandbox.enabled: false` in `hush/agent.json`).
Daytona is the only provider TrueForge supports, and without a key its sandbox
never initialises: on this laptop every session logged `Sandbox initialization
failed … git ls-remote`. Two consequences, both measured at I3 and neither of
them affecting the incident graph, which reaches its tools over MCP:

- no sandbox code execution, so nothing renders `evidence.png`;
- **no `hush-triage` skill in the prompt.** TrueForge materialises a git skill
  inside the sandbox, so with the sandbox off the skill contributes 0 prompt
  tokens where it contributed 180 with the sandbox on. `npm run register` still
  registers it, and it returns the moment a provider is configured.

To turn it back on, set `sandbox.enabled` to `true` in `hush/agent.json`, add a
Daytona key under **Settings → Sandbox providers**, and rerun `npm run register`.

With the five local MCP servers running, register or update the connectors, the
`hush-triage` skill and the `hush-operator` agent — the skill lives at a public
GitHub path, so it imports over REST with no OAuth step:

```bash
cd hush
npm ci
npm run register
```

Set `TRUEFORGE_BASE_URL` to use a different local TrueForge URL. Keep
`HUSH_MODEL=openai/gpt-5-6-luna`; other models are unsupported. `npm run
register`, `npm run incident` and `npm run resume` all load these values from
the root `.env` when it exists. Registration is idempotent and safe to rerun
after changing the agent manifest or system prompt.

## Running an incident

`make up` brings up the simulated data center: the containers, the kind
cluster, the five MCP servers, and a read-only `kubectl proxy` on `:8001` that
the verification node polls directly. `make smoke` checks all of them.

```bash
uv run hush-chaos hang       # or: crac
cd hush && npm run incident -- --scenario hang
```

The run detects the storm, triages it to one root cause, enriches it across
Redfish, NetBox and Kubernetes, and plans. Safe actions (cordon, drain, silence)
execute without a prompt. A `redfish.reset_system` proposal stops at the
approval gate, which prints the root cause, the blast radius from NetBox, the
exact tool and arguments, and the evidence ids, then waits for `allow` or
`deny <reason>`. A denial is recorded against your username and sent back to the
agent, which replans. `hush resume <run-id>` continues a run whose checkpoint is
on disk — including after TrueForge itself has been restarted.

Approvals run in `terminal` mode. `HUSH_APPROVAL_MODE=ui` is not wired up: a
TrueForge UI click resumes the held tool call itself, and the SDK exposes no
`user.tool_approval` in the session event stream to observe it with, so the
controller cannot gate on it. See [`docs/i2-findings.md`](docs/i2-findings.md).

`hush-chaos clear` puts the lab back between runs — machines on, nodes thawed
and uncordoned, synthetic alerts resolved. Run it before each demo take.

### When a run does not behave

Start with `make smoke`; every line below was a real dress-rehearsal failure
(see [`docs/i3-findings.md`](docs/i3-findings.md)).

- `netbox … WARN (port held by another service)`: some other local process owns
  `:8000`, so the NetBox tools answer from `infra/netbox/seed.json` and the
  blast radius at the approval gate is seeded rather than live. Move
  `HUSH_NETBOX_PORT` and `HUSH_NETBOX_URL` together, or stop the other process.
  The same applies to `:8001` (`HUSH_KUBERNETES_PORT`, polled by verification)
  and `:8790` (TrueForge).
- Run the stack from **one** clone. All checkouts share the same Docker Compose
  project name, so `make up` in a second clone recreates the running containers
  against that clone's files — and on macOS it fails outright if the clone sits
  outside Docker Desktop's shared paths, leaving the stack down.
- `Sandbox initialization failed … git ls-remote` in `runs/trueforge.log` means
  the sandbox is on with no provider behind it. The incident graph still runs —
  it reaches its tools over MCP, not the sandbox — but the `hush-triage` skill
  is not in the prompt either. Ship with `sandbox.enabled: false`, or configure
  Daytona; see the TrueForge setup section above.
## Local incident console

The Hush console puts the complete demo flow on one local page: service
readiness, chaos injection, graph progress, evidence, actions, and the human
checkpoint. Start the stack, TrueForge, and the registered Hush agent first,
then run:

```bash
cd hush
npm run ui
```

Open `http://127.0.0.1:4173`. Choose the hung-host or cooling-failure scenario
and select **Trigger alarm**. The console calls the documented mock-BMC chaos
endpoint and starts the existing incident runner; do not also run
`hush-chaos` or `npm run incident` for the same take.

**Trigger alarm** runs `uv run hush-chaos clear` and then the scenario itself,
so the storm the console injects is the same one the CLI injects — the eight
Kubernetes and application symptoms included — and the button is repeatable
between takes without a manual reset.

Manual CLI incidents continue to use terminal approval. Incidents started by
the console use the local `web` approval bridge: the exact pending action is
written under the ignored `runs/<run-id>/` directory, and the browser can
approve or deny only that action. A denial requires a note so Hush can replan.

## Working agreements

- Read the relevant spec before changing code; `AGENTS.md` contains the full
  project rules.
- Branch each roadmap phase from the latest `origin/main` only after its
  predecessor merges.
- Use Conventional Commits and keep changes scoped to one roadmap phase.
- Run the narrowest relevant tests, lint, and build checks.
- Every substantive pull request must receive a Qodo review; address High
  findings before merge and record the result in the PR template.

## Learn more

- [Mission and acceptance criteria](specs/mission.md)
- [Tech stack](specs/tech-stack.md)
- [Execution graph and MCP contracts](specs/graph.md)
- [Implementation roadmap](specs/roadmap.md)
- [Mock BMC guide](mock-bmc/README.md)
- [DC-Sentinel ELI5](dc_sentinel_eli5_standalone.html) — kid-friendly, standalone
  walkthrough of the project

## Qodo Code Review Evidence

Qodo review is required for every substantive pull request.

- [PR #7 — TrueForge adapter and registration](https://github.com/Shradhapujari/Agent-Harness-Hackathon/pull/7): Qodo review feedback was incorporated before merge; the final change keeps harness I/O behind a typed adapter and registration idempotent.
- [PR #14 — triage, enrichment, and planning nodes](https://github.com/Shradhapujari/Agent-Harness-Hackathon/pull/14): Qodo surfaced bounded-execution and stale-plan risks; follow-up commits added node timeouts, stricter plan replacement, and regression tests.

## Limits, team, and license

Hush intentionally supports one rack, two deterministic scenarios, and one
model. The BMC is simulated, NetBox writes are forbidden, and Kubernetes
changes are limited to cordon, drain, uncordon, and rescheduling. See
[the full non-goals](specs/mission.md#6-non-goals-say-no).

The two-person project is split at the MCP boundary: Person A owns the
simulated data center and tool servers; Person B owns the Hush controller,
TrueForge integration, CI, and demo materials. Hush is licensed under the
[MIT License](LICENSE).
