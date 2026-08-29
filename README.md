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

| Path                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `specs/mission.md`    | Product scope, scenarios, and success criteria                |
| `specs/tech-stack.md` | Locked tools, versions, ports, and environment variables      |
| `specs/graph.md`      | Execution graph, state, safety policy, and MCP contracts      |
| `specs/roadmap.md`    | Build sequence, ownership, and definitions of done            |
| `hush/`               | TrueForge controller, graph runner, prompts, and registration |
| `mock-bmc/`           | FastAPI mock BMC with a Redfish-compatible API                |
| `.env.example`        | Safe local configuration template; contains no credentials    |

Folders described in the roadmap, including `mcp/`, `chaos/`, and `infra/`,
will appear as their phases land. Do not assume roadmap examples are already
implemented.

## Current status

Person B phases B0 through B2 and Person A phase A2 are present. The graph
runner and TrueForge adapter are implemented, but the complete one-command
incident demo still depends on later roadmap phases and integration fixtures.

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
cd hush
npm ci
npm test
npm run build
npm run lint
```

The mock BMC has its own setup and API examples in
[`mock-bmc/README.md`](mock-bmc/README.md).

## TrueForge setup

Start TrueForge locally:

```bash
npx @truefoundry/trueforge@latest
```

Open `http://localhost:8790`, add an OpenAI API key under **Settings →
Models**, and select `openai/gpt-5-6-luna`. Do not add a model fallback. Daytona
is the planned sandbox provider. If the provider dialog renders empty, configure
it over the API instead: put the key in `~/.hush-openai-key` and run
`uv run python scripts/configure_openai.py`, which never writes it to the repo.

With the five local MCP servers running, register or update the connectors, the
`hush-triage` skill and the `hush-operator` agent — the skill lives at a public
GitHub path, so it imports over REST with no OAuth step:

```bash
cd hush
npm ci
npm run register
```

Set `TRUEFORGE_BASE_URL` to use a different local TrueForge URL. Keep
`HUSH_MODEL=openai/gpt-5-6-luna`; other models are unsupported. Registration is
idempotent and safe to rerun after changing the agent manifest or system prompt.

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

## DC-Sentinel ELI5

_A robot detective for a giant computer building!_

😱 Uh oh! → 🕵️ Robot investigates → 🙋 Asks permission → 💪 Fixes it → 🎉 All better!

### 🏢 Part 1: What is a data center?

Imagine a HUGE room full of computer shelves called **racks**. These
computers run apps for lots of people, like YouTube or games. They get hot,
so big fans called **CRAC units** blow cold air on them, like an air
conditioner for robots.

- 🖥️ Computer rack
- ❄️ Cooling fan
- 🔌 Power
- 📦 Apps running

### 😱 Part 2: The problem — 40 alarms, but only ONE boo-boo

When ONE fan breaks, it gets hot. Hot makes computers panic. Then EVERYTHING
starts beeping at once — like when one kid falls down and 40 people scream!
A tired human has to figure out it's really just **ONE** problem.

```
🌡️ Fan breaks → 🔔🔔🔔 40 alarms screaming! → 🤖 DC-Sentinel says: "It's just ONE fan!"
```

### 🕵️ Part 3: Our robot detective's 3 helper friends

DC-Sentinel doesn't work alone. It calls three little helper-bots who each
look for clues:

- 🧩 **Correlator** — groups the clues
- 🏷️ **Classifier** — sorts what matters
- 🔍 **Enricher** — checks the real thermometer

Together they find: **"It's rack R4 — the fan died, and it's getting hot!"**

### 🙋 Part 4: The most important rule — ASK FIRST!

The robot can do SAFE things by itself. But for big scary things — like
turning a computer OFF — it must ask a human "is this okay?" first. Just
like you ask a grown-up before doing something big!

- ✅ **Safe stuff — robot just does it:** move apps to a cooler rack
- 🙋 **Big stuff — robot asks a human first:** turn off / power-cycle a
  computer

### 🎬 Part 5: The whole story, start to finish

🔥 Fan breaks → 🔔 40 alarms ring → 🤖 Robot looks → 🧩 Finds 1 cause → 🙋
Asks human → 💪 Fixes it → 🎉 All better + writes a report

### 🧸 Part 6: How we practice (no real building!)

We don't get to touch a REAL data center, so we build a pretend one on our
own computer with toy versions that act just like the real thing — like a
dollhouse that really works!

- 🐳 Pretend computer racks
- 🌡️ Pretend thermometer
- 📋 Pretend building map
- 💥 "Break it on purpose" button

### 🏆 Part 7: Why judges will love it

- 🧠 **Uses the robot toolkit fully** — talks to 5 real tools, uses
  helper-bots, and always asks before big actions.
- 🧹 **Neat, tested code** — built carefully with tests and reviews, like a
  well-organized backpack.
- 📖 **A great story to tell** — "40 alarms → 1 answer → 0 humans woken up."
  Easy to remember, fun to say!

_Made simple for show & tell 🎈 — DC-Sentinel, the Agent Harness Hackathon
project._

The standalone, illustrated version of this walkthrough lives in
[`dc_sentinel_eli5_standalone.html`](dc_sentinel_eli5_standalone.html).

## Qodo Code Review Evidence

Qodo review is required for every substantive pull request. Add links to
representative merged reviews here as those PRs land.
