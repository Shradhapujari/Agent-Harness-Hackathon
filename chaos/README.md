# `chaos/` — breaking the data center on purpose

```bash
uv run hush-chaos crac      # scenario A: CRAC failure cooks rack R4
uv run hush-chaos hang      # scenario B: one host wedges, its BMC keeps answering
uv run hush-chaos status    # firing alerts by layer, plus the fleet's state
uv run hush-chaos clear     # put the lab back
```

## What each scenario actually does

**`crac`** raises facility ambient by 14 °C, which puts all twelve inlets over
the 30 °C rule threshold, and spikes `R4-N04` and `R4-N07` by another 35 °C so
they cross the 97 °C trip point and power themselves off. Twenty seconds later
it posts the Kubernetes and application symptoms. The result is ~45 alerts
across five layers within about a minute.

**`hang`** marks `R4-N04` hung on the BMC and freezes the kind node it runs
(`docker pause hush-worker`), so Kubernetes really does report NotReady after
about 40 s while Redfish keeps answering — the contradiction the agent has to
resolve. The symptom set is deliberately small: a hung host looks nothing like
a facility failure.

**`clear`** turns the chaos off, powers on anything left off, thaws and
uncordons the kind nodes, and silences the alerts it created.

## The constants, and why they are what they are

| Constant | Value | Why |
|---|---|---|
| `CRAC_DELTA_C` | 14 °C | Nominal ambient is 22 °C and `InletTempHigh` fires above 30 °C: +14 clears it on every node with margin, and takes `FacilityAmbientHigh` (> 28 °C) with it. |
| `SPIKE_DELTA_C` | 35 °C | On top of a 36 °C rack, a machine settles near 97 °C — just over the trip point. Below ~30 it never trips; well above it trips before the rack story is visible. |
| `SPIKE_SYSTEMS` | `R4-N04`, `R4-N07` | The two machines that back kind workers, so the Kubernetes layer reacts to the same fault. |
| `HARDWARE_LEAD_S` | 20 s | The rack's thermal time constant is 8 s and the hardware rules carry `for: 10s`. The correlator's leading alert is the earliest one in the lowest layer, so the hardware alerts have to land first. |
| `TTL_MINUTES` | 15 | Long enough to outlive a demo run, short enough that a forgotten alert dies on its own. |
| `SILENCE_S` | TTL + 1 min | A `clear` silence only has to outlive the alerts it covers. |

Machines other than the two spiked ones can trip too, once the rack is hot and
their CPU load is high. That is the simulation being honest, not a bug.

## Why `clear` silences instead of resolving

Alertmanager keeps the **later** `endsAt` when an alert is re-posted, so a
pushed alert cannot be shortened into resolution — posting the same alert with
`endsAt: now` leaves it firing until its original end. `clear` therefore
silences everything labelled `origin=hush-chaos`, which is exactly what this CLI
created and nothing else. Alerts that came from Prometheus are left alone: they
resolve when the physics does, which is the behaviour the demo is about.

For the same reason `hush-chaos status` counts only unsilenced alerts as
`firing`, and reports the silenced ones separately.

## Recovering a frozen node

`ForceRestart` on the BMC does not thaw a paused container, so the Redfish MCP
server unpauses the kind node whenever a power-on reset targets the machine that
node runs on (matched through the `hush.io/bmc` label). A real power-cycle
brings a real node back — see `mcp/README.md`.

## Tests

```bash
uv run pytest chaos -q
```

No network, no cluster, no containers: alert generation is pure, and the
scenarios are driven through stubbed clients so the tests pin the *sequence* —
which is the part the correlator later has to reconstruct.
