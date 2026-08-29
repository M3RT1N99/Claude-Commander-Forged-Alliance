-- The ARMY BRAINS. The engine creates them (SimInit step 5a) and reports each
-- one to Lua: `OnCreateArmyBrain(index, brain, name, nickname)`
-- (siminit.lua:113-125). There it enters the global `ArmyBrains` list that
-- SetupSession created (siminit.lua:57).
--
-- This list is essential: unit.lua:1429 (OnKilledVO) iterates it when EVERY
-- unit dies — `for num, aiBrain in ArmyBrains do`. Without it, the death path
-- dies in the middle of OnKilled, DeathThread never starts, and no wreck is
-- created. (Found exactly this way.)
--
-- We cannot yet run SimInit.lua completely: its SetupSession() loads the map
-- files (`ScenarioInfo.save`/`.script`, siminit.lua:91-98), and the real
-- session start only arrives with M10. Until then, the engine side creates
-- `ArmyBrains` exactly as OnCreateArmyBrain would — including name and nickname.
__brains = __brains or {}

-- Strict _G (config.lua:51-56): READING a nonexistent global throws. Therefore
-- use rawget/rawset instead of `ArmyBrains = ArmyBrains or {}`.
if rawget(_G, 'ArmyBrains') == nil then rawset(_G, 'ArmyBrains', {}) end

--- `CAiBrain::CAiBrain` (Cfile:724270-724386) — der KONSTRUKTOR, und nichts
--- weiter. Er legt das Lua-Objekt an, haengt die Personality daran und liest sie
--- ein; `OnCreateHuman`/`OnCreateAI` ruft er NICHT. Das macht
--- `InitializeArmyAI` (Cfile:1024677-1024699), und zwar mit der Entscheidung
--- `IsHuman` -> Human, sonst AI (Cfile:724516-724518).
---
--- Hier stand einmal ein unbedingtes `b:OnCreateHuman(planName)`. Seit der
--- Sitzungsstart die Retail-Kette faehrt, ruft `OnCreateArmyBrain` ->
--- `InitializeArmyAI` das selbst — eine KI-Armee bekam damit BEIDE Pfade, und
--- `CreateBrainShared` (aibrain.lua:406) lief zweimal: neuer TrashBag, der alte
--- verwaist, dazu `InitializeVO` fuer eine KI.
function __createBrain(army, planName)
  local mod = import('/lua/aibrain.lua')
  local b = mod.AIBrain()
  -- `planName` bleibt als Parameter erhalten, weil die kartenlose Harness-Seite
  -- ihn ueber `SetArmyPlans` weiterreicht; der Konstruktor selbst benutzt ihn
  -- nicht.
  __armyVar(army).plans = planName or ''
  b.__army = army
  -- Zu jedem Brain gehoert eine Personality, und der Konstruktor liest sie
  -- sofort ein: `CAiBrain::CAiBrain` legt sie an (Cfile:724303-724309) und ruft
  -- `CAiPersonality::ReadData` (Cfile:724385). `aibrain.lua:1373`
  -- (CalculateLayerPreference) und `:878` (der Plan-Thread) rufen sie in JEDEM
  -- KI-Spiel, lange bevor irgendetwas anderes passiert.
  b.__personality = import('/lua/aipersonality.lua').AIPersonality()
  b.__personality.__p = __readPersonalityData()
  b.Name = 'ARMY_' .. tostring(army)
  b.Nickname = b.Name
  __brains[army] = b
  -- Das Pool-Platoon entsteht MIT der Armee, nicht auf Zuruf: die
  -- Armee-Erzeugung macht `MakePlatoon(army, "Pool", "PoolAI")` und nennt es
  -- `"ArmyPool"` (Cfile:1017576-1017578). `aibrain.lua:1142` holt es im ersten
  -- Zug jeder KI-Armee.
  __makeArmyPool(army)
  -- This is what OnCreateArmyBrain does (siminit.lua:115-117).
  ArmyBrains[army] = b
  return b
end

-- A LOOKUP, never a creator. `__createBrain` is called once per DECLARED army
-- by setupSession (session.ts:86) — the engine's SimInit step 5a. Every retail
-- binding that takes an army index validates it against `mArmiesList` and
-- errors instead of inventing a player: `CreateUnit` at Cfile:980706-980713 and
-- the position/threat bindings at Cfile:980344-980352 both raise
-- "Invalid army index; must be >= 1 and < %d but got %d.".
--
-- Auto-vivifying here would hand out a brain with faction 1, name ARMY_<n> and
-- a fresh economy, register it in the global `ArmyBrains` that unit.lua:1429
-- walks on EVERY unit death, and look entirely valid — the exact "silently
-- behaves as a valid engine object" case the fail-loudly rule forbids.
function __getBrain(army)
  local b = __brains[army]
  if b then return b end
  local maxArmy = 0
  for _ in pairs(__brains) do maxArmy = maxArmy + 1 end
  -- The message is the engine's, off-by-one wording included.
  error(string.format('Invalid army index; must be >= 1 and < %d but got %s',
    maxArmy, tostring(army)), 2)
end

-- === Platoons (Moho::CPlatoon) ============================================
--
-- Ein Platoon ist ein CScriptObject: `CPlatoon::CPlatoon` laedt
-- `import('/lua/platoon.lua').Platoon` (func_LoadPlatoon, Cfile:1048422-1048435),
-- setzt `mName = a4` und `mPlan = a5` und ruft dann
-- `CScriptObject::Call_Str(this, "OnCreate", &this->mPlan)` (Cfile:1048347-1048349).
-- Aus der Lua heisst das: `brain:MakePlatoon(name, plan)` -> `OnCreate(plan)`,
-- und `platoon.lua:27-31` startet daraus den KI-Thread, wenn die Klasse eine
-- Methode dieses Namens hat.
--
-- Jede Armee hat von Anfang an EIN Platoon: die Armee-Erzeugung macht
-- `MakePlatoon(army, "Pool", "PoolAI")`, haengt ein `CSquad` mit
-- SQUADCLASS_Unassigned daran und setzt `mUniqueName = "ArmyPool"`
-- (Cfile:1017576-1017578). `aibrain.lua:1142` holt genau dieses Platoon.
__platoons = {}

local function platoonListe(army)
  local s = __platoons[army]
  if not s then
    s = { liste = {}, nachName = {} }
    __platoons[army] = s
  end
  return s
end

--- `CArmyImpl::MakePlatoon(name, plan)` (Cfile:1017576, Ctor Cfile:1048282-1048351).
function __makePlatoon(army, name, plan)
  local p = import('/lua/platoon.lua').Platoon()
  p.__army = army
  p.__platoonName = name or ''
  p.__plan = plan or ''
  p.__uniqueName = ''
  p.__platoonUnits = {}
  p.__disbanded = false
  local s = platoonListe(army)
  s.liste[#s.liste + 1] = p
  -- Der Ctor ruft OnCreate MIT dem Plan (Cfile:1048349).
  if p.OnCreate then p:OnCreate(p.__plan) end
  return p
end

--- Das Pool-Platoon der Armee. Es entsteht mit der Armee, nicht auf Zuruf —
--- deshalb legt `__createBrain` es an und nicht der erste Aufrufer.
function __makeArmyPool(army)
  local p = __makePlatoon(army, 'Pool', 'PoolAI')
  p.__uniqueName = 'ArmyPool'
  platoonListe(army).nachName['ArmyPool'] = p
  return p
end

--- `CArmyImpl::GetPlatoon(name)` — die Suche hinter
--- `GetPlatoonUniquelyNamed` (Cfile:738340-738365). Kein Treffer: `nil`
--- (cfunc_CAiBrainGetPlatoonUniquelyNamedL pusht dann `lua_pushnil`).
function __platoonNamed(army, name)
  return platoonListe(army).nachName[name]
end

function __platoonList(army)
  local out = {}
  for i, p in ipairs(platoonListe(army).liste) do out[i] = p end
  return out
end

--- `PlatoonExists` pusht `CPlatoonOpt != 0` — also ob das uebergebene
--- Lua-Objekt noch auf ein LEBENDES CPlatoon zeigt (Cfile: cfunc_CAiBrain
--- PlatoonExistsL). Ein aufgeloestes Platoon ist damit `false`, nicht ein
--- Fehler.
function __platoonExists(army, p)
  if type(p) ~= 'table' or p.__disbanded then return false end
  for _, q in ipairs(platoonListe(army).liste) do
    if q == p then return true end
  end
  return false
end

--- `DisbandPlatoon` (Cfile: cfunc_CAiBrainDisbandPlatoonL ->
--- `mArmy->DisbandPlatoon`). Die Einheiten wandern zurueck in den Pool: eine
--- Einheit gehoert immer zu genau einem Platoon, und der Pool ist das, in das
--- die Armee jede neue Einheit legt (Cfile:950549).
function __disbandPlatoon(army, p)
  if type(p) ~= 'table' then return end
  local s = platoonListe(army)
  local pool = s.nachName['ArmyPool']
  if pool and pool ~= p then
    for _, u in ipairs(p.__platoonUnits or {}) do
      if not u.__dead then
        pool.__platoonUnits[#pool.__platoonUnits + 1] = u
        u.__platoon = pool
      end
    end
  end
  p.__platoonUnits = {}
  p.__disbanded = true
  if p.__uniqueName ~= '' then s.nachName[p.__uniqueName] = nil end
  for i, q in ipairs(s.liste) do
    if q == p then table.remove(s.liste, i) break end
  end
end

--- `AssignUnitsToPlatoon(platoon, units, squad, formation)` (Cfile:
--- cfunc_CAiBrainAssignUnitsToPlatoonL): FUENF Argumente inklusive self, das
--- erste darf eine Zeichenkette sein — dann wird ueber `GetPlatoon` gesucht
--- (`aiutilities.lua:875` uebergibt `'ArmyPool'`). `units` muss eine Tabelle
--- sein, `squad` eine Zeichenkette (sonst TypeError "string").
function __assignUnitsToPlatoon(army, ziel, units, squad, formation)
  local p = ziel
  if type(ziel) == 'string' then p = __platoonNamed(army, ziel) end
  if type(p) ~= 'table' then
    error('AssignUnitsToPlatoon: kein Platoon fuer ' .. tostring(ziel), 2)
  end
  if type(units) ~= 'table' then error('AssignUnitsToPlatoon: table expected', 2) end
  if type(squad) ~= 'string' then error('AssignUnitsToPlatoon: string expected', 2) end
  for _, u in ipairs(units) do
    -- Eine Einheit gehoert zu genau einem Platoon: erst austragen, dann
    -- eintragen.
    local alt = u.__platoon
    if alt and alt.__platoonUnits then
      for i, q in ipairs(alt.__platoonUnits) do
        if q == u then table.remove(alt.__platoonUnits, i) break end
      end
    end
    p.__platoonUnits[#p.__platoonUnits + 1] = u
    u.__platoon = p
    u.__squad = squad
  end
  p.__formation = formation
  return p
end

--- Was `Sim::CreateUnit` tut, BEVOR `OnCreate` der Einheit laeuft: die frische
--- Einheit landet im Pool ihrer Armee (Cfile:950549, direkt vor
--- Cfile:950554 `RunScript("OnCreate")`).
function __addUnitToArmyPool(u)
  local pool = __platoonNamed(u.__army, 'ArmyPool')
  if not pool then return end
  pool.__platoonUnits[#pool.__platoonUnits + 1] = u
  u.__platoon = pool
  u.__squad = 'Unassigned'
end

--- `UniquelyNamePlatoon(name)` setzt `mUniqueName`; danach findet
--- `GetPlatoonUniquelyNamed` es (Cfile:1017578 macht genau das fuer den Pool).
function __namePlatoon(army, p, name)
  local s = platoonListe(army)
  if p.__uniqueName ~= '' then s.nachName[p.__uniqueName] = nil end
  p.__uniqueName = name
  s.nachName[name] = p
end
