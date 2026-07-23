# Command dispatch (Command → Task) — from the binary

**Source:** `IAiCommandDispatchImpl::DispatchTask` @ **0x608EF0** (the big one
Switch, in faf-re as a stub). The **Callee list** of this function is
in fact the dispatch table: each type of command creates a specific one
Task and pushes it to the task stack of the unit thread (see
[sim-core.md](sim-core.md): Return value controls scheduling).

Befehls-Enum: `EUnitCommandType` (faf-re `command/SSTICommandIssueData.h`).

## Dispatch table

| Opcode | command | generated task/action |
| --- | --- | --- |
| 0x01 | Stop | `IAiCommandDispatchImpl::Stop` |
| 0x02 | Move | `NewMoveTask` |
| 0x03 | Dive | (Diving state) |
| 0x04 | FormMove | `CUnitFormAndMoveTask` |
| 0x05 | BuildSiloTactical | Silo construction |
| 0x06 | BuildSiloNuke | Silo construction |
| 0x07 | BuildFactory | `CFactoryBuildTask` |
| 0x08 | BuildMobile | `CUnitMobileBuildTask` |
| 0x09 | BuildAssist | `CUnitAssistMoveTask` (+ Assist) |
| 0x0A | Attack | `CAttackTargetTask` |
| 0x0B | FormAttack | `CAttackTargetTask` (Formation) |
| 0x0C | Nuke | Fire-Task |
| 0x0D | Tactical | Fire-Task |
| 0x0E | Teleport | `CUnitTeleportTask` |
| 0x0F | Guard | `CUnitGuardTask` |
| 0x10 | Patrol | `CUnitPatrolTask` |
| 0x11 | Ferry | `CUnitFerryTask` / `CUnitWaitForFerryTask` |
| 0x12 | FormPatrol | `CUnitPatrolTask` (Formation) |
| 0x13 | Reclaim | `IssueReclaimTask` |
| 0x14 | Repair | `CUnitRepairTask` |
| 0x15 | Capture | `CUnitCaptureTask` |
| 0x16 | TransportLoadUnits | `CUnitLoadUnits` |
| 0x17 | TransportReverseLoadUnits | `CUnitLoadUnits` |
| 0x18 | TransportUnloadUnits | `CUnitUnloadUnits` |
| 0x19 | TransportUnloadSpecificUnits | `CUnitUnloadUnits` |
| 0x1A | DetachFromTransport | Transport-Detach |
| 0x1B | Upgrade | `CUnitUpgradeTask` |
| 0x1C | Script | `CUnitScriptTask` |
| 0x1D | AssistCommander | `CUnitPodAssist` |
| 0x1E | KillSelf | `IAiCommandDispatchImpl::KillSelf` |
| 0x1F | DestroySelf | `Entity::Destroy` |
| 0x20 | Sacrifice | `CUnitSacrificeTask` |
| 0x21 | break | `Unit::SetPaused` |
| 0x22 | OverCharge | `CUnitFireAtTask` |
| 0x23 | AggressiveMove | `NewMoveTask` (aggressiv) |
| 0x24 | FormAggressiveMove | `CUnitFormAndMoveTask` (aggressiv) |
| 0x25 | AssistMove | `CUnitAssistMoveTask` |
| 0x26 | SpecialAction | `CUnitScriptTask` |
| 0x27 | Dock | Carrier-Land (`IssueCarrierLandTask`) |

Weitere Callees: `NewCallTransportCommand`, `IssueRefuelTask`,
`IssueCallTeleportTask`, `IssueCallLandTransportTask`,
`IssueCallAirStagingPlatformTask`, `CUnitCarrierLaunch`,
`CUnitCarrierRetrieve` — transport/carrier/refuel routes.

## For reconstruction (Phase C)
- Our `UnitCommand` only knows `move`. Target image: this enum as a command type,
  a task base class with `execute() -> SchedulingResult` (−1 done,
  0 immediately again, N wait), queue semantics from [sim-core.md](sim-core.md)
  (Patrol/FormPatrol rotate the head to the end = ring cue).
- The exact branching in the switch (conditions, target resolution) is included
  0x608EF0 ready if a single task is recreated exactly.
