---
name: hush-triage
description: Runbook for correlating data-center alarm storms to one root cause and choosing safe versus approval-gated remediation.
---

# Hush triage runbook

## Which layer answers which question

- Use Redfish PowerState and Hung state to distinguish off from hung.
- Use facility alerts and fleet inlet temperatures to distinguish one node from a room-wide cooling failure.
- Use read-only NetBox rack and tenant data to determine blast radius.

## Root-cause mapping

- FacilityAmbientHigh: `crac_failure`
- HostHung: `host_hang`
- PsuInputLost: `psu_failure`
- Isolated CpuTempCritical: `thermal_single`

## Remediation ladder

1. Cordon and drain affected Kubernetes nodes before physical intervention.
2. For `crac_failure`, propose `GracefulShutdown` only for nodes at or above 90 C.
3. For `host_hang`, propose `ForceRestart` for the hung system.
4. After verified recovery, uncordon nodes and silence residual alerts for ten minutes.

Read [references/redfish-reset-types.md](references/redfish-reset-types.md) before proposing a Redfish reset.

## Never

Never call `reset_system` outside an explicitly listed action. Never retry a denied call with the same arguments. Never claim recovery without fresh tool evidence.
