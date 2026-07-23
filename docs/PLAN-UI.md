# Plan for the real `lua/ui`

Created after an audit of the browser path and research into the original Lua
and Decomp. Every line here is supported by evidence (file:line or Cfile line);
nothing is guessed.

## Starting point

The **Sim is real**: worker → `installEngine()` → original `unit.lua`, weapons
from the script classes, a real `AIBrain`, and two-ratio economics. The **UI is
a fake**: `src/ui/hud.ts` (454 lines of TS) + `src/style.css` (601 lines)
recreate `economy_mini.lua`, `orders_mini.lua`, and `unitview.lua` — pixel
values are *copied* from the original Lua instead of executing it.

The path to real `lua/ui` requires **two things**:

1. A **second Lua VM on the main thread** (as in the original:
   `scr_UserInits` ≠ `sim_SimInits`, Cfile:422253/422444;
   `Moho::USER_GetLuaState` @0x8C65B0).
2. A **maui substrate**: the `InternalCreate*` globals, LazyVar instances,
   event pump, and text metrics.

Once the substrate exists, every further `lua/ui` file is nearly free.
`construction.lua` alone has 1700 lines that would otherwise need to be
recreated by hand.

---

## Part 0 — Quick wins (first; remove more than they build)

Rule: **nothing new in `hud.ts`.** These items fix bugs, remove false claims,
or build substrate that the later `lua/ui` needs anyway.

| # | What | File | Why now |
|---|-----|-------|---------|
| Q1 | `luaHookRegistered` is never reset; `clearContent()` kills every update hook → **nothing moves after the second sandbox start** | main.ts:686 | Reproducible total failure |
| Q2 | Worker `reset` (new LuaHost + `installEngine()`) | luaSimWorker.ts | Second start = second ACU = doubled `GiveInitialResources` |
| Q3 | **Terrain in the Sim**: `setTerrainSource()` is **never called** → `GetTerrainHeight` silently returns 0 everywhere. It must **fail loudly** without a source. | engineGlobals.ts:25, globals.lua, motion.lua | Prohibited silent stub. Prerequisite for step 6 (`GetElevation` during placement) |
| Q4 | Spawn exactly on the `ARMY_n` marker (remove the `+6/+6` offset and default `(20,0,20)`) | main.ts:336, 742 | Invented values |
| Q5 | Remove marketing lies: “box selection,” “Shift = queue,” cosmetic rectangle, dead multi-select branch | index.html, main.ts, hud.ts | Box select arrives with `worldview.lua`, not as TS |
| Q6 | Dead CSS remnants (style.css:456-590) — they **override** values declared “1:1 verified” | style.css | The layout claims to be verified but silently is not |
| Q7 | Render order dummies (`action: undefined`) as `disabled` | hud.ts:36-43 | Honesty, not expansion |
| Q8 | Send `requested()` + add a `NaN` guard when `max == 0` | worker, hud.ts:390 | `lastUseRequested` is mandatory for `GetEconomyTotals()` |
| Q9 | Do **not** “correct” army colors in TS — `lua/gamecolors.lua` is imported in step 3 | hud.ts:158 | One invented value does not replace another |

Do not touch (step 2+ discards them): minimap frame, icon tinting, unit-view
expansion.

---

## The minimal C++ substrate (with Decomp evidence)

### A. Second Lua VM (UI)
`Moho::USER_GetLuaState()` @0x8C65B0 (Cfile:1368027): a separate state, then
`scr_CoreInits` (Cfile:1368069) **and** `scr_UserInits` (Cfile:1368082).
70 Core globals in both VMs, 460 User globals **only** here, and 668 Sim
globals **never** here. Entry point:
`SCR_Import('/lua/ui/uimain.lua')['SetupUI']()` (Cfile:1262316), later
`func_StartGameUI` @0x83D240 → `gamemain.CreateWldUIProvider()`.

### B. LazyVar — **do not recreate**
`lua/lazyvar.lua` is original Lua in `mohodata.scd`. C++ provides only the
*instances*: `CMauiControl::CMauiControl` @0x7867B0 creates seven
`CScriptLazyVar_float` instances and publishes them in the Lua table
(Cfile:1123966-1123972): `Left, Right, Top, Bottom, Width, Height, Depth`.
`CMauiBitmap` additionally has `BitmapWidth`/`BitmapHeight` (Cfile:1118538),
set from the texture dimensions (Cfile:1118647) — therefore a bitmap defaults
to the size of its DDS.

### C. `InternalCreate*` (four are enough for step 3)
| Global | Cfile | DoInit |
|--------|-------|--------|
| `InternalCreateFrame` | 1136866 | 1136917 |
| `InternalCreateGroup` | 1137468 | 1137536 |
| `InternalCreateBitmap` | 1119519 | 1119577 |
| `InternalCreateText` | 1146210 | 1146271 |

The pattern is always the same: Lua creates the table → C++ attaches itself as
a peer → finally `DoInit()`. `CMauiControl::DoInit` @0x786E90 (Cfile:1124190)
is nothing other than `RunScript(this, "OnInit")`. Only then does
`Control.OnInit` run (control.lua:42) → `ResetLayout()` → the circular
six-variable chain.

### D. Control methods (minimum set)
`Destroy, GetParent, SetParent, Hide, Show, SetHidden, IsHidden, DisableHitTest,
EnableHitTest, SetName, SetNeedsFrameUpdate, SetAlpha, HitTest`
Bitmap: `SetNewTexture` (Cfile:1119593), `InternalSetSolidColor` (Cfile:1119821), `SetUV`
Text: `SetNewFont` (Cfile:1146287), `SetText`, `SetNewColor`, `GetStringAdvance`
(Cfile:1146720 — **required**, otherwise no text layout can be calculated)

### E. Event pump
`CMauiControl::HandleEvent` @0x7873A0 (Cfile:1124539) → `RunScript("HandleEvent", event)`.
**When Lua returns `false`, the event bubbles up the parent chain**
(Cfile:1124525). The event table exactly follows `func_CreateLuaEvent`
@0x795BD0 (Cfile:1136293):
`Type, MouseX, MouseY, WheelRotation, KeyCode, Modifiers{Shift,Ctrl,Alt,Left,Middle,Right}`.
Frame hook `OnFrame(delta)`, gated through `mNeedsFrameUpdate` (Cfile:1118936).

### F. Rendering
One control = one absolutely positioned `<div>` above the WebGL canvas. Each
RAF runs a layout pass that **pulls** `Left()/Top()/Width()/Height()` (the
LazyVar cache is built for that). Do **not** delegate hit testing to the DOM
(`pointer-events:none`); reproduce the original bubbling from Cfile:1124525.

---

## The steps (each remains runnable)

Rule: each step replaces **exactly one** panel. Once a Lua panel exists, its TS
twin is **deleted** — do not disable it behind a flag, or there will be two
sources of truth.

### Step 1 — UI VM boots; `SetupUI()` runs (2 days, low risk)
Built: `installUiEngine()`, UI globals (`DiskGetFileInfo`, `GetPreference`, `LOC`,
`ConExecute`). `_c_CreateCursor` (Cfile:1129627) is **immediately real**, not a stub.
Executed: `uimain.lua`, `uiutil.lua`, `skins.lua`.
Verify: `SetupUI()` succeeds; `UIUtil.GetLayoutFilename('economy')` resolves.

### Step 2 — maui substrate (1–2 weeks, **high risk**)
Built: B–F above.
Executed: `lazyvar.lua`, `maui/{control,group,bitmap,text,layouthelpers}.lua`.
Verify (headless, without DOM — LazyVar numbers only):
- `LayoutHelpers.AtLeftTopIn(b, g, 16, 3)` → `b.Left() == 16`, `b.Top() == 3`
- A bitmap without a helper sizes itself from its texture:
  `resources_panel_bmp.dds` → 324×72 (**matches today's hard-coded values** —
  proof that it works)
- `ResetLayout()` with too few Vars set → `error("circular dependency")`.
  **The error MUST occur.**

The three hazards: text metrics (`GetStringAdvance` must match the original
TTFs), `pixelScaleFactor` (layouthelpers.lua:22 — CSS currently ignores it
completely), and LazyVar cycles.

### Step 3 — first real `lua/ui`: `economy.lua` (3–4 days)
Built: **Sim→UI channel.** Original: `Sim::Sync` (Cfile:1074261) serializes
`_G.Sync` as binary; the UI sets `_G.Sync` and calls `OnSync()` (Cfile:1328262).
Here, the worker posts the sync table as a structured clone. *Same semantics,
different transport — that is engine freedom, not recreated logic.*
Globals: `GetEconomyTotals()` (keys exactly `maxStorage, stored, income,
lastUseRequested, lastUseActual` — economy.lua:271), `GetArmiesTable()` (colors
from `/lua/gamecolors.lua:16` — **import, do not retype**).
Afterward, **delete** hud.ts:256-320 + style.css:226-330.

### Step 4 — selection in the Sim + `unitview.lua` (4–5 days)
**The hidden blocker.** Without `GetSelectedUnits`, neither `orders.lua` nor
`construction.lua` runs. `UserUnit` proxy (Cfile:1364828), fed from the sync
snapshot. The icon path is
`/textures/ui/common/icons/units/<Display.IconName>_icon.dds`
(gamecommon.lua:16) — today's path through the blueprint ID (hud.ts:374) is wrong.

### Step 5 — `orders.lua` + real commands (1 week, high risk)
The order queue belongs in the Sim, not as direct navigator access.
`commandmode.lua` only holds state — the **engine polls** `GetCommandMode()`
(Cfile:1262974), not the other way around.

### Step 6 — `construction.lua` + construction (1 week)
`IssueBlueprintCommand` (Cfile:1265693), placement through
`func_OrderBuildStructure` @0x57A790 (footprint, snap, `GetElevation` —
**requires Q3**). On the Sim side, this is connected to `__spawnBuildSite` +
`issueBuildTask` — **they already exist and have never had a caller in the
browser.**

### Step 7 — the rest of `gamemain.CreateUI` (2+ weeks)
`borders.lua`, `worldview.lua` (the three.js canvas becomes a `CUIWorldView`
peer), `minimap.lua` (a **second WorldView** with `SetCartographic(true)`, not
a canvas of dots), `tabs`, `chat`, `tooltip`.
**`src/ui/hud.ts` and `style.css:226-590` are deleted.**

---

## Honest assessment

- **The bottleneck is step 2**, not the UI modules.
- **Step 4 is the hidden blocker.** Anyone who starts with 5/6 builds TS again.
- **Q3 (terrain) is a prerequisite for step 6.**
- Two VMs in the browser: the UI VM runs synchronously on the main thread;
  `OnSync()` must stay below ~5 ms per beat. If not, compress sync to deltas
  (the original does exactly that, `mUpdateEntities`, Cfile:1074586) — **do
  not** move the UI into the worker.
- `luaSimClient.ts` currently loads the complete `lua/ui/` tree into the **Sim**
  worker, where it never runs. From step 1 onward, it belongs in the UI VM.
