# Engine architecture + roadmap (from Cfile/ForgedAlliance.exe.c)

**Principle:** The engine (TS/WebGL) performs calculations and rendering and hosts
the **two Lua states**; the original Lua IS the game. Do not recreate game
logic in TypeScript (see memory `engine-first-nicht-hardcoden`). Detailed evidence for the
core is in [engine-core.md](engine-core.md). Line references refer to Cfile.

## Overview

- **Two separate Lua states:** Sim (`Moho::Sim.mLuaState`) and UI
  (`UI_Manager->mState`). They do not share memory; their only bridge is the
  Lua global table **`Sync`** and the `SSyncData` package. The Sim writes `Sync`
  every beat; the UI reads it and calls `OnSync()`/`OnBeat()` (gamemain.lua).
- **C↔Lua binding** (`CScrLuaInitForm`): every C function has a `luadef_*`
  with `mMethodName`/`mClassName`/`mFunc(cfunc_*)`/`mFactory`. Globals use
  `mClassName`; its value is `"<global>"`. Class methods are exposed through a metatable
  (`SCR_CreateSimpleMetatable`, `__index=self`) as `moho.<x>_methods`; inheritance
  uses the array part (`unit_methods[n+1]=entity_methods`), exactly as FA's
  class.lua expects it. **moho.ts models this correctly, but incompletely.**
- **Object identity:** every C object carries `mLuaObj` (its Lua table), and
  every Lua table carries `_c_object`. Lua→C uses `SCR_FromLua_*`; C→Lua uses
  `RunScript*` (`self:Method(args)`, a silent no-op when the method is nil).

## Sim beat (10 Hz, `Sim::AdvanceBeat` :1076363)

Fixed order per tick (only when not paused; `++mCurTick`):

1. Reset the per-unit `mResourcesSpent/mProduced` values.
2. Run `CArmyImpl::OnTick` for **each army**, then
   `func_ArmyProcessEconomy(mEconomy)` (@0x771B50; see the two-ratio economy in
   [economy-binary.md](economy-binary.md)).
3. Run **`CTaskStage::DoFrame` ×3** for Lua coroutines (ForkThread/WaitTicks) — M1 ✓.
4. Process staggered intel/recon, effects, formations, and death cleanup.
5. Run `Entity::AdvanceCoords` for physics and movement.
6. Build the `Sync` snapshot; run GC every 70 ticks.

`Sim::Sync` then transfers `SSyncData` and the `Sync` table. The UI thread's
`CWldSession::DoBeat` applies them and calls `OnSync()`/`OnBeat()`. Rendering
interpolates through `mTimeSinceLastTick` (0..1). Simulation speed is
`pow(10, simRate*0.1)`.

## moho Sim API (the C metatables visible to Sim Lua)

`moho.entity_methods` (Entity, 65), `moho.unit_methods` (Unit⊃Entity, 124),
`moho.weapon_methods` (32), `moho.projectile_methods` (30), CAiBrain (66),
CPlatoon (49), CAiPersonality (35), CAiNavigatorImpl (14), CAiAttackerImpl (17),
ReconBlip/IEffect/CDamage/Prop/manipulators, plus ~445 globals.

- **Economy is NOT scripted:** `CEconomy` resides in `CArmyImpl`; Lua accesses
  it only through `CAiBrain:GetEconomyStored/…`. A unit connects through
  `Unit:SetConsumptionActive` → CEconRequest (`perSecond·0.1`) to
  `mArmy->GetEconomy()`; `CEconRequest::LimitingRate` is the return channel
  that scales construction.
- **Blueprints are pure Lua:** Blueprints.lua calls `RegisterUnitBlueprint{…}`;
  C stores them only in a registry under the lowercased BlueprintId.
  **unitFactory.ts already handles this correctly.**
- **Command dispatch:** `IssueBlueprintCommand(cmd,bpId,count,clear)` →
  EUnitCommandType → selection → `ISSUE_Command` →
  `SimDriver::IssueCommand` (deterministic) → `UNIT_IssueCommand` →
  CUnitCommand in `unit->mCommandQueue`.

## moho UI API (maui, which drives UI Lua/construction.lua)

The C++ control framework has `CMauiControl` as its base (⊂ CScriptObject), with
subclasses including Bitmap/Group/Text/Edit/ItemList/Border/Dragger/Scrollbar/…/CUIWorldView.

- Lua builds an instance table and calls the global `InternalCreate<X>(self, parent)`;
  C creates the control and calls `SetLuaObject` (`mLuaObj=self`,
  `self._c_object=userdata`).
- Layout uses seven `CScriptLazyVar_float` values
  (Left/Right/Top/Bottom/Width/Height/Depth; element [1] is a number or function;
  `GetValue` evaluates and caches it).
- The callback pump invokes `OnFrame(self,delta)`, bubbling
  `HandleEvent(self,event)`, `OnInit`, `OnDestroy`, and `OnHide`.
- UI globals used by construction.lua include `EntityCategoryGetUnitList(cat)` →
  blueprint names; `GetUnitCommandData(sel)` → (commandCaps, toggleCaps,
  buildableCategory); `IssueBlueprintCommand`; `StartCommandMode`; and
  EntityCategory (`+`/`-`/`*`). **UIFile is NOT an engine function**; it is a
  Lua helper in uiutil.lua.
- **hud.ts is the hand-built UI replica** that lua/ui and maui must replace.

## Roadmap (milestones)

- **M1 ✓** Lua Sim scheduler and beat (ForkThread/WaitTicks + time) — simThreads.ts.
- **M2** SimEngine: integrate the scheduler and unit spawning; run `OnCreate` as a
  thread; tick spawned units in `__units` every tick. Replaces LuaSim.
- **M3** Lua-driven economy: have moho `SetConsumptionActive`/
  `SetProductionPerSecond*` register real requests in a per-army economy. Reuse
  the two-ratio math from simWorld, but feed it with real unit requests. Replaces
  the `Army.tick` hardcode.
- **M4** Movement: implement the Navigator (`unit:GetNavigator():SetGoal`) and
  `Entity::AdvanceCoords` as engine physics driven by Lua move commands.
- **M5** Command dispatch: `IssueBlueprintCommand`/CommandQueue/Tasks (Move/Build),
  with construction driven by LimitingRate and Lua callbacks
  (OnStartBuild/OnStopBeingBuilt).
- **M6** maui UI core: `moho.<x>_methods` for controls, `InternalCreate*`,
  LazyVar layout, the OnFrame/HandleEvent pump, and Bitmap/Text/Group rendering,
  allowing lua/ui/game/construction.lua to run unchanged. Then replace hud.ts
  with the real UI Lua.
- **Later:** Sim→UI sync (`Sync` table, OnSync/OnBeat), a lockstep gate and MD5
  checksums (MP determinism), and Track A (Lua-5.0-WASM for bit precision).
