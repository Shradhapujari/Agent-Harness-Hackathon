# I3 — dress rehearsal: a clean clone, the README, and a timed run

Preconditions A6 and B5 (both merged). The roadmap puts this rehearsal on
Person A's laptop; it ran on Person B's, because that is where TrueForge, the
model key and the running stack already were. Everything except the cold
`make up` was exercised from a **fresh `git clone` of `main`** in a scratch
directory, so the README was read the way a stranger reads it.

Script from `specs/roadmap.md`: clean clone, follow the README, time the run,
write down what went wrong.

## Outcome

**Go for recording. One open item: finding 5, the sandbox, needs a decision
before the video is shot.**

The approval beat — deny `GracefulRestart`, agent replans, allow
`ForceRestart`, BMC resets the machine, storm silenced, recovery verified —
now runs end to end in **144 seconds**, and the run ends `recovered`. The
recorded take is
[`reports/samples/i3-dress-rehearsal.md`](../reports/samples/i3-dress-rehearsal.md).

Before this checkpoint it could not. Every approved reset was rejected by the
tool itself *after* the human had approved it (finding 1); once that was fixed,
the storm the incident left behind could not be cleared, so a recovered machine
still reported `escalated` (finding 9); and a second take inside fifteen minutes
had no storm at all (finding 8). None of it was visible to the test suite or to
CI — which, as finding 3 records, was running a fifth of the Python.

## Bug list

Triaged by "blocks demo?". All seven were found by running the rehearsal, not
by reading code.

| # | Finding | Blocks demo? | Fixed |
|---|---|---|---|
| 1 | An approved `redfish.reset_system` never executes — the controller omits the required `reason` | yes | yes |
| 2 | `make test` fails in a clean clone: the README never says `make sync` | no | yes |
| 3 | CI ran only `mock-bmc/`'s tests — no `ruff`, no `mypy`, and none of `mcp/`, `chaos/`, `infra/` | no | yes |
| 4 | Another process on `:8000` silently downgrades the blast radius to `seed.json` | no | yes |
| 5 | TrueForge cannot install the `hush-triage` skill into its sandbox | no — but it costs a judged capability | decided: sandbox off |
| 6 | `make up` from a second clone recreates (and can break) the running stack | no | documented |
| 7 | README's status and repository map predate the A-side and I2 | no | yes |
| 8 | The agent's residual-storm silence outlives the take and swallows the next one | yes | yes |
| 9 | Tenant app alerts carry no `node`, so nothing can clear them and every run escalates | yes | yes |

### 1. The human approves a reset that the tool then refuses

`redfish.reset_system` takes `system_id, reset_type, reason, idempotency_key,
run_id` — `reason` is required, and `specs/graph.md` §5 has said so since the
tool contract was written. N5/N6/N7 built the call from the plan's `args` plus
`idempotency_key` and `run_id`, and nothing ever supplied `reason`. When the
planner happened to include one in `args` the call worked; when it did not, the
run reached the approval gate, a human approved a `ForceRestart`, and the tool
answered:

```
Error executing tool reset_system: 1 validation error for reset_systemArguments
reason
  Field required [type=missing, ...]
```

N7 recorded `action_failed`, N8 could not verify a machine nobody had reset,
and the run escalated. In the first rehearsal run that is exactly what happened.

The fix makes the argument the controller's, not the model's: `REGISTRY` now
declares which arguments the controller injects, and `exec.ts` builds every
tool call through one `callArgs()` helper that adds `reason` for
`redfish.reset_system` alongside `idempotency_key` and `run_id`. `reason` is
`action.reason` — the same sentence the operator read at the approval gate — so
the BMC's SEL entry records the text a human actually approved rather than a
second sentence the model wrote for the tool. `test/b4-nodes.test.ts` covers it
and fails without the fix.

### 2. `make test` is red in a clean clone

The README's contributor block runs `make test` with no preceding sync. In a
fresh clone that reports **81 mypy errors** ("Untyped decorator makes function
… untyped") because the workspace packages are not installed, and the reader
has no way to tell that from a real type error. `make sync` first, and the same
command is green. The README now says so, and `make sync` is in the block.

### 3. CI tested a fifth of the Python

The `python` job ran `uv sync --extra dev && uv run pytest -q` with
`working-directory: mock-bmc`. So `mcp/`, `chaos/` and `infra/` — 130 of the
207 Python tests, including the MCP tool servers the whole demo talks to — ran
on nobody's machine but the author's, and `ruff`/`mypy` ran in CI at all. The
job now runs `make sync && make test` from the repository root. All 207 tests
are mocked; none of them needs Docker or a cluster.

### 4. A port collision that only whispers

NetBox answered `404` on `/api/status/` all through the rehearsal. NetBox was
healthy — an unrelated local service held `127.0.0.1:8000`, and a
loopback-specific bind wins over the container's `0.0.0.0:8000` publish. Every
NetBox tool then fell back to `infra/netbox/seed.json`, which is by design, and
`make smoke` printed `skipped (fallback to seed.json)` — the same line it
prints when NetBox is simply not up yet.

The two are not the same problem: one resolves itself in two minutes, the other
never does, and the blast radius quoted in the approval gate — the sentence a
human decides on — is seeded data either way. `smoke.sh` now distinguishes
"nothing is listening" (`000`) from "something that is not NetBox answered",
and names `HUSH_NETBOX_PORT` in the second case.

### 5. The sandbox never initialises, so the skill is never installed

Every session logs, 38 times across the rehearsal:

```
Sandbox initialization failed … git ls-remote failed (exit 1) … (skill: hush-triage)
Failed to install 1/1 git skill(s)
```

TrueForge resolves a git-sourced skill *inside* the sandbox, and the sandbox's
`git` cannot reach GitHub on this machine (the same `git ls-remote` succeeds
from the shell, with and without a scrubbed environment). The incident graph is
unaffected — it reaches its tools over MCP and the skill text still reaches the
model — but sandbox code execution, one of the capabilities the hackathon
judges, is not demonstrable while this stands.

Roadmap open question 5 pre-authorises the fallback, and that is the call:
`sandbox.enabled` is now `false` in `hush/agent.json`, and the README says so.

Measured before deciding, with one trivial turn against the registered agent:

| `sandbox.enabled` | `skills` tokens in the prompt |
|---|---|
| `true` (provider failing) | 180 |
| `false` | 0 |

So the sandbox does not only cost sandbox execution — TrueForge materialises a
git skill *inside* the sandbox, so turning it off takes the `hush-triage`
runbook out of the prompt too. Registration still succeeds either way, and both
come back the moment a Daytona key is configured. The incident graph is
unaffected: it reaches its tools over MCP.

Claim neither in the video without a provider configured.

### 6. One stack, one clone

Running `make up` from the scratch clone recreated the *running* containers
against the clone's files, because every checkout shares a Compose project
name. On macOS it then failed outright — the clone sat outside Docker Desktop's
shared paths, so the `alertmanager.yml` bind mount could not be created — and
left the stack down until `make up` was re-run from the original checkout. The
README's troubleshooting section now says to run the stack from one clone.

### 7. Stale README

"Person B phases B0 through B4 are present" and "folders described in the
roadmap, including `mcp/`, `chaos/` and `infra/`, will appear as their phases
land" both predate the A-side landing. The status section and the repository
map now describe what is actually on `main`, including the checkpoint docs.

### 8. The second take has no storm

The agent's last safe action is `alertmanager.silence_alerts` over the incident
(`createdBy: hush`, 900 s). `hush-chaos clear` expired only the silences it had
created itself, so for fifteen minutes after a successful run every alert the
next `hush-chaos hang` posted arrived pre-suppressed: `?active=true` returned
nothing, N0 never saw a storm, and the run sat in `watch` until it timed out.
Exactly the failure mode I2 fixed for chaos's own silence, one author over.

`hush-chaos` now expires both authors — its own and `hush` — on the way into
`crac`, `hang` and `clear`. Takes are repeatable back to back again.

### 9. A recovered machine that still read as escalated

Run 2 executed the approved `ForceRestart`, the BMC reported R4-N04 powered on
and no longer hung, and `hush-worker` went `Ready` three seconds later. The run
still ended `escalated`.

`recovered()` (graph.md §4) requires that no alert in `incident.primary ∪
incident.symptoms` is still firing. The `hang` scenario's two
`AppErrorRateHigh` alerts were labelled with `tenant` and `rack` but not
`node`, and the agent's silence — correctly scoped to the machine it had just
reset, `rack=R4, node=R4-N04` — could not match them. Alertmanager matchers
are ANDed, so the two tenant alerts stayed active until their 15-minute TTL,
and nothing the agent could do would clear them inside a demo.

They are symptoms of that machine: those tenants' pods were on it. They now
carry `node` and `k8s_node` like every other symptom, so the scoped silence
covers the whole storm it was written for. Run 3 recovered on that fix alone.

It recovered slowly, though. That plan proposed only the reset, so N8 spent a
full 194-second verification cycle failing, N3 replanned the silence, and only
the second verification passed — three and a half minutes of a demo spent
watching a machine that was already healthy. Whether the storm gets closed out
at all was left to the model: run 2 volunteered the silence, run 3 did not.

So the close-out is now owned twice. `prompts/plan.md` asks for it as the
lowest-ranked action, and N3 appends one itself — same registry tool, same safe
policy, matchers built from `incident.rootCause.scope` — when the model's plan
has none. `specs/graph.md` §3/§4 record it.

This closes I2's finding 12 the honest way round: recovery is still judged on
fresh BMC and Kubernetes probes — power on, not hung, node `Ready` — and the
alert condition only prevents "recovered" while the incident's own alerts are
still firing. What clears them is a planned, evidence-linked, reported action,
never the controller writing to Alertmanager behind the plan's back.

## Timings

Measured during the rehearsal, on an M-series laptop with the stack already
warm.

| Step | Time |
|---|---|
| `git clone` (public HTTPS) | 1.1 s |
| `npm ci` | 2.2 s |
| `npm test` (84 tests, coverage) | 2.0 s |
| `npm run build` | 1.3 s |
| `npm run lint` | 2.0 s |
| `make sync` | 0.8 s |
| `make test` (207 tests + ruff + mypy) | 3.9 s |
| `make smoke` | 2.9 s |
| `uv run hush-chaos hang` | 1.5 s |
| Run 1: chaos → exit — reset rejected, escalated | 339 s |
| Run 2: chaos → exit — reset executed, storm unsilenceable, escalated | 325 s |
| Run 3: chaos → exit — recovered, after a wasted verification cycle | 333 s |
| Run 4: chaos → exit — the full beat, recovered | **144 s** |
| Run 5: scenario A (`crac`), two denials → escalated with a report | 209 s |

Run 4 is the take to plan around, end to end with a human at the keyboard:

| | |
|---|---|
| storm detected | 0:12 after `hush-chaos hang` |
| root cause identified | 0:37 |
| three subagents back, plan on the table | 1:08 |
| approval gate, `GracefulRestart` denied | 1:28 |
| replan, `ForceRestart` approved and executed | 1:44 |
| residual storm silenced, recovery verified, report written | 1:59 |

The four runs are the fixes landing one at a time: run 1 could not execute an
approved reset, run 2 could not clear the storm it left behind, run 3 cleared it
only after a 194-second verification cycle failed first, run 4 planned the
close-out up front.

A cold `make up` was not timed: the only clone that could have done it is the
one described in finding 6. Time it once on Person A's laptop before recording;
NetBox alone takes 2–4 minutes to answer, and the demo does not wait for it.

## Before recording

1. `uv run hush-chaos clear`, then `make smoke` — every line `ok`, and read the
   NetBox line rather than skimming it.
2. Finding 5 is decided: sandbox off, and neither sandbox execution nor the
   skill is claimed. If a Daytona key turns up, flip `sandbox.enabled`, rerun
   `npm run register`, and the skill returns with it.
3. Run from the checkout the stack was brought up from.
4. Budget two and a half minutes per take of scenario B, plus however long the
   operator spends reading the approval gate. Takes are repeatable back to back
   now, but still run `hush-chaos clear` between them.
5. Scenario A (`crac`) was rehearsed once, after the fixes: 43 alerts in, one
   `crac_failure` out at 0.99 across the whole of R4, one alert filed as noise,
   a four-action plan carrying the injected `reason` and its own rack-scoped
   silence, and — after the operator denied powering two thermally tripped
   nodes back into a hot rack twice — an escalation with a full report in 209
   seconds. Worth knowing before recording: **scenario A cannot end
   `recovered`**. Its predicate wants every scoped node cool and falling, and
   no tool in the registry repairs a chiller. Escalating to a human is the
   correct answer to a facility fault; if the video shows scenario A, say so
   out loud rather than letting it read as a failure.
6. `gitleaks detect` over full history still flags one line in
   `specs/roadmap.md`: the throwaway NetBox container token, the same value
   `.env.example` publishes. Pre-existing, harmless, and worth knowing about
   before someone runs the scan on camera.
