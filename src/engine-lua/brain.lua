-- Die ARMEE-GEHIRNE. Die Engine erzeugt sie (SimInit-Schritt 5a) und meldet
-- jedes an die Lua: `OnCreateArmyBrain(index, brain, name, nickname)`
-- (siminit.lua:113-125). Dort landet es in der globalen Liste `ArmyBrains`, die
-- SetupSession angelegt hat (siminit.lua:57).
--
-- Diese Liste ist kein Beiwerk: unit.lua:1429 (OnKilledVO) iteriert sie beim TOD
-- jeder Einheit — `for num, aiBrain in ArmyBrains do`. Ohne sie stirbt der
-- Todes-Pfad mitten in OnKilled, der DeathThread laeuft nie an und es gibt kein
-- Wrack. (Genau so gefunden.)
--
-- Wir koennen SimInit.lua noch nicht vollstaendig fahren: sein SetupSession()
-- laedt die Karten-Dateien (`ScenarioInfo.save`/`.script`, siminit.lua:91-98),
-- und der echte Session-Start kommt erst mit M10. Bis dahin legt die
-- Engine-Seite `ArmyBrains` genau so an, wie OnCreateArmyBrain es tun wuerde —
-- Name und Nickname inklusive.
__brains = __brains or {}

-- Strenger _G (config.lua:51-56): der LESEZUGRIFF auf ein nicht existierendes
-- Global wirft. Deshalb rawget/rawset statt `ArmyBrains = ArmyBrains or {}`.
if rawget(_G, 'ArmyBrains') == nil then rawset(_G, 'ArmyBrains', {}) end

function __createBrain(army, planName)
  local mod = import('/lua/aibrain.lua')
  local b = mod.AIBrain()
  b.__army = army
  b.Name = 'ARMY_' .. tostring(army)
  b.Nickname = b.Name
  b:OnCreateHuman(planName or '')
  __brains[army] = b
  -- Das tut OnCreateArmyBrain (siminit.lua:115-117).
  ArmyBrains[army] = b
  return b
end

function __getBrain(army)
  return __brains[army] or __createBrain(army)
end
