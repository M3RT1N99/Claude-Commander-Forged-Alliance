# Path to the real `lua/ui` plan

Created after an audit of the browser path + research in original Lua and Decomp.
Every line here is occupied (file:line or cfile line), nothing is advised.

## Ausgangslage

The **Sim is real**: Worker → `installEngine()` → Original `unit.lua`, weapons off
the script classes, real `AIBrain`, two-ratio economics. The **UI is fake**:
Build `src/ui/hud.ts` (454 lines TS) + `src/style.css` (601 lines).
`economy_mini.lua`, `orders_mini.lua` and `unitview.lua` after — the pixel values ​​are
*copied* from the original Lua instead of executing it.

The path to the real `lua/ui` leads through **two things**:

1. A **second Lua VM in the main thread** (as in the original: `scr_UserInits` ≠
   `sim_SimInits`, Cfile:422253/422444; `Moho::USER_GetLuaState` @0x8C65B0).
2. A **maui substrate**: the `InternalCreate*` globals, LazyVar instances,
   Event pump, text metrics.

Once the substrate is in place, every additional `lua/ui` file is almost free. `construction.lua`
There are 1,700 lines alone that would otherwise have to be recreated by hand.

---

## Part 0 — Quick Wins (previously, delete more than they build)

Rule: **nothing new in `hud.ts`.** These points fix bugs, remove lies or
build substrate that the later `lua/ui` needs anyway.

| # | What | File | Why now |
|---|-----|-------|-------------|
| Q1 | `luaHookRegistered` is never reset, `clearContent()` kills all update hooks → **nothing moves from the 2nd sandbox start** | main.ts:686 | Reproducible total failure |
| Q2 | Worker-`reset` (neuer LuaHost + `installEngine()`) | luaSimWorker.ts | 2. Start = 2. ACU = doppeltes `GiveInitialResources` |
| Q3 | **Terrain into the sim**: `setTerrainSource()` is **never called** → `GetTerrainHeight` silently delivers 0 everywhere. Without a source it has to **pop**. | engineGlobals.ts:25, globals.lua, motion.lua | Forbidden quiet room. Prerequisite for step 6 (`GetElevation` when placing) |
| Q4 | Spawn exactly on the `ARMY_n` marker (`+6/+6` offset and default `(20,0,20)` out) | main.ts:336, 742 | Invented numbers |
| Q5 | Advertising lies out: “box selection”, “shift = queue”, cosmetic rectangle, dead multi-select branch | index.html, main.ts, hud.ts | Box-Select comes as `worldview.lua`, not TS |
| Q6 | Dead CSS corpses (style.css:456-590) — they **overwrite** the values ​​declared as “1:1 verified” | style.css | Layout claims to be verified and is still not |
| Q7 | Render order dummies (`action: undefined`) as `disabled` | hud.ts:36-43 | Honesty, no expansion |
| Q8 | Send `requested()` + `NaN`-Guard at `max == 0` | worker, hud.ts:390 | `lastUseRequested` is mandatory for `GetEconomyTotals()` |
| Q9 | **Not** “correct” army colors in TS — `lua/gamecolors.lua` is imported in step 3 | hud.ts:158 | A second invented value does not replace a first |

Don't touch it (step 2+ throws it away): minimap frame, icon tinting, unit view expansion.

---

## The minimal C++ substrate (with decomp evidence)

### A. Zweite Lua-VM (UI)
`Moho::USER_GetLuaState()` @0x8C65B0 (Cfile:1368027): own state, then
`scr_CoreInits` (Cfile:1368069) **and** `scr_UserInits` (Cfile:1368082).
70 core globals in both VMs, 460 user globals **only** here, 668 sim globals **never**.
Einstieg: `SCR_Import('/lua/ui/uimain.lua')['SetupUI']()` (Cfile:1262316), später
`func_StartGameUI` @0x83D240 → `gamemain.CreateWldUIProvider()`.

### B. LazyVar — **do not recreate**
`lua/lazyvar.lua` is located in `mohodata.scd` and is original Lua. C++ only provides that
*Instanzen*: `CMauiControl::CMauiControl` @0x7867B0 erzeugt sieben
`CScriptLazyVar_float` and publishes them to the Lua table (Cfile:1123966-1123972):
`Left, Right, Top, Bottom, Width, Height, Depth`. `CMauiBitmap` zusätzlich
`BitmapWidth`/`BitmapHeight` (Cfile:1118538), set from the texture dimensions
(Cfile:1118647) — that's why a bitmap is measured by its DDS by default.

### C. `InternalCreate*` (four are enough for step 3)
| Global | Cfile | DoInit |
|--------|-------|--------|
| `InternalCreateFrame` | 1136866 | 1136917 |
| `InternalCreateGroup` | 1137468 | 1137536 |
| `InternalCreateBitmap` | 1119519 | 1119577 |
| `InternalCreateText` | 1146210 | 1146271 |

Pattern is the same everywhere: Lua creates the table → C++ attaches itself to it as a peer → am
End `DoInit()`, and `CMauiControl::DoInit` @0x786E90 (Cfile:1124190) is nothing
other than `RunScript(this, "OnInit")`. Only then does `Control.OnInit` run
(control.lua:42) → `ResetLayout()` → the circular 6-var chain.

### D. Control-Methoden (Minimalmenge)
`Destroy, GetParent, SetParent, Hide, Show, SetHidden, IsHidden, DisableHitTest,
EnableHitTest, SetName, SetNeedsFrameUpdate, SetAlpha, HitTest`
Bitmap: `SetNewTexture` (Cfile:1119593), `InternalSetSolidColor` (Cfile:1119821), `SetUV`
Text: `SetNewFont` (Cfile:1146287), `SetText`, `SetNewColor`, `GetStringAdvance`
(Cfile:1146720 — **Mandatory**, otherwise no text layout can be calculated)

### E. Event-Pump
`CMauiControl::HandleEvent` @0x7873A0 (Cfile:1124539) → `RunScript("HandleEvent", event)`.
**If Lua delivers `false`, the event bubbles up the parent chain** (Cfile:1124525).
Event-Table exakt nach `func_CreateLuaEvent` @0x795BD0 (Cfile:1136293):
`Type, MouseX, MouseY, WheelRotation, KeyCode, Modifiers{Shift,Ctrl,Alt,Left,Middle,Right}`.
Frame-Hook `OnFrame(delta)`, gated über `mNeedsFrameUpdate` (Cfile:1118936).

### F. Rendering
A control = an absolutely positioned `<div>` over the WebGL canvas. Pro RAF one
Layout pass that **pulls** `Left()/Top()/Width()/Height()` (that's what the
LazyVar cache built). Hit test **not** left to the DOM (`pointer-events:none`),
but recreate the original bubbling from Cfile:1124525.

---

## The steps (can be run at any time)

Rule: Each step replaces **exactly one** panel. If there is a panel from Lua, it will
TS twin **deleted** — not disabled by flag, otherwise you have two truths.

### Step 1 — UI VM boots, `SetupUI()` running (2 days, risk low)
Built: `installUiEngine()`, UI Globals (`DiskGetFileInfo`, `GetPreference`, `LOC`,
`ConExecute`). `_c_CreateCursor` (Cfile:1129627) **immediately real**, no stub.
Ausgeführt: `uimain.lua`, `uiutil.lua`, `skins.lua`.
Verify: `SetupUI()` error-free; `UIUtil.GetLayoutFilename('economy')` resolves.

### Step 2 — maui substrate (1-2 weeks, **high risk**)
Built: B-F above.
Executed: `lazyvar.lua`, `maui/{control,group,bitmap,text,layouthelpers}.lua`.
Verify (headless, no DOM — LazyVar numbers only):
- `LayoutHelpers.AtLeftTopIn(b, g, 16, 3)` → `b.Left() == 16`, `b.Top() == 3`
- Bitmap without helper measures by texture: `resources_panel_bmp.dds` → 324×72
  (**consistent with today's hard-coded values** — proof that it works)
- `ResetLayout()` mit zu wenig gesetzten Vars → `error("circular dependency")`.
  **The error MUST occur.**

The three mines: text metrics (`GetStringAdvance` must match the original TTFs),
`pixelScaleFactor` (layouthelpers.lua:22 — the CSS completely ignores it today),
LazyVar-Zyklen.

### Step 3 — First real `lua/ui`: `economy.lua` (3-4 days)
Built: **Sim→UI channel.** Original: `Sim::Sync` (Cfile:1074261) serializes `_G.Sync`
binary, UI sets `_G.Sync` and calls `OnSync()` (Cfile:1328262). With us: Worker posts
the sync table as a structured clone. *Same semantics, different transport — that is
Engine freedom, no logic imitation.*
Globals: `GetEconomyTotals()` (Keys exakt `maxStorage, stored, income,
lastUseRequested, lastUseActual` — economy.lua:271), `GetArmiesTable()` (colors off
`/lua/gamecolors.lua:16` — **import, do not type**).
Danach **gelöscht**: hud.ts:256-320 + style.css:226-330.

### Step 4 — Selection in the Sim + `unitview.lua` (4-5 days)
**The hidden blocker.** Without `GetSelectedUnits` neither `orders.lua` nor works
`construction.lua`. `UserUnit` proxy (Cfile:1364828), fed from the sync snapshot.
Icon path is `/textures/ui/common/icons/units/<Display.IconName>_icon.dds`
(gamecommon.lua:16) — today's path via the blueprint ID (hud.ts:374) is incorrect.

### Step 5 — `orders.lua` + real commands (1 week, risk high)
Order queue in the sim instead of direct navigator access. `commandmode.lua` is just one
State holder — the **engine polls** `GetCommandMode()` (Cfile:1262974), not the other way around.

### Step 6 — `construction.lua` + Construction (1 week)
`IssueBlueprintCommand` (Cfile:1265693), Platzierung über `func_OrderBuildStructure`
@0x57A790 (Footprint, Snap, `GetElevation` — **braucht Q3**).
On the SIM side, it depends on `__spawnBuildSite` + `issueBuildTask` — **which exist
already and have never had a caller in the browser.**

### Step 7 — Remainder of `gamemain.CreateUI` (2+ weeks)
`borders.lua`, `worldview.lua` (the three.js canvas becomes a `CUIWorldView` peer),
`minimap.lua` (a **second WorldView** with `SetCartographic(true)`, no canvas with
Punkten), `tabs`, `chat`, `tooltip`.
**`src/ui/hud.ts` and `style.css:226-590` are deleted.**

---

## Ehrliche Einschätzung

- **Bottleneck is step 2**, not the UI modules.
- **Step 4 is the hidden blocker.** If you prefer 5/6, build TS again.
- **Q3 (Terrain) is a prerequisite for step 6.**
- Two VMs in the browser: the UI VM runs synchronously in the main thread; `OnSync()` must per
  Beat stay under ~5 ms. If not: reduce sync to deltas (the original does
  exactly that, `mUpdateEntities`, Cfile:1074586) — **don't** push the UI into the worker.
- `luaSimClient.ts` loads the complete `lua/ui/` tree into the **Sim** worker today,
  where he never runs. From step 1 it belongs in the UI VM.
