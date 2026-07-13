# Engine-Architektur + Roadmap (aus Cfile/ForgedAlliance.exe.c)

**Grundsatz:** Die Engine (TS/WebGL) macht Berechnungen + Rendering + hostet die
**zwei Lua-States**; die Original-Lua IST das Spiel. Kein TS-Nachbau der
Spiellogik (siehe Memory `engine-first-nicht-hardcoden`). Detailbelege für den
Kern in [engine-core.md](engine-core.md). Zeilen = Cfile-Zeilen.

## Gesamtbild

- **Zwei getrennte Lua-States**: Sim (`Moho::Sim.mLuaState`) + UI
  (`UI_Manager->mState`). Kein geteilter Speicher — einzige Brücke ist die
  Lua-Global-Tabelle **`Sync`** + das `SSyncData`-Paket. Sim schreibt `Sync`
  pro Beat; UI liest es und ruft `OnSync()`/`OnBeat()` (gamemain.lua).
- **C↔Lua-Bindung** (`CScrLuaInitForm`): jede C-Funktion ist ein `luadef_*`
  mit mMethodName/mClassName/mFunc(cfunc_*)/mFactory. Globals: mClassName
  `"<global>"`. Klassenmethoden → Metatable (`SCR_CreateSimpleMetatable`,
  `__index=self`), publiziert als `moho.<x>_methods`, Vererbung über den
  Array-Teil (`unit_methods[n+1]=entity_methods`) — genau wie FAs class.lua es
  liest. **moho.ts macht das Modell schon richtig, nur unvollständig.**
- **Objektidentität**: jedes C-Objekt trägt `mLuaObj` (seine Lua-Tabelle),
  die Lua-Tabelle trägt `_c_object`. Lua→C via `SCR_FromLua_*`, C→Lua via
  `RunScript*` (self:Method(args), stiller No-Op wenn nil).

## Sim-Beat (10 Hz, `Sim::AdvanceBeat` :1076363)

Feste Reihenfolge pro Tick (nur wenn nicht pausiert; `++mCurTick`):
1. per-Unit `mResourcesSpent/mProduced` nullen
2. **je Armee `CArmyImpl::OnTick`** → `func_ArmyProcessEconomy(mEconomy)`
   (@0x771B50, die Zwei-Ratio-Ökonomie aus [economy-binary.md](economy-binary.md))
3. **`CTaskStage::DoFrame` ×3** → Lua-Coroutinen (ForkThread/WaitTicks) — M1 ✓
4. Intel/Recon (gestaffelt), Effekte, Formationen, Todes-Cleanup
5. `Entity::AdvanceCoords` (Physik/Bewegung)
6. `Sync`-Snapshot bauen; GC alle 70 Ticks
- Danach `Sim::Sync` → SSyncData + `Sync`-Tabelle; UI-Thread `CWldSession::DoBeat`
  wendet es an, ruft `OnSync()`/`OnBeat()`. Render-Interpolation über
  `mTimeSinceLastTick` (0..1). Spielgeschwindigkeit `pow(10, simRate*0.1)`.

## moho-Sim-API (die C-Metatables, die die Sim-Lua sieht)

`moho.entity_methods` (Entity, 65), `moho.unit_methods` (Unit⊃Entity, 124),
`moho.weapon_methods` (32), `moho.projectile_methods` (30), CAiBrain (66),
CPlatoon (49), CAiPersonality (35), CAiNavigatorImpl (14), CAiAttackerImpl (17),
ReconBlip/IEffect/CDamage/Prop/Manipulatoren + ~445 Globals.
- **Ökonomie ist NICHT skriptgebunden**: `CEconomy` sitzt im `CArmyImpl`; Lua
  sieht sie nur über `CAiBrain:GetEconomyStored/…`. Unit koppelt via
  `Unit:SetConsumptionActive` → CEconRequest (perSecond·0.1) an `mArmy->GetEconomy()`;
  `CEconRequest::LimitingRate` ist der Rückkanal (Bau skaliert damit).
- **Blueprints sind reine Lua** (Blueprints.lua ruft `RegisterUnitBlueprint{…}`);
  C legt sie nur nach kleingeschriebener BlueprintId in einer Registry ab.
  **unitFactory.ts macht das schon richtig.**
- **Command-Dispatch**: `IssueBlueprintCommand(cmd,bpId,count,clear)` → EUnitCommandType
  → Selektion → `ISSUE_Command` → `SimDriver::IssueCommand` (deterministisch)
  → `UNIT_IssueCommand` → CUnitCommand in `unit->mCommandQueue`.

## moho-UI-API (maui — was die UI-Lua/construction.lua fährt)

C++-Control-Framework: `CMauiControl`-Basis (⊂ CScriptObject), Subklassen
Bitmap/Group/Text/Edit/ItemList/Border/Dragger/Scrollbar/…/CUIWorldView.
- Lua baut Instanz-Tabelle, ruft Global `InternalCreate<X>(self, parent)`;
  C legt Control an, `SetLuaObject` (mLuaObj=self, self._c_object=userdata).
- Layout über 7 `CScriptLazyVar_float` (Left/Right/Top/Bottom/Width/Height/Depth;
  Element [1] = Zahl oder Funktion, GetValue evaluiert+cached).
- Callback-Pump: `OnFrame(self,delta)`, `HandleEvent(self,event)` (bubbelt),
  `OnInit`, `OnDestroy`, `OnHide`.
- UI-Globals für construction.lua: `EntityCategoryGetUnitList(cat)` →
  Blueprint-Namen; `GetUnitCommandData(sel)` → (commandCaps, toggleCaps,
  buildableCategory); `IssueBlueprintCommand`, `StartCommandMode`; EntityCategory
  (+/-/*). **UIFile ist KEINE Engine-Funktion** (Lua-Helfer in uiutil.lua).
- **hud.ts ist der handgebaute UI-Nachbau** — den ersetzen lua/ui + maui.

## Roadmap (Meilensteine)

- **M1 ✓** Lua-Sim-Scheduler + Beat (ForkThread/WaitTicks + Zeit) — simThreads.ts.
- **M2** SimEngine: Scheduler + Unit-Spawn integrieren; `OnCreate` als Thread
  laufen lassen; gespawnte Unit über `__units` pro Tick ticken. Ersetzt LuaSim.
- **M3** Ökonomie Lua-getrieben: moho `SetConsumptionActive`/`SetProductionPerSecond*`
  registrieren echte Requests in einer per-Armee-Ökonomie (Zwei-Ratio-Math aus
  simWorld übernehmen, aber von echten Unit-Requests gespeist). Ersetzt Army.tick-Hardcode.
- **M4** Bewegung: Navigator (`unit:GetNavigator():SetGoal`) + `Entity::AdvanceCoords`
  als Engine-Physik, getrieben von Lua-Move-Kommandos.
- **M5** Command-Dispatch: `IssueBlueprintCommand`/CommandQueue/Tasks (Move/Build),
  Bau über LimitingRate + Lua-Callbacks (OnStartBuild/OnStopBeingBuilt).
- **M6** maui-UI-Kern: `moho.<x>_methods` für Controls, `InternalCreate*`,
  LazyVar-Layout, OnFrame/HandleEvent-Pump, Bitmap/Text/Group-Rendering — damit
  lua/ui/game/construction.lua unverändert läuft. Danach: hud.ts durch echte UI-Lua ersetzen.
- **später** Sim→UI-Sync (`Sync`-Tabelle, OnSync/OnBeat), Lockstep-Gate +
  MD5-Checksummen (MP-Determinismus), Gleis A (Lua-5.0-WASM für Bit-Genauigkeit).
