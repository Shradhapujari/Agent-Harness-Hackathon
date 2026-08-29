# I2 — integration checkpoint: hang scenario, approval mode, resume

Preconditions A4, A5, B4 (all merged). Run against the live stack on Person B's
laptop: kind `hush`, mock-BMC, Prometheus, Alertmanager, NetBox, the five MCP
servers, and TrueForge on `:8790`.

Script from `specs/roadmap.md`: the full `hang` scenario with `ui` approval
mode, then `crac`; kill and restart TrueForge during N2 and `hush resume`.

## Outcome

**Approval mode for the demo: `terminal`.** See finding 6.

Scenario B now runs end to end. The recorded run is
[`reports/samples/i2-hang-approval-beat.md`](../reports/samples/i2-hang-approval-beat.md):
N0 detects the storm, N1 triages it to `host_hang` on R4-N04 at 0.99 confidence
with `HostHung` as the leading alert and the three unrelated `CpuTempCritical`
alerts filed as noise, N2 enriches across three subagents on the first attempt,
N3 plans, the operator denies a `GracefulRestart`, the agent replans to a
`ForceRestart`, the operator allows it, and N7 executes it — after which the BMC
reports the machine on and no longer hung and `hush-worker` is back to `Ready`.

It still ends in `escalated`, for the one reason described in finding 12.

Before this checkpoint scenario B could not leave N0 at all.

## Bug list

Triaged by "blocks demo?". Every one was found by running the scenario, not by
reading the code.

| # | Finding | Blocks demo? | Fixed |
|---|---|---|---|
| 1 | `STORM_MIN=15` is unreachable for `hang` | yes | yes |
| 2 | Storm gate goes stale `WINDOW_S` after the cascade | yes | yes |
| 3 | N8's Kubernetes probe has nothing serving it | yes | yes |
| 4 | `npm run incident` ignores `.env` | yes | yes |
| 5 | N2's schema hint is a type name, not an example | yes | yes |
| 6 | `HUSH_APPROVAL_MODE=ui` silently ran the terminal bridge | yes | yes |
| 7 | `hang` posts its symptoms before `HostHung` fires | yes | yes |
| 8 | `hush-chaos clear` silences instead of resolving | yes | yes |
| 9 | A replan that accepts nothing discards the pending plan | yes | yes |
| 10 | `hush resume` is charged for the time it spent stopped | yes | yes |
| 11 | `recovered()` is false for any `unknown` root cause | no | no — by design |
| 12 | Pushed symptom alerts never resolve, so nothing can verify | yes | **no — needs a joint decision** |

### 1. `STORM_MIN=15` is unreachable for the `hang` scenario

`chaos/hush_chaos/alerts.py` posts 8 symptoms for a hung host and says so
deliberately: "Deliberately smaller than the CRAC cascade". Prometheus adds
`HostHung`, for 9. N0's gate needed 15, so scenario B — the one carrying the
approval beat the roadmap says never to cut — could never leave N0. The
threshold had been sized against the CRAC cascade alone.

`STORM_MIN` is now 6: under the smallest scenario with headroom for a symptom
that fails to post, and above this lab's idle noise. `specs/graph.md` §3/§4
updated in the same commit, per roadmap rule 0.1.

### 2. The storm gate went stale two minutes after the cascade

`watch.ts` required the *earliest* firing alert to be newer than `WINDOW_S`.
The operator starts the run by hand after `hush-chaos`, so the cascade is
routinely older than 120 s on the first poll — and a single alert left over
from an earlier run (a node still cooling down) held the gate shut for good.
Observed live: a run sat in N0 for ten minutes with 11–15 alerts firing in
front of it.

`edges.ts` disagreed with `watch.ts` about this, which is how it survived
review: the edge counted alerts *inside* the window, the node measured the
oldest one.

Both now share `src/storm.ts`, which slides the window over the alerts' own
`startsAt` and returns the densest burst. A storm stays detectable as long as
it is firing.

### 3. N8's Kubernetes probe had nothing serving it

`HttpProbes` polls `http://127.0.0.1:8001/api/v1/nodes`. Nothing in `make up`,
`scripts/`, the README or `.env.example` started a `kubectl proxy` there, and
no test covered it, so every verification threw and every run escalated
instead of recovering. `scripts/mcp-up.sh` now starts the proxy alongside the
MCP servers, `mcp-down.sh` stops it, `smoke.sh` checks it, and
`HUSH_KUBERNETES_URL` / `HUSH_KUBERNETES_PORT` are documented.

### 4. `npm run incident` did not load `.env`

Only `npm run register` had `--env-file-if-exists=../.env`. Setting
`HUSH_APPROVAL_MODE`, `TRUEFORGE_BASE_URL` or `HUSH_BMC_URL` in `.env` and then
running the incident silently used the defaults. `incident` and `resume` now
load it the same way.

### 5. N2's schema hint was a type name, not an example

Every other node hands the model a field-level example. N2 sent
`{"evidence":["Evidence"]}`. The model returned an array of the string
`"Evidence"`, then on retry objects with no `id` and layers
(`kubernetes_prometheus`, `sandbox`) outside the enum — both parse retries
burned, `enrich_fallback_escalation`, and a plan built on nothing.

N2 and N8 now send the same field-level example the other nodes do. Enrichment
passed on the first attempt in every run afterwards.

### 6. `HUSH_APPROVAL_MODE=ui` silently ran the terminal bridge

`createApprovalBridge("ui")` printed a line and returned `TerminalApproval`.
The operator who asked for `ui` watches the TrueForge chat while the run blocks
on a stdin prompt nobody is reading, and `APPROVAL_TIMEOUT_S` then denies the
action on their behalf. Approval is the safety gate; the channel it is served
on is not something to substitute quietly. It now throws.

**Why the demo runs on `terminal`.** A UI click cannot drive the controller's
gate:

- I1 recorded that a TrueForge UI click resumes the held tool call itself, so
  the tool fires before the controller can record the decision or checkpoint.
- The SDK confirms there is no way to observe the click either:
  `TrueForgeApi.SessionEvent` is a union of eleven event types and
  `UserToolApprovalEvent` is not among them, so `sessions.listEvents` never
  returns a `user.tool_approval`. A poller could only infer the decision from a
  later `tool.response`, by which time the tool has already run.

The `ui` seam (`UiApproval`, `createApprovalBridge`'s `uiPoller` argument) is
kept and tested, per the roadmap's "keep both". It needs a TrueForge-side hold
that survives the click, which is not something this repo can add.

The terminal card is not a downgrade for the video: it prints the root cause,
the blast radius from NetBox, the exact tool and arguments, and the evidence
ids, and the decision is recorded as `human:<username>` in the report.

### 7. `hang` posted its symptoms before `HostHung` could fire

`scenarios.py` opens with "Ordering matters: the hardware alerts have to land
first, because the correlator's leading alert is the earliest one in the lowest
layer". `crac` implements that with `HARDWARE_LEAD_S`; `hang` did not.
`HostHung` needs a Prometheus scrape plus its `for: 5s`, while the symptoms post
instantly, so N0's snapshot held eight Kubernetes alerts and nothing naming the
machine's fault. Triage returned `kind: "unknown"` — "No FacilityAmbientHigh,
HostHung, or PsuInputLost alert is present" — and an `unknown` root cause can
never verify (finding 11), so the run escalated.

`hang` now takes the same lead as `crac`, with `--lead-s` to override it.

### 8. `hush-chaos clear` silenced its alerts instead of resolving them

`clear`'s comment claimed "a pushed alert cannot be shortened into resolution".
It can: re-posting with `endsAt` now resolves it — verified against the running
Alertmanager, 8 synthetic alerts to 0.

Because they were only silenced, `expire_silences` on the way into the next
scenario brought them straight back, carrying their **original** `startsAt`
(Alertmanager keeps the first one it saw for a fingerprint). The correlator
anchored its burst on those stale symptoms — correctly, they were the densest
group — and filed the fresh `HostHung` as noise. Back-to-back demo runs, which
is exactly what this checkpoint does, triaged to `unknown`.

`clear` now resolves first and keeps the silence as a backstop. `alerts.expired`
projects to the four fields Alertmanager accepts on a POST.

### 9. A replan that accepted nothing discarded the pending plan

Observed on the denial beat. The first plan staged three actions: a
`GracefulRestart`, a `ForceRestart` behind it, and a silence. The operator
denied the graceful one. The replan re-proposed only the call it had just been
refused, which the denied-args blacklist stripped — `accepted: 0` — and N3
superseded every still-`proposed` action anyway. The staged `ForceRestart`
became `skipped`, the plan was empty, and the run escalated instead of offering
the operator the stronger action.

N3 now supersedes only when the new plan has something to put on the table.
Bounded as before by `REPLANS_MAX`.

### 10. `hush resume` was charged for the time it spent stopped

The run budget was measured from `runStartedAt`, so a run resumed after a
TrueForge restart had already spent it: `remaining <= 0` on the first
iteration, straight to N9 with `run_timeout`. A resume 14 minutes later got 60
seconds for the rest of the graph. This is the checkpoint's kill-and-restart
beat, so it would have failed on camera.

A resumed run now gets a full `RUN_TIMEOUT_S` from the moment it resumes.
`runStartedAt` still records when the incident began, and the timeline gets a
`run_resumed` entry for the report.

### 11. `recovered()` is false for any `unknown` root cause — not fixed

`verify.ts` only defines recovery for `host_hang` and `crac_failure`, so a run
that triages to `unknown` polls for the full `VERIFY_TIMEOUT_S`, fails, replans,
and escalates. This is correct — the controller should not claim a recovery it
cannot define — and it is what made findings 7 and 8 show up as escalations
rather than silent wrong answers. Left alone deliberately.

### 12. Pushed symptom alerts never resolve, so no run can verify — NOT FIXED

**This is the one blocker left standing, and it needs Person A and Person B to
agree on a fix.**

`hush-chaos` posts its Kubernetes and application symptoms straight to
Alertmanager with `endsAt = now + TTL_MINUTES` (15 minutes), "long enough to
outlive a demo run". Nothing retracts them when the fault clears: a pushed alert
resolves at its `endsAt` or not at all.

`recovered()` requires that no fingerprint in `incident.primary` or
`incident.symptoms` is still firing. The eight synthetic symptoms are all
classified as symptoms, so the predicate stays false for fifteen minutes —
well past `VERIFY_TIMEOUT_S` (180 s) and past `RUN_TIMEOUT_S` (900 s).

Observed on the final validation run (`inc-20260829-e370`). The fleet had
genuinely recovered — BMC `power: On, hung: false`, `hush-worker` back to
`Ready`, the kind container thawed by the reset tool — and verification still
reported: *"six scoped incident alerts remain firing, so recovery cannot be
confirmed."* The run replanned and the agent proposed a `ForceOff` on a
healthy, recovered machine.

This affects both scenarios: `crac`'s predicate carries the same
`alertsClear` requirement. **No run can currently reach `outcome: recovered`.**

One thing it did demonstrate well: the operator denied the `ForceOff`, and the
approval gate stopped an agent that had been talked into a harmful action by
stale telemetry. That is the gate earning its place, and it is worth keeping in
the video.

Options, none of which should be taken unilaterally:

1. **Retract the symptoms when the fault clears (recommended).** The scenario
   invented these alerts; it should withdraw them. `alerts.expired()` already
   does the work — it needs something to call it while the run is in flight
   (a `hush-chaos watch` alongside the run, or a short TTL the scenario
   refreshes). Faithful to what a real cluster does. Person A's call.
2. **Let the agent silence residual alerts before verification.** One line in
   `skills/hush-triage/SKILL.md`, which currently forbids it. Rejected here:
   it lets the agent manufacture half of its own recovery signal, which is the
   opposite of what the verification node is for.
3. **Narrow `alertsClear` to `incident.primary`.** Small and plausible — the
   alert that named the fault is the meaningful one — but it weakens a
   safety-relevant predicate for both scenarios and should not be changed
   without re-running both.

Until this is settled, a demo take ends at "destructive action approved and
executed, node back to Ready" and then escalates. The approval beat, which is
what the judging criteria ask for, is unaffected.

## Qodo findings on PR #20

Both accepted; both were real.

### Resume reset the run budget

The first version of finding 10's fix handed every resume a fresh
`RUN_TIMEOUT_S`. That fixes the wrong half of the problem: excluding the time a
run spent stopped is right, but a fresh budget per resume means repeated
restarts run past the bound forever, and the bound is a safety limit.

`RUN_TIMEOUT_S` now bounds the time a run *spends*, not the wall clock since it
started. `RunState` carries `budgetSpentMs`, every checkpoint stamps it, and a
resume gets only what is left. `specs/graph.md` §2 updated with the field.

### The stack scripts and the controller could disagree about ports

`npm run incident` reads the root `.env` (finding 4) but `make up`, `make down`
and `make smoke` did not. Move `HUSH_KUBERNETES_PORT` in `.env` and the stack
starts the proxy on 8001 while the controller polls somewhere else — the same
class of gap as finding 3, reintroduced from the other side.

`scripts/lib/env.sh` loads the file for all three scripts, with an
already-exported variable winning so `HUSH_KUBERNETES_PORT=8002 make up` still
overrides. It skips `export FOO=bar` lines deliberately: node's `--env-file`
does not treat those as assignments either, and the two parsers have to agree or
the scripts act on a value the controller never saw. Verified by pointing `.env`
at port 8123 and watching `make up` and `make smoke` both follow.

## Still owed by this checkpoint

- **`crac` end to end after these fixes.** The `hang` path is verified live;
  `crac` has only been re-checked for storm detection. Its correlation was
  already fixed at I1 and the changes here are scenario-independent, but it has
  not been run through N10 since.
- **Kill and restart TrueForge during N2, then `hush resume`.** Finding 10 is
  fixed and covered by tests that fail against the old code, but the physical
  restart has not been rehearsed. Do it at I3, on Person A's laptop.
