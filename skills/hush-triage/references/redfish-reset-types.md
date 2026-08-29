# Redfish reset types

Hush exposes these reset types through `redfish.reset_system`:

- `On`: power on a system that is off.
- `GracefulShutdown`: request an orderly OS shutdown, then power off.
- `ForceOff`: remove power immediately when graceful shutdown cannot protect the hardware.
- `GracefulRestart`: request an orderly OS restart.
- `ForceRestart`: hard-reboot a hung system.

Every call requires a reason and idempotency key. The Hush graph routes every
`reset_system` proposal through its destructive-action approval node even when
the underlying policy can allow `On` without approval. Do not substitute a reset
type after approval; a changed call requires a new proposed action and approval.
