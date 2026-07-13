# Befehls-Dispatch (Command → Task) — aus dem Binary

**Quelle:** `IAiCommandDispatchImpl::DispatchTask` @ **0x608EF0** (der große
Switch, in faf-re als Stub). Die **Callee-Liste** dieser Funktion ist
faktisch die Dispatch-Tabelle: jeder Befehlstyp erzeugt einen konkreten
Task und pusht ihn auf den Task-Stack des Unit-Threads (siehe
[sim-core.md](sim-core.md): Rückgabewert steuert das Scheduling).

Befehls-Enum: `EUnitCommandType` (faf-re `command/SSTICommandIssueData.h`).

## Dispatch-Tabelle

| Opcode | Befehl | erzeugter Task / Aktion |
| --- | --- | --- |
| 0x01 | Stop | `IAiCommandDispatchImpl::Stop` |
| 0x02 | Move | `NewMoveTask` |
| 0x03 | Dive | (Tauch-Zustand) |
| 0x04 | FormMove | `CUnitFormAndMoveTask` |
| 0x05 | BuildSiloTactical | Silo-Bau |
| 0x06 | BuildSiloNuke | Silo-Bau |
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
| 0x21 | Pause | `Unit::SetPaused` |
| 0x22 | OverCharge | `CUnitFireAtTask` |
| 0x23 | AggressiveMove | `NewMoveTask` (aggressiv) |
| 0x24 | FormAggressiveMove | `CUnitFormAndMoveTask` (aggressiv) |
| 0x25 | AssistMove | `CUnitAssistMoveTask` |
| 0x26 | SpecialAction | `CUnitScriptTask` |
| 0x27 | Dock | Carrier-Land (`IssueCarrierLandTask`) |

Weitere Callees: `NewCallTransportCommand`, `IssueRefuelTask`,
`IssueCallTeleportTask`, `IssueCallLandTransportTask`,
`IssueCallAirStagingPlatformTask`, `CUnitCarrierLaunch`,
`CUnitCarrierRetrieve` — Transport-/Träger-/Nachtank-Wege.

## Für den Nachbau (Phase C)
- Unser `UnitCommand` kennt nur `move`. Zielbild: dieses Enum als Befehlstyp,
  eine Task-Basisklasse mit `execute() -> SchedulingResult` (−1 fertig,
  0 sofort nochmal, N warten), Queue-Semantik aus [sim-core.md](sim-core.md)
  (Patrol/FormPatrol rotieren den Kopf ans Ende = Ringqueue).
- Die genaue Verzweigung im Switch (Bedingungen, Ziel-Auflösung) liegt bei
  0x608EF0 bereit, wenn ein einzelner Task exakt nachgebaut wird.
