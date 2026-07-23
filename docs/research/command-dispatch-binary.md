# Command dispatch (Command → Task) — from the binary

**Source:** `IAiCommandDispatchImpl::DispatchTask` @ **0x608EF0** (the main
switch statement; a stub in faf-re). The function's **callee list** is
effectively the dispatch table: each command type creates a specific task and
pushes it onto the unit thread's task stack (see
[sim-core.md](sim-core.md): the return value controls scheduling).

Command enum: `EUnitCommandType` (faf-re `command/SSTICommandIssueData.h`).

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
| 0x0C | Nuke | fire task |
| 0x0D | Tactical | fire task |
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
| 0x1A | DetachFromTransport | detach from transport |
| 0x1B | Upgrade | `CUnitUpgradeTask` |
| 0x1C | Script | `CUnitScriptTask` |
| 0x1D | AssistCommander | `CUnitPodAssist` |
| 0x1E | KillSelf | `IAiCommandDispatchImpl::KillSelf` |
| 0x1F | DestroySelf | `Entity::Destroy` |
| 0x20 | Sacrifice | `CUnitSacrificeTask` |
| 0x21 | Pause | `Unit::SetPaused` |
| 0x22 | OverCharge | `CUnitFireAtTask` |
| 0x23 | AggressiveMove | `NewMoveTask` (aggressive) |
| 0x24 | FormAggressiveMove | `CUnitFormAndMoveTask` (aggressive) |
| 0x25 | AssistMove | `CUnitAssistMoveTask` |
| 0x26 | SpecialAction | `CUnitScriptTask` |
| 0x27 | Dock | carrier landing (`IssueCarrierLandTask`) |

Additional callees: `NewCallTransportCommand`, `IssueRefuelTask`,
`IssueCallTeleportTask`, `IssueCallLandTransportTask`,
`IssueCallAirStagingPlatformTask`, `CUnitCarrierLaunch`,
`CUnitCarrierRetrieve` — transport, carrier, and refueling paths.

## For reconstruction (Phase C)
- Our `UnitCommand` supports only `move`. The target architecture is this enum
  as a command type and a task base class with `execute() -> SchedulingResult`
  (−1: done, 0: run again immediately, N: wait), with the queue semantics from
  [sim-core.md](sim-core.md) (Patrol/FormPatrol move the head to the tail,
  forming a ring queue).
- The exact switch branches (conditions and target resolution) are available at
  0x608EF0 when reconstructing an individual task exactly.
