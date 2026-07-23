# Engine architecture + roadmap (from Cfile/ForgedAlliance.exe.c)

**Principle:** The engine (TS/WebGL) does calculations + rendering + hosts the
**two Lua states**; the original Lua IS the game. Not a TS replica
Game logic (see memory `engine-first-nicht-hardcoden`). Detailed evidence for the
Kern in [engine-core.md](engine-core.md). Zeilen = Cfile-Zeilen.

## Gesamtbild

- **Zwei getrennte Lua-States**: Sim (`Moho::Sim.mLuaState`) + UI
  (`UI_Manager->mState`). No shared memory — only bridge is the
  Lua global table **`Sync`** + the `SSyncData` package. Sim writes `Sync`
  per beat; UI reads it and calls `OnSync()`/`OnBeat()` (gamemain.lua).
- **C↔Lua binding** (`CScrLuaInitForm`): every C function is a `luadef_*`
  mit mMethodName/mClassName/mFunc(cfunc_*)/mFactory. Globals: mClassName
  `"<global>"`. Klassenmethoden → Metatable (`SCR_CreateSimpleMetatable`,
  `__index=self`), published as `moho.<x>_methods`, inheritance via the
  Array part (`unit_methods[n+1]=entity_methods`) — just like FA's class.lua is
  reads. **moho.ts does the model correctly, just incompletely.**
- **Object identity**: every C object carries `mLuaObj` (its Lua table),
  the Lua table is named `_c_object`. Lua→C via `SCR_FromLua_*`, C→Lua via
  `RunScript*` (self:Method(args), silent no-op if nil).

## Sim-Beat (10 Hz, `Sim::AdvanceBeat` :1076363)

Fixed order per tick (only when not paused; `++mCurTick`):
1. Zero per unit `mResourcesSpent/mProduced`
2. **je Armee `CArmyImpl::OnTick`** → `func_ArmyProcessEconomy(mEconomy)`
   (@0x771B50, the two-ratio economy from [economy-binary.md](economy-binary.md))
3. **`CTaskStage::DoFrame` ×3** → Lua-Coroutinen (ForkThread/WaitTicks) — M1 ✓
4. Intel/Recon (gestaffelt), Effekte, Formationen, Todes-Cleanup
5. `Entity::AdvanceCoords` (Physik/Bewegung)
6. Build `Sync` snapshot; GC every 70 ticks
- Then `Sim::Sync` → SSyncData + `Sync` table; UI thread `CWldSession::DoBeat`
  wendet es an, ruft `OnSync()`/`OnBeat()`. Render-Interpolation über
  `mTimeSinceLastTick` (0..1). Spielgeschwindigkeit `pow(10, simRate*0.1)`.

## moho-Sim API (the C metatables that the Sim Lua sees)

`moho.entity_methods` (Entity, 65), `moho.unit_methods` (Unit⊃Entity, 124),
`moho.weapon_methods` (32), `moho.projectile_methods` (30), CAiBrain (66),
CPlatoon (49), CAiPersonality (35), CAiNavigatorImpl (14), CAiAttackerImpl (17),
ReconBlip/IEffect/CDamage/Prop/Manipulatoren + ~445 Globals.
- **Economy is NOT scripted**: `CEconomy` sits in `CArmyImpl`; Lua
  only sees it via `CAiBrain:GetEconomyStored/…`. Unit connects via
  `Unit:SetConsumptionActive` → CEconRequest (perSecond 0.1) to `mArmy->GetEconomy()`;
  `CEconRequest::LimitingRate` is the return channel (construction scales with it).
- **Blueprints are pure Lua** (Blueprints.lua calls `RegisterUnitBlueprint{…}`);
  C only stores them in a registry according to the lowercase BlueprintId.
  **unitFactory.ts does it right.**
- **Command-Dispatch**: `IssueBlueprintCommand(cmd,bpId,count,clear)` → EUnitCommandType
  → Selektion → `ISSUE_Command` → `SimDriver::IssueCommand` (deterministisch)
  → `UNIT_IssueCommand` → CUnitCommand in `unit->mCommandQueue`.

## moho-UI-API (maui — which drives the UI-Lua/construction.lua)

C++-Control-Framework: `CMauiControl`-Basis (⊂ CScriptObject), Subklassen
Bitmap/Group/Text/Edit/ItemList/Border/Dragger/Scrollbar/…/CUIWorldView.
- Lua builds instance table, calls Global `InternalCreate<X>(self, parent)`;
  C legt Control an, `SetLuaObject` (mLuaObj=self, self._c_object=userdata).
- Layout über 7 `CScriptLazyVar_float` (Left/Right/Top/Bottom/Width/Height/Depth;
  Element [1] = number or function, GetValue evaluated+cached).
- Callback-Pump: `OnFrame(self,delta)`, `HandleEvent(self,event)` (bubbelt),
  `OnInit`, `OnDestroy`, `OnHide`.
- UI-Globals für construction.lua: `EntityCategoryGetUnitList(cat)` →
  blueprint names; `GetUnitCommandData(sel)` → (commandCaps, toggleCaps,
  buildableCategory); `IssueBlueprintCommand`, `StartCommandMode`; EntityCategory
  (+/-/*). **UIFile is NOT an engine function** (Lua helper in uiutil.lua).
- **hud.ts is the hand-built UI replica** — replacing lua/ui + maui.

## Roadmap (Meilensteine)

- **M1 ✓** Lua-Sim-Scheduler + Beat (ForkThread/WaitTicks + Zeit) — simThreads.ts.
- **M2** SimEngine: Integrate scheduler + unit spawn; `OnCreate` as a thread
  run; spawned unit tick over `__units` per tick. Replaces LuaSim.
- **M3** Ökonomie Lua-getrieben: moho `SetConsumptionActive`/`SetProductionPerSecond*`
  register real requests in a per-army economy (two-ratio math from
  take over simWorld, but fed by real unit requests). Replaces Army.tick hardcode.
- **M4** Movement: Navigator (`unit:GetNavigator():SetGoal`) + `Entity::AdvanceCoords`
  as engine physics, driven by Lua move commands.
- **M5** Command-Dispatch: `IssueBlueprintCommand`/CommandQueue/Tasks (Move/Build),
  Build via LimitingRate + Lua callbacks (OnStartBuild/OnStopBeingBuilt).
- **M6** maui-UI-Kern: `moho.<x>_methods` für Controls, `InternalCreate*`,
  LazyVar layout, OnFrame/HandleEvent pump, Bitmap/Text/Group rendering — with it
  lua/ui/game/construction.lua runs unchanged. Afterwards: Replace hud.ts with real UI-Lua.
- **later** Sim→UI sync (`Sync` table, OnSync/OnBeat), lockstep gate +
  MD5-Checksummen (MP-Determinismus), Gleis A (Lua-5.0-WASM für Bit-Genauigkeit).
