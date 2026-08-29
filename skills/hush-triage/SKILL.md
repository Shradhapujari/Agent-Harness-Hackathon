---
name: hush-triage
description: Runbook for correlating data-center alarm storms to one root cause and choosing safe versus approval-gated remediation (Redfish/Kubernetes/NetBox/Prometheus).
---

# Hush triage runbook

## Which layer answers which question

- "Is the node off or hung?" Only Redfish can answer: compare `PowerState`
  with `Oem.DCSentinel.Hung`.
- "Is it one node or the room?" `FacilityAmbientHigh` plus elevated inlet
  temperatures on multiple nodes indicates a facility-level CRAC failure.
- "Who is affected?" Use read-only NetBox tenant data for the scoped rack and
  devices.

## Root-cause mapping

- FacilityAmbientHigh: `crac_failure`
- HostHung: `host_hang`
- PsuInputLost: `psu_failure`
- Isolated CpuTempCritical: `thermal_single`

## Remediation ladder

1. Cordon and drain affected Kubernetes nodes before physical intervention.
2. For `crac_failure`, propose `GracefulShutdown` only for nodes with CPU
   temperature at or above 90 C; leave cooler nodes running.
3. For `host_hang`, propose `ForceRestart` for the hung system.

The current graph ends after verification and reporting. Do not place uncordon
or alert-silencing actions in the pre-verification remediation plan.

Read [references/redfish-reset-types.md](references/redfish-reset-types.md) before proposing a Redfish reset.

## Never

Never call `reset_system` outside an explicitly listed action. Never retry a
denied call with the same arguments. Never claim recovery without a fresh tool
read.
