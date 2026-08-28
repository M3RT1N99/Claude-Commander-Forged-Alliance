-- =====================================================================
-- moho — the engine's C++ base classes, as the original Lua sees them.
--
-- The real engine registers its C++ methods with CScrLuaInitForm (luadef_*)
-- and publishes the resulting metatables as moho.<x>_methods. The original
-- Lua derives from them: Unit = Class(moho.unit_methods), Weapon =
-- Class(moho.weapon_methods), AIBrain = Class(moho.aibrain_methods).
--
-- class.lua COPIES base fields into the derived class, so these must be real
-- fields on the base class — a metatable __index fallback would not be copied.
--
-- Method names are 1:1 from the decompiled Lua bindings
-- (luadef_C<Class><Method>.mMethodName). Methods without a body here are
-- deliberate no-ops: the engine subsystem behind them (bones, effects, target
-- acquisition) does not exist yet. Nothing here invents game behaviour —
-- everything with a body reads or writes real state.
--
-- Instance state lives in self.__* fields, which the TS side reads and writes.
-- =====================================================================

-- REGISTER der No-ops: Funktion -> Bindungsname.
--
-- Es gab hier EINE geteilte `noop`-Funktion, und die Bestandsaufnahme erkannte
-- No-ops an ihrer Identität. Das reichte zum Zählen, aber nicht für die einzige
-- Frage, die wirklich zählt: WELCHE der 147 stillen No-ops ruft das echte Spiel
-- überhaupt auf? Ohne diese Antwort ist jede Priorisierung geraten.
--
-- Jetzt bekommt jeder Name seine eigene Funktion, die sich beim ersten Aufruf
-- meldet — aber nur, wenn `__mohoNoopWarn` gesetzt ist. Der Schalter wird zur
-- LAUFZEIT geprüft, nicht beim Bauen der Tabelle, damit der Host ihn auch nach
-- `installEngine()` noch umlegen kann.
--
-- Im Normalbetrieb kostet das einen Tabellenzugriff pro Aufruf einer ohnehin
-- leeren Funktion. Die Bestandsaufnahme erkennt No-ops ab jetzt am Register,
-- nicht mehr an der Identität.
__mohoNoopNames = {}
__mohoNoopWarn = false
__mohoNoopCalled = {}

local function noopFor(name)
  local f = function()
    if __mohoNoopWarn and not __mohoNoopCalled[name] then
      __mohoNoopCalled[name] = true
      WARN('NO-OP aufgerufen: ' .. name)
    end
  end
  __mohoNoopNames[f] = name
  return f
end

-- Fill in a no-op for every listed name that has no explicit body.
--
-- `parent` matters: class.lua copies base fields into the derived class, so a
-- no-op placed on the derived class SHADOWS a real implementation on the base.
-- GetHealth appears in both the entity and the unit binding list — filling it
-- with a no-op on the unit silently made every unit report zero health. So a
-- name the parent already implements is never no-op'd here.
local function withNoops(names, methods, parent)
  for _, name in ipairs(names) do
    if methods[name] == nil and not (parent and parent[name]) then
      methods[name] = noopFor(name)
    end
  end
  return methods
end

-- ---------------------------------------------------------------------
-- entity_methods (CEntity) — 72 bindings
-- ---------------------------------------------------------------------
local ENTITY_NAMES = {
  'AddLocalImpulse', 'AddManualScroller', 'AddPingPongScroller', 'AddShooter',
  'AddThreadScroller', 'AddWorldImpulse', 'AdjustHealth', 'AttachBoneTo', 'AttachTo',
  'BeenDestroyed', 'CategoryContainsSim', 'CategoryContainsUser', 'CategoryCount',
  'CategoryCountAroundPosition', 'CategoryEmpty', 'CategoryFilterDownSim',
  'CategoryFilterDownUser', 'CategoryFilterOut', 'CreateProjectile',
  'CreateProjectileAtBone', 'CreatePropAtBone', 'Destroy', 'DetachAll', 'DetachFrom',
  'DisableIntel', 'EnableIntel', 'GetAIBrain', 'GetArmy', 'GetBlueprint',
  'GetBoneCount', 'GetBoneDirection', 'GetBoneName', 'GetCollisionExtents',
  'GetEntityId', 'GetFractionComplete', 'GetHeading', 'GetHealth', 'GetIntelRadius',
  'GetMaxHealth', 'GetOrientation', 'GetParent', 'GetPosition', 'GetPositionXYZ',
  'GetScale', 'HideBone', 'InitIntel', 'IsIntelEnabled', 'IsValidBone', 'Kill',
  'PlaySound', 'ReachedMaxShooters', 'RemoveScroller', 'RemoveShooter',
  'RequestRefreshUI', 'SetAmbientSound', 'SetBoneEnabled', 'SetCollisionShape',
  'SetDrawScale', 'SetHealth', 'SetIntelRadius', 'SetMaxHealth', 'SetMesh',
  'SetOrientation', 'SetParentOffset', 'SetPosition', 'SetScale', 'SetVizToAllies',
  'SetVizToEnemies', 'SetVizToFocusPlayer', 'SetVizToNeutrals', 'ShakeCamera',
  'ShowBone',
}

local entity = withNoops(ENTITY_NAMES, {
  GetBlueprint = function(self) return self.__bp end,
  GetEntityId = function(self) return self.__id end,
  GetArmy = function(self) return self.__army or 1 end,
  GetAIBrain = function(self) return self.__brain end,
  GetParent = function(self) return self.__parent end,

  -- Intel bindings (cfunc_Entity{Init,Set,Get}IntelRadiusL / IsIntelEnabledL,
  -- Cfile:933318-933807). We do NOT model the recon grids, but must honour the
  -- numeric/boolean CONTRACT the original scripts read: SetupIntel / buff.lua
  -- call InitIntel(army, type, radius) and enhancement threads compare
  -- GetIntelRadius(type) as a NUMBER (units/xrb3301) and gate OnIntelEnabled on
  -- IsIntelEnabled(type) as a BOOLEAN (unit.lua:1826). Before this both returned
  -- nil (no-op), crashing those comparisons. Keyed per intel-type string
  -- ('Radar','Omni','Vision','Cloak',…).
  --
  -- `InitIntel` legt den Typ AN — und das ist mehr als eine Formalie.
  -- `CIntel::InitIntel` (Cfile:1103700-1103913) erzeugt je nach Typ ein Gitter
  -- (Radar/Sonar/Vision/Omni) oder setzt fuer die reinen Schalter-Typen
  -- (Jammer, Cloak, RadarStealth, SonarStealth) ein „hat"-Byte
  -- (Cfile:1103907-1103908). Ein Typ, den `InitIntel` nie gesehen hat, existiert
  -- fuer die Engine nicht.
  --
  -- Deshalb tut `EnableIntel` auf so einem Typ NICHTS: `cfunc_EntityEnableIntelL`
  -- springt an Cfile:933447 ueber das Setzen hinweg, wenn das „hat"-Byte fehlt,
  -- und an Cfile:933452-933453 passiert dasselbe, wenn kein Gitter da ist.
  -- `IsIntelEnabled` liest genauso: erst „hat", dann „an"
  -- (Cfile:933356-933369). Vorher legte `EnableIntel` den Eintrag hier selbst
  -- an — man konnte also etwas einschalten, das es gar nicht gibt.
  InitIntel = function(self, army, itype, radius)
    self.__intel = self.__intel or {}
    local slot = self.__intel[itype] or {}
    slot.has = true
    if radius ~= nil then slot.radius = tonumber(radius) or 0 end
    slot.radius = slot.radius or 0
    self.__intel[itype] = slot
  end,
  SetIntelRadius = function(self, itype, radius)
    self.__intel = self.__intel or {}
    local slot = self.__intel[itype] or {}
    slot.radius = math.max(0, tonumber(radius) or 0)
    self.__intel[itype] = slot
  end,
  GetIntelRadius = function(self, itype)
    local slot = self.__intel and self.__intel[itype]
    return (slot and slot.radius) or 0
  end,
  EnableIntel = function(self, itype)
    -- Ohne `InitIntel` gibt es nichts einzuschalten (Cfile:933447/933452).
    local slot = self.__intel and self.__intel[itype]
    if slot and slot.has then slot.enabled = true end
  end,
  DisableIntel = function(self, itype)
    local slot = self.__intel and self.__intel[itype]
    if slot and slot.has then slot.enabled = false end
  end,
  IsIntelEnabled = function(self, itype)
    local slot = self.__intel and self.__intel[itype]
    return (slot and slot.has and slot.enabled) == true
  end,
  -- NICHT nachgebildet: die Engine WIRFT `"EnableIntel called before InitIntel"`,
  -- wenn die Entity ueberhaupt keinen Intel-Manager hat (Cfile:933353/933441) —
  -- auch aus `IsIntelEnabled` heraus, mit genau diesem Text. Ob jede Einheit
  -- einen Manager bekommt oder nur eine mit `Intel`-Abschnitt im Blueprint,
  -- steht nicht im Decompilat: der Zeiger wird woanders gesetzt. UNBEKANNT,
  -- deshalb hier kein Fehler, sondern `false` — eine erfundene Ausnahme waere
  -- schlimmer als eine fehlende.

  -- Lifecycle. Entity::Destroy (Cfile:916089) loescht NICHT sofort: es setzt
  -- mDestroyQueued und haengt die Entity in Sim::mDeletionQueue. Erst am Ende
  -- des Beats laeuft Entity::OnDestroy — und damit der Lua-Callback OnDestroy,
  -- der den TrashBag leert (unit.lua:1244). Wer sofort loescht, verliert ihn.
  Destroy = function(self)
    if self.__destroyQueued then return end
    self.__destroyQueued = true
    __queueDeletion(self)
  end,
  BeenDestroyed = function(self)
    return self.__destroyQueued == true or self.__destroyed == true
  end,

  -- Health. Die Engine klemmt nur — sie toetet niemanden bei 0 HP
  -- (Entity::AdjustHealth, Cfile:915978). Das tut Unit:DoTakeDamage in der Lua.
  GetHealth = function(self) return self.__health or 0 end,
  GetMaxHealth = function(self)
    if self.__maxHealth then return self.__maxHealth end
    return (self.__bp and self.__bp.Defense and self.__bp.Defense.MaxHealth) or 0
  end,
  SetMaxHealth = function(self, hp) self.__maxHealth = hp end,

  -- OnHealthChanged feuert NUR, wenn sich der auf 25%-Stufen QUANTISIERTE
  -- Anteil aendert (round(ratio*4)/4, Cfile:916030-916050). Genau deshalb
  -- kommentiert unit.lua:823 „Health values come in at fixed 25% intervals" —
  -- daran haengen die Schadensraucher (ManageDamageEffects).
  SetHealth = function(self, instigator, hp)
    local max = self:GetMaxHealth()
    local old = self.__health or 0
    local new = math.max(0, math.min(hp, max))
    self.__health = new
    if max > 0 and self.OnHealthChanged then
      -- Die Engine quantisiert mit FLOOR, nicht kaufmaennisch: `frndint` mit
      -- der Korrektur `if (x < round(x)) -1` (Cfile:916030-916037) ergibt fuer
      -- positive x genau floor(x). Mit +0.5 (round-half-up) feuerte
      -- OnHealthChanged an den 12.5/37.5/62.5/87.5%-Grenzen einen Tick zu frueh.
      local qOld = math.floor((old / max) * 4) / 4
      local qNew = math.floor((new / max) * 4) / 4
      if qOld ~= qNew then
        pcall(function() self:OnHealthChanged(qNew, qOld) end)
      end
    end
  end,
  AdjustHealth = function(self, instigator, delta)
    -- Entity::AdjustHealth (Cfile:915985-915988): a zero delta does nothing, and
    -- a DEAD entity is never healed (only delta <= 0 applies once mIsDead). (The
    -- NoDamage cheat SimVar, which would also block damage while active, is not
    -- modelled.)
    if delta == 0 then return end
    if self.__dead and delta > 0 then return end
    self:SetHealth(instigator, (self.__health or 0) + delta)
  end,
  GetFractionComplete = function(self) return self.__fraction or 1 end,

  -- Moho::Unit::Kill (Cfile:951962) — die Engine toetet, die Lua hat es
  -- angeordnet (unit.lua:809 aus DoTakeDamage).
  --
  --   1. schon tot -> raus
  --   2. Lua CheckCanBeKilled(self, instigator) darf es verhindern (Cfile:952042)
  --   3. Baustelle mit FractionComplete < 0.5 -> excessDamageRatio = 10.0
  --      (Cfile:952122-952126). In der Lua heisst 10.0: KEIN WRACK
  --      (unit.lua:1079: overkillRatio > 1 -> kein Wrack). Man kann sich das
  --      nicht ausdenken, und ohne diese Zeile hinterlaesst jede halbfertige
  --      Baustelle ein volles Wrack.
  --   4. Lua SetDead (Cfile:952128) -> mIsDead
  --   5. Lua OnKilled(instigator, type, overkillRatio) (Cfile:952177)
  Kill = function(self, instigator, damageType, excessDamageRatio)
    if self.__dead then return end
    if self.CheckCanBeKilled then
      local ok, res = pcall(function() return self:CheckCanBeKilled(instigator) end)
      if ok and res == false then return end
    end
    local overkill = excessDamageRatio or 0.0
    if self.__beingBuilt and (self.__fraction or 1) < 0.5 then overkill = 10.0 end

    self.__dead = true
    -- mIsDead stops the unit's economy from THIS beat on, not at OnDestroy:
    -- HandleResourceManagement gates consumption (Cfile:953945) and production
    -- (Cfile:953968) on IsDead, and the DeathThread runs for several beats
    -- (unit.lua:1200-1241). Without it a dead mex kept producing while burning.
    if self.__isUnit and self.__id and __econSetDead then
      __econSetDead(self.__army or 1, self.__id)
    end
    if self.SetDead then pcall(function() self:SetDead() end) end

    -- OnKilled ZUERST, KILLS DANACH — die Reihenfolge in cfunc_EntityKillL:
    -- erst `v4->Kill(...)` (feuert OnKilled intern, Cfile:936149), dann der
    -- KILLS-Zaehler auf dem Instigator (Cfile:936183). Das ist load-bearing:
    -- OnKilled -> instigator:OnKilledUnit -> CheckVeteranLevel liest
    -- `GetStat('KILLS',0).Value + 1` (unit.lua:3139) — das +1 gilt genau, WEIL
    -- die Engine diesen Kill noch nicht gezaehlt hat. Zaehlt man vorher, steigt
    -- die Unit einen Kill zu frueh auf.
    -- A dying STRUCTURE releases its neighbours FIRST: the engine runs
    -- OnNotAdjacentTo on both sides (Cfile:952148-952153) BEFORE OnKilled
    -- (Cfile:952177), so the adjacency buffs are torn down before the death
    -- callback sees them — defaultunits.lua:372 removes every Adjacency buff.
    if self.__isUnit and __notifyNotAdjacent then __notifyNotAdjacent(self.__id) end

    if self.OnKilled then
      local ok, err = pcall(function()
        self:OnKilled(instigator, damageType or '', overkill)
      end)
      if not ok then WARN('OnKilled: ' .. tostring(err)) end
    end

    -- Die Kill-Statistik zaehlt die ENGINE (Cfile:936180-936183) — unit.lua:3083
    -- verlaesst sich darauf („kills through the engine are already counted").
    -- The VICTIM must be a Unit or a Projectile (Cfile:936069
    -- `v4->IsUnit() || v4->IsProjectile()`) — killing a prop (tree/rock/wreck)
    -- credits no kill. Wreckage props are RECLAIMABLE, not BENIGN, so the BENIGN
    -- category never excluded them; the victim-type check does.
    if instigator and instigator.__isUnit and (self.__isUnit or self.__isProj)
      and not self.__beingBuilt
      and instigator.__army ~= self.__army
      and not EntityCategoryContains(categories.BENIGN, self) then
      local stat = instigator.__stats or {}
      stat.KILLS = (stat.KILLS or 0) + 1
      instigator.__stats = stat
    end
  end,
  -- SetCollisionShape(shape, cx, cy, cz, size…) (Cfile:934167). unit.lua:922
  -- schaltet damit bei der Todes-Animation die Kollision ab ('None').
  SetCollisionShape = function(self, shape, cx, cy, cz, sx, sy, sz)
    self.__collisionShape = { shape = shape, x = cx, y = cy, z = cz, sx = sx, sy = sy, sz = sz }
  end,

  -- Entity:PlaySound(params) (Entity.cpp) — a one-shot through the
  -- sim->user bridge (SAudioRequest EntitySound=0, effects-audio.md
  -- "Sound-Lua-API"). params is the Sound{} table from bp.Audio.
  PlaySound = function(self, params)
    if type(params) == 'table' and params.Bank and params.Cue then
      __audioRequest(0, params.Bank, params.Cue)
    end
  end,
  -- Entity:SetAmbientSound(params, …) (Cfile:932577-932591): ONE ambient
  -- slot per entity — setting replaces the running loop, nil stops it.
  SetAmbientSound = function(self, params)
    if self.__ambientHandle then
      __audioRequest(2, nil, nil, self.__ambientHandle)
      self.__ambientHandle = false
    end
    if type(params) == 'table' and params.Bank and params.Cue then
      local h = __audioNextLoopHandle
      __audioNextLoopHandle = h + 1
      self.__ambientHandle = h
      __audioRequest(1, params.Bank, params.Cue, h)
    end
  end,

  -- Entity:CreateProjectile(proj_bp, [ox,oy,oz], [dx,dy,dz]) (Cfile:930715).
  -- Startpose = Pose der Entity + Offset; Richtung fehlt -> aus dem Blueprint.
  -- Damage 0, Typ 'Normal' — ein so erzeugtes Projektil traegt keinen Schaden
  -- (die Waffe reicht ihn separat durch, PassDamageData).
  CreateProjectile = function(self, bpId, ox, oy, oz, dx, dy, dz)
    local p, q = __boneWorld(self, nil)
    local bp = __registered.Projectile[string.lower(tostring(bpId))]
    if not bp then error('CreateProjectile: Invalid blueprint ' .. tostring(bpId), 2) end
    local phys = bp.Physics
    if ox == nil then
      ox = (phys.PositionX or 0) + (Random() * 2 - 1) * (phys.PositionXRange or 0)
      oy = (phys.PositionY or 0) + (Random() * 2 - 1) * (phys.PositionYRange or 0)
      oz = (phys.PositionZ or 0) + (Random() * 2 - 1) * (phys.PositionZRange or 0)
    elseif type(ox) ~= 'number' or type(oy) ~= 'number' or type(oz) ~= 'number' then
      -- The native binder pads omitted arguments with nil, then requires all
      -- three offset components when the first component is present.
      error('CreateProjectile: offset components must be numbers', 2)
    end
    if dx == nil then
      dx = (phys.DirectionX or 0) + (Random() * 2 - 1) * (phys.DirectionXRange or 0)
      dy = (phys.DirectionY or 0) + (Random() * 2 - 1) * (phys.DirectionYRange or 0)
      dz = (phys.DirectionZ or 0) + (Random() * 2 - 1) * (phys.DirectionZRange or 0)
    elseif type(dx) ~= 'number' or type(dy) ~= 'number' or type(dz) ~= 'number' then
      -- Position and direction are independently optional, but a supplied
      -- direction must be a complete three-component vector (Cfile:930715).
      error('CreateProjectile: direction components must be numbers', 2)
    end
    p = { p[1] + ox, p[2] + oy, p[3] + oz }
    local len = math.sqrt(dx * dx + dy * dy + dz * dz)
    if len > 0 then
      q = __orientFromDir({ dx / len, dy / len, dz / len })
    end
    return __projCreate(self, bpId, p, q, nil, 0, 0, 'Normal', nil, true)
  end,

  -- Entity:CreateProjectileAtBone(projectile_blueprint, bone) (Cfile:930926).
  CreateProjectileAtBone = function(self, bpId, bone)
    local p, q = __boneWorld(self, bone)
    return __projCreate(self, bpId, p, q, nil, 0, 0, 'Normal', nil, true)
  end,

  -- Transform. __pos is {x, y, z}, __orient a quaternion.
  --
  -- Die Engine liefert einen VEKTOR, keinen nackten Array: die Original-Lua
  -- greift auf BEIDES zu — `pos[1]` (aeonweapons.lua:105) und `pos.x`
  -- (effectutilities.lua:274). Ohne die Felder stirbt jeder Bau-Effekt an
  -- "attempt to perform arithmetic on a nil value".
  -- "Entity:GetPosition([bone])" (Cfile:934579): MIT Knochen die Weltposition
  -- genau dieses Knochens — daher kommt der Startpunkt eines Schusses.
  GetPosition = function(self, bone)
    if bone ~= nil then
      local p = __boneWorld(self, bone)
      return Vector(p[1], p[2], p[3])
    end
    local p = self.__pos or { 0, 0, 0 }
    return Vector(p[1] or p.x or 0, p[2] or p.y or 0, p[3] or p.z or 0)
  end,
  GetPositionXYZ = function(self, bone)
    if bone ~= nil then
      local p = __boneWorld(self, bone)
      return p[1], p[2], p[3]
    end
    local p = self.__pos or { 0, 0, 0 }
    return p[1], p[2], p[3]
  end,

  -- "Entity:GetBoneDirection(nameOrIndex)" (cfunc_EntityGetBoneDirectionL,
  -- Cfile:931469-931505): die Engine holt die Weltquaternion des Knochens und
  -- dreht damit (0,0,1) — die Blickrichtung eines Knochens ist seine +Z-ACHSE.
  -- Rueckgabe: DREI Zahlen, kein Vektor.
  GetBoneDirection = function(self, bone)
    local _, q = __boneWorld(self, bone)
    local d = __quatForward(q)
    return d[1], d[2], d[3]
  end,
  SetPosition = function(self, pos) self.__pos = pos end,
  GetOrientation = function(self) return self.__orient or { 0, 0, 0, 1 } end,
  SetOrientation = function(self, o) self.__orient = o end,
  GetHeading = function(self) return self.__heading or 0 end,

  SetMesh = function(self, mesh) self.__meshBp = mesh end,
  -- Der Zeichen-Massstab (unit.lua:1111 gibt dem Wrack den UniformScale der
  -- Unit mit). Der Renderer liest ihn aus dem Prop-Snapshot.
  -- Entity:SetScale(s) ODER SetScale(x, y, z) — die Engine nimmt 2 oder 4
  -- Argumente und wirft sonst "Wrong number of arguments to Entity:SetScale,
  -- expected 2 or 4 but got %d" (Cfile:935305); bei einem Wert skaliert sie
  -- alle drei Achsen gleich (Cfile:935334-935337). Nur EIN Wert zu speichern
  -- verlor die Achsenmasse der Bau-Box: effectutilities.lua:100/109 skaliert
  -- sie mit dem Fussabdruck des Gebaeudes (x*1.05, y*0.2, z*1.05).
  SetScale = function(self, x, y, z)
    if y == nil and z == nil then
      self.__drawScale = x
      self.__scale = { x, x, x }
    else
      self.__drawScale = x
      self.__scale = { x, y, z }
    end
  end,
  GetScale = function(self)
    local s = self.__scale
    if s then return s[1], s[2], s[3] end
    local d = self.__drawScale or 1
    return d, d, d
  end,

  -- Das Skelett. Die Engine kennt es, weil sie das Modell der Unit auch in der
  -- SIM laedt (nicht nur im Renderer): Waffen-Tuerme, Bau-Knochen, Muendungen
  -- und Effekte haengen alle an Knochennamen. `Unit.lua:2751 ValidateBone` und
  -- `weapon.lua:67 SetupTurret` fragen genau danach — ohne Skelett kann keine
  -- Waffe aufgebaut werden.
  --
  -- Die Namen kommen aus der SCM-Datei (src/formats/scm.ts) und werden pro
  -- Blueprint gesetzt (__setBones).
  GetBoneCount = function(self)
    return table.getn(__skeletonOf(self).names)
  end,
  GetBoneName = function(self, i)
    return __skeletonOf(self).names[i + 1]
  end,
  IsValidBone = function(self, bone)
    if bone == nil then return false end
    return __boneIndex(self, bone) ~= nil
  end,
})

-- ---------------------------------------------------------------------
-- unit_methods (CUnit) — 105 bindings, inherits from entity
-- ---------------------------------------------------------------------
local UNIT_NAMES = {
  'AddBuildRestriction', 'AddCommandCap', 'AddToggleCap', 'AlterArmor',
  'CalculateWorldPositionFromRelative', 'ClearFocusEntity', 'GetArmorMult',
  'GetAttacker', 'GetBuildRate', 'GetConsumptionPerSecondEnergy',
  'GetConsumptionPerSecondMass', 'GetCurrentLayer', 'GetFireState', 'GetFocusUnit',
  'GetGuards', 'GetHealth', 'GetNavigator', 'GetNumBuildOrders',
  'GetProductionPerSecondEnergy', 'GetProductionPerSecondMass', 'GetResourceConsumed',
  'GetScriptBit', 'GetTargetEntity', 'GetUnitId', 'GetVelocity', 'GetWeapon',
  'GetWeaponCount', 'IsBeingBuilt', 'IsIdleState', 'IsMoving', 'IsPaused', 'IsStunned',
  'IsUnitState', 'IsValidTarget', 'KillManipulator', 'KillManipulators',
  'PlayUnitAmbientSound', 'PlayUnitSound', 'RemoveBuildRestriction',
  'RemoveCommandCap', 'RemoveToggleCap', 'RestoreBuildRestrictions',
  'RestoreCommandCaps', 'RestoreToggleCaps', 'RevertElevation', 'RevertRegenRate',
  'ScaleGetBuiltEmitter', 'SetAccMult', 'SetAutoMode', 'SetBlockCommandQueue',
  'SetBreakOffDistanceMult', 'SetBreakOffTriggerMult', 'SetBuildRate', 'SetBusy',
  'SetCanBeKilled', 'SetCanTakeDamage', 'SetCapturable', 'SetConsumptionActive',
  'SetConsumptionPerSecondEnergy', 'SetConsumptionPerSecondMass', 'SetCreator',
  'SetCustomName', 'SetDoNotTarget', 'SetElevation', 'SetFireState', 'SetFocusEntity',
  'SetImmobile', 'SetIsValidTarget', 'SetPaused', 'SetProductionActive',
  'SetProductionPerSecondEnergy', 'SetProductionPerSecondMass', 'SetReclaimable',
  'SetRegenRate', 'SetScriptBit', 'SetShieldRatio', 'SetSpeedMult',
  'SetStrategicUnderlay', 'SetStunned', 'SetTurnMult', 'SetUnSelectable',
  'SetUnitState', 'SetWorkProgress', 'StopSiloBuild', 'StopUnitAmbientSound',
  'TestCommandCaps', 'TestToggleCaps', 'ToggleFireState', 'ToggleScriptBit',
  'WeaponBeenDestroyed', 'WeaponCanFire', 'WeaponChangeDamage',
  'WeaponChangeDamageRadius', 'WeaponChangeDamageType', 'WeaponChangeFiringTolerance',
  'WeaponChangeMaxHeightDiff', 'WeaponChangeMaxRadius', 'WeaponChangeMinRadius',
  'WeaponChangeProjectileBlueprint', 'WeaponChangeRateOfFire', 'WeaponCreateProjectile',
  'WeaponGetBlueprint', 'WeaponGetCurrentTarget', 'WeaponGetCurrentTargetPos',
  'WeaponGetFireClockPct', 'WeaponGetFiringRandomness', 'WeaponGetProjectileBlueprint',
  'WeaponIsFireControl', 'WeaponPlaySound', 'WeaponSetEnabled',
  'WeaponSetFireControl', 'WeaponSetFireTargetLayerCaps', 'WeaponSetFiringRandomness',
  'WeaponSetTargetingPriorities', 'WeaponTransferTarget',
  'GetStat', 'SetStat',
}

-- Script-bit argument -> bit INDEX. The engine's cfunc_UnitSetScriptBitL
-- (Cfile:974905-974924) takes the RULEUTC_* string, runs it through SetLexical
-- to the flag value, then right-shifts to the index; the original Lua always
-- passes the string (unit.lua:3360, platoon.lua:447, url0101_script.lua:29).
-- Our own UI dispatch path already sends the numeric index, so accept both.
local SCRIPT_BIT_INDEX = {
  RULEUTC_ShieldToggle = 0,
  RULEUTC_WeaponToggle = 1,
  RULEUTC_JammingToggle = 2,
  RULEUTC_IntelToggle = 3,
  RULEUTC_ProductionToggle = 4,
  RULEUTC_StealthToggle = 5,
  RULEUTC_GenericToggle = 6,
  RULEUTC_SpecialToggle = 7,
  RULEUTC_CloakToggle = 8,
}
local function scriptBitIndex(bit)
  if type(bit) == 'number' then return math.floor(bit) end
  return SCRIPT_BIT_INDEX[bit] or 0
end

local unit = withNoops(UNIT_NAMES, {
  GetUnitId = function(self)
    return (self.__bp and self.__bp.BlueprintId) or self.__id
  end,

  -- Ruestung. Der Faktor kommt aus /lua/armordefinition.lua — der Datei, die
  -- die Engine selbst importiert (Cfile:708539). Kein erfundener Wert.
  GetArmorMult = function(self, damageType) return __armorMult(self, damageType) end,
  AlterArmor = function(self, damageType, mult)
    self.__armorOverride = self.__armorOverride or {}
    self.__armorOverride[string.lower(tostring(damageType))] = mult
  end,

  -- Unit:GetStat(name, default) -> Tabelle mit .Value (Cfile:978066).
  -- unit.lua:3139 (CheckVeteranLevel) liest GetStat('KILLS', 0).Value; die
  -- Engine zaehlt KILLS beim Toeten selbst hoch (Cfile:936068).
  GetStat = function(self, name, default)
    local v = (self.__stats or {})[name]
    if v == nil then v = default end
    return { Value = v }
  end,
  SetStat = function(self, name, value)
    self.__stats = self.__stats or {}
    self.__stats[name] = value
  end,

  -- FIRE-STATE. EFireState (Cfile:702842-702850): Mix = -1, ReturnFire = 0,
  -- HoldFire = 1, HoldGround = 2. Default der Unit: ReturnFire (Cfile:772277).
  -- „Return Fire" ist KEIN Mechanismus, sondern schlicht „kein HoldFire" — es
  -- gibt keinen OnDamage->Feuer-Pfad in der Engine.
  -- Wirkung: der Feuertakt feuert nicht bei HoldFire (Cfile:983935) und die
  -- Zielerfassung LOESCHT das Ziel (Cfile:793085-793097). Beides in weapons.lua.
  -- SOUND. Unit scripts use unit:PlayUnitSound('DeathExplosion') etc. —
  -- the name is the KEY in bp.Audio (effects-audio.md "Sound-Lua-API").
  -- NOTE: the ORIGINAL unit.lua overrides PlayUnitAmbientSound/
  -- StopUnitAmbientSound in the class (unit.lua:2778-2801: one helper
  -- Entity per sound key in self.AmbientSounds, tracked by the TrashBag)
  -- and drives our Entity:SetAmbientSound binding through it — these
  -- fallbacks only serve classes without the override.
  PlayUnitSound = function(self, name)
    local s = self.__bp and self.__bp.Audio and self.__bp.Audio[name]
    if s then self:PlaySound(s) end
    return true
  end,
  PlayUnitAmbientSound = function(self, name)
    local s = self.__bp and self.__bp.Audio and self.__bp.Audio[name]
    if s then self:SetAmbientSound(s) end
  end,
  StopUnitAmbientSound = function(self, name)
    self:SetAmbientSound(nil)
  end,

  -- GUARD. The task syncs from mUnit->mGuardedUnit every tick
  -- (Cfile:839316-839333); the AI Lua reads the chain through exactly
  -- these two (engineermanager.lua:58-66).
  GetGuardedUnit = function(self)
    local id = self.__guardedUnit
    local t = id and __units[id] or nil
    if t and not t.__dead and not t.__destroyQueued then return t end
    return nil
  end,
  GetGuards = function(self)
    local out = {}
    for unitId, g in pairs(__guardOrders or {}) do
      if g.target == self.__id then
        local u = __units[unitId]
        if u and not u.__dead then out[table.getn(out) + 1] = u end
      end
    end
    return out
  end,

  GetFireState = function(self) return self.__fireState or 0 end,
  SetFireState = function(self, state) self.__fireState = state end,
  ToggleFireState = function(self)
    -- 3-state cycle ReturnFire(0) -> HoldFire(1) -> HoldGround(2) -> ReturnFire,
    -- matching cfunc_UnitToggleFireStateL `(mFireState + 1) % 3` (Cfile:975053).
    self.__fireState = ((self.__fireState or 0) + 1) % 3
  end,

  -- SCRIPT-BITS (Unit::ToggleScriptBit, Cfile:951395-951437): 1 << bit auf
  -- mScriptbits, dann OnScriptBitSet/OnScriptBitClear(bit) in der Lua.
  -- Indizes (Cfile:656792-656811): 0 Shield, 1 Weapon, 2 Jamming, 3 Intel,
  -- 4 Production, 5 Stealth, 6 Generic, 7 Special, 8 Cloak.
  GetScriptBit = function(self, bit)
    local bits = self.__scriptBits or 0
    local n = scriptBitIndex(bit)
    return (math.floor(bits / (2 ^ n)) % 2) == 1
  end,
  SetScriptBit = function(self, bit, state)
    local n = scriptBitIndex(bit)
    local was = self:GetScriptBit(n)
    if was == (state == true) then return end
    self.__scriptBits = (self.__scriptBits or 0) + (state and (2 ^ n) or -(2 ^ n))
    local cb = state and self.OnScriptBitSet or self.OnScriptBitClear
    if cb then pcall(function() cb(self, n) end) end
  end,
  ToggleScriptBit = function(self, bit)
    self:SetScriptBit(bit, not self:GetScriptBit(bit))
  end,
  GetCurrentLayer = function(self) return self.__layer or 'Land' end,
  IsBeingBuilt = function(self) return self.__beingBuilt or false end,

  -- Der Sammelpunkt einer Fabrik. Ohne gesetzten Punkt ist es die Fabrik selbst
  -- — FactoryUnit.CalculateRollOffPoint (defaultunits.lua:578) sucht damit den
  -- naechstgelegenen RollOffPoint des Blueprints aus.
  -- Overcharge: die ACU haelt ihn an, solange er nicht geladen ist
  -- (cfunc_UnitSetOverchargePaused; uel0001_script.lua:35 setzt ihn beim
  -- Waffen-Aufbau).
  SetOverchargePaused = function(self, paused)
    self.__overchargePaused = paused == true
  end,
  IsOverchargePaused = function(self)
    return self.__overchargePaused == true
  end,

  GetRallyPoint = function(self)
    return self.__rally or self:GetPosition()
  end,
  SetRallyPoint = function(self, pos)
    self.__rally = pos
    return true
  end,
  -- EUnitState (Cfile:702962-703052) — answered from the REAL sim state,
  -- not a stub: the original AI/effect Lua branches on these
  -- (engineermanager.lua:58-66, terranunits.lua:130).
  IsUnitState = function(self, state)
    local id = self.__id
    if state == 'Guarding' then -- 4, guard ctor sets bit 0x10 (Cfile:836995)
      return (__guardOrders and __guardOrders[id]) ~= nil
    elseif state == 'Attacking' then -- 3, attack ctor sets bit 8 (Cfile:812568)
      return (__attackOrders and __attackOrders[id]) ~= nil
    elseif state == 'Moving' then
      return self.__goal ~= nil and self.__goal ~= false
    elseif state == 'Building' or state == 'Repairing' then
      -- 5 / 16: a running build task with the matching helper name
      for _, task in pairs(__buildTasks or {}) do
        if task.builder == id then
          local repairing = task.order == 'Repair'
          return (state == 'Repairing') == repairing
        end
      end
      return false
    elseif state == 'Reclaiming' then -- 28 (AddEnum, Cfile:702962ff)
      return (__reclaimTasks and __reclaimTasks[id]) ~= nil
    elseif state == 'Upgrading' then
      -- 6: the structure that is upgrading ITSELF — it is the builder of an
      -- 'Upgrade' task (aibrain.lua:2072, platoon.lua:301, cybranunits.lua:258).
      for _, task in pairs(__buildTasks or {}) do
        if task.builder == id and task.order == 'Upgrade' then return true end
      end
      return false
    elseif state == 'BeingUpgraded' then
      -- 37: the successor growing on top of it — the TARGET of an 'Upgrade'
      -- task. The drag box skips such a structure (Cfile:1290062), so the box
      -- keeps selecting the working original instead of the half-built site.
      for _, task in pairs(__buildTasks or {}) do
        if task.target == id and task.order == 'Upgrade' then return true end
      end
      return false
    elseif state == 'BeingBuilt' then -- 39
      return self.__beingBuilt == true
    elseif state == 'Busy' then
      return self.__busy == true
    elseif state == 'MakingAttackRun' then
      -- The current attack task has no aircraft attack-run controller yet.
      -- Keep the native state explicit instead of equating every generic
      -- Attack order with the much narrower UNITSTATE_MakingAttackRun.
      return self.__makingAttackRun == true
    elseif state == 'Immobile' then
      if self.__immobile ~= nil then return self.__immobile == true end
      local bp = self.__bp
      return ((bp and bp.Physics and bp.Physics.MotionType) or 'RULEUMT_None') == 'RULEUMT_None'
    end
    return false
  end,
  -- Runtime UNITSTATE_Immobile bit (cfunc_UnitSetImmobileL, Cfile:974091).
  -- Keep it tri-state: before the first explicit setter call, the blueprint's
  -- motion type supplies the construction-time state; afterwards Lua controls
  -- the bit exactly, including an explicit SetImmobile(false).
  SetImmobile = function(self, immobile)
    self.__immobile = immobile == true
  end,
  -- UnitAttributes multipliers. Their native setters write the supplied float
  -- directly (Cfile:977084-977233); motion.lua consumes the same three fields.
  SetSpeedMult = function(self, value) self.__speedMult = value end,
  SetAccMult = function(self, value) self.__accMult = value end,
  SetTurnMult = function(self, value) self.__turnMult = value end,
  -- Idle == the command queue is empty (cfunc_UnitIsIdleStateL, Cfile:973582-
  -- 973597: idle unless a non-empty command list exists). AI wait-loops invert
  -- on this (aibehaviors.lua:674, basemanagerplatoonthreads.lua:815), so a
  -- constant `true` made their while-bodies never run. Derive it from the same
  -- order/task state IsUnitState tracks: any active move goal, attack/guard/
  -- reclaim order, build task where we are the builder, or a pending factory
  -- queue counts as busy.
  IsIdleState = function(self)
    local id = self.__id
    if self.__goal ~= nil and self.__goal ~= false then return false end
    if __attackOrders and __attackOrders[id] then return false end
    if __guardOrders and __guardOrders[id] then return false end
    if __reclaimTasks and __reclaimTasks[id] then return false end
    for _, task in pairs(__buildTasks or {}) do
      if task.builder == id then return false end
    end
    local q = self.__buildQueue
    if q and table.getn(q) > 0 then return false end
    return true
  end,
  -- SetPaused/IsPaused (cfunc_SetPausedL "Pause builders in this list"): the
  -- unit's mIsPaused flag. A paused builder / paused factory halts production
  -- and resource demand (build.lua __buildCollect/__factoryTick). SetPaused is
  -- in UNIT_NAMES (the noop list), but withNoops skips names that already have a
  -- real method — as with IsPaused.
  IsPaused = function(self) return self.__paused == true end,
  SetPaused = function(self, paused)
    -- The engine dispatches OnPaused/OnUnpaused on a real transition (unit
    -- scripts toggle active consumption + the build-effect ambient loop off
    -- these). Fire only on a change, like SetConsumptionActive.
    local want = paused == true
    if self.__paused ~= want then
      self.__paused = want
      local cb = want and self.OnPaused or self.OnUnpaused
      if cb then pcall(function() cb(self) end) end
    end
  end,
  -- Unit::SetAutoMode stores the flag and ALWAYS dispatches the corresponding
  -- Lua callback (Cfile:951326-951337). Silo scripts use those callbacks to
  -- start/stop automatic missile production.
  SetAutoMode = function(self, enabled)
    local on = enabled == true
    self.__autoMode = on
    local callback
    if on then callback = self.OnAutoModeOn else callback = self.OnAutoModeOff end
    if callback then callback(self) end
  end,
  -- WorkProgress (mUnitVarDat.mWorkProgress, ctor Cfile:772278). The BUILD task
  -- writes it every tick (Cfile:815482/815496/815547, build.lua). ENHANCEMENT
  -- progress is ALSO engine-driven — UpdateWorkProgress's UNITSTATE_Enhancing
  -- branch (Cfile:815272-815314, mirroring lua/sim/tasks/enhancetask.lua:47-80)
  -- computes delta = (1/(WorkItemBuildTime/BuildRate)) * ResourceConsumed * 0.1.
  -- DOCUMENTED GAP: that enhancing driver is NOT implemented here, so an issued
  -- ACU enhancement never advances (there is no Lua 'EnhanceThread'; unit.lua:
  -- 3572-3616 is the TELEPORT thread). The UI shows this value
  -- (construction.lua:380 GetWorkProgress).
  SetWorkProgress = function(self, progress) self.__workProgress = progress or 0 end,
  GetWorkProgress = function(self) return self.__workProgress or 0 end,
  -- SetBusy / SetBlockCommandQueue (defaultunits.lua:529/639): a factory that
  -- has just finished a unit is BUSY until the unit has left the build pad, and
  -- its command queue is BLOCKED so the next order does not start on top of the
  -- one rolling off. build.lua __factoryTick honours both.
  IsBusy = function(self) return self.__busy == true end,
  SetBusy = function(self, busy) self.__busy = busy == true end,
  SetBlockCommandQueue = function(self, block) self.__blockCommandQueue = block == true end,
  IsCommandQueueBlocked = function(self) return self.__blockCommandQueue == true end,
  -- GetNumBuildOrders(category) — how many build orders of that category are
  -- pending. defaultunits.lua:473 switches the factory's blinking lights on it
  -- (`== 0` -> green): with the old no-op it returned nil, `nil == 0` was false,
  -- and every idle factory stayed yellow.
  GetNumBuildOrders = function(self, category)
    local n = 0
    for _, task in pairs(__buildTasks or {}) do
      if task.builder == self.__id then
        local t = __units[task.target]
        if t and (not category or EntityCategoryContains(category, t)) then n = n + 1 end
      end
    end
    for _, item in ipairs(self.__buildQueue or {}) do
      if not category or EntityCategoryContains(category, item.id) then n = n + (item.count or 1) end
    end
    return n
  end,
  -- Shield seam: the shield calls Owner:SetShieldRatio (shield.lua
  -- UpdateShieldRatio); the UI mirrors __shieldRatio (readRow -> GetShieldRatio).
  -- SetFocusEntity/ClearFocusEntity hold the shield as the unit's focus entity
  -- (Unit:CreateShield/DestroyShield, unit.lua:3275/3375). All three sit in
  -- UNIT_NAMES (the noop list) but withNoops skips names with a real method.
  -- Unit:RecoilImpulse(x, y, z) — defaultweapons.lua:221 kicks the hull back
  -- when a ship gun fires (bp.Weapon.ShipRock). The method was not defined at
  -- all, so that path threw "attempt to call a nil value" (units.lua:4-8
  -- deliberately disables the instance fallback). Record the impulse; the
  -- visible hull rock needs impulse physics, which the sim does not have —
  -- motion runs through the navigator (a separate, absent feature).
  RecoilImpulse = function(self, x, y, z) self.__recoilImpulse = { x or 0, y or 0, z or 0 } end,
  -- Silo ammo counts. unit.lua:1405 does `if self:GetNukeSiloAmmoCount() <= 0`,
  -- simutils.lua:69-70 and platoon.lua:358/408 read them too — undefined they
  -- threw "call a nil value" / "compare nil with number". The sim builds no silo
  -- missiles yet, so the count is 0 and Give*SiloAmmo records what it was given.
  GetTacticalSiloAmmoCount = function(self) return self.__tacticalSiloAmmo or 0 end,
  GetNukeSiloAmmoCount = function(self) return self.__nukeSiloAmmo or 0 end,
  GiveTacticalSiloAmmo = function(self, n)
    self.__tacticalSiloAmmo = (self.__tacticalSiloAmmo or 0) + (n or 0)
  end,
  GiveNukeSiloAmmo = function(self, n)
    self.__nukeSiloAmmo = (self.__nukeSiloAmmo or 0) + (n or 0)
  end,
  -- The projectile weapon state removes one stored missile after a successful
  -- shot (defaultweapons.lua:587-589). These bindings were absent, so silo
  -- weapons crashed at that exact point and never consumed their ammunition.
  RemoveTacticalSiloAmmo = function(self, n)
    self.__tacticalSiloAmmo = math.max(0, (self.__tacticalSiloAmmo or 0) - (n or 0))
  end,
  RemoveNukeSiloAmmo = function(self, n)
    self.__nukeSiloAmmo = math.max(0, (self.__nukeSiloAmmo or 0) - (n or 0))
  end,
  SetShieldRatio = function(self, ratio) self.__shieldRatio = ratio end,
  SetFocusEntity = function(self, e) self.__focusEntity = e end,
  ClearFocusEntity = function(self) self.__focusEntity = nil end,
  -- SetStunned stores trunc(time * 10), not a rounded duration. MotionTick
  -- decrements only positive values; a negative duration consequently remains
  -- stunned exactly as in the retail engine (Cfile:952786, 973650, 974184).
  SetStunned = function(self, seconds)
    if type(seconds) ~= 'number' then error('SetStunned(unit, time): time must be a number', 2) end
    local ticks = seconds * 10
    self.__stunTicks = ticks < 0 and math.ceil(ticks) or math.floor(ticks)
  end,
  IsStunned = function(self) return not self or (self.__stunTicks or 0) ~= 0 end,
  SetCapturable = function(self, value) self.__capturable = value == true end,
  IsCapturable = function(self)
    if self.__capturable == nil then return true end
    return self.__capturable == true
  end,

  -- Weapons: the engine builds one object per bp.Weapon entry (see units.lua).
  GetWeaponCount = function(self)
    return (self.__weapons and table.getn(self.__weapons)) or 0
  end,
  GetWeapon = function(self, i) return self.__weapons and self.__weapons[i] end,

  -- Economy: rates come from the blueprint, the active flags go to the army
  -- economy. Production and consumption are separate switches — mapping both
  -- to one flag once killed the production of every finished building,
  -- because OnStopBeingBuilt calls SetConsumptionActive(false).
  GetBuildRate = function(self)
    if self.__buildRate ~= nil then return self.__buildRate end
    return (self.__bp and self.__bp.Economy and self.__bp.Economy.BuildRate) or 0
  end,
  SetBuildRate = function(self, rate)
    self.__buildRate = math.max(0, rate)
  end,
  -- The per-second rates are MUTABLE at runtime (SetProductionPerSecond* /
  -- SetConsumptionPerSecond*, below): prefer the runtime value, fall back to the
  -- blueprint. The original Lua drives the dynamic economy through the setters.
  GetProductionPerSecondEnergy = function(self)
    return self.__prodE or (self.__bp and self.__bp.Economy and self.__bp.Economy.ProductionPerSecondEnergy) or 0
  end,
  GetProductionPerSecondMass = function(self)
    return self.__prodM or (self.__bp and self.__bp.Economy and self.__bp.Economy.ProductionPerSecondMass) or 0
  end,
  GetConsumptionPerSecondEnergy = function(self)
    return self.__consE or (self.__bp and self.__bp.Economy and self.__bp.Economy.MaintenanceConsumptionPerSecondEnergy) or 0
  end,
  GetConsumptionPerSecondMass = function(self)
    return self.__consM or (self.__bp and self.__bp.Economy and self.__bp.Economy.MaintenanceConsumptionPerSecondMass) or 0
  end,
  -- Runtime rate setters (were no-op stubs): store the value AND push the one
  -- changed field to the army economy (Cfile:976734-976735). This is how mass
  -- extractors scale, adjacency bonuses apply and upgrades throttle.
  SetProductionPerSecondMass = function(self, v)
    self.__prodM = v
    if __econUpdateRate and self.__id then __econUpdateRate(self.__army or 1, self.__id, 'prodM', v) end
  end,
  SetProductionPerSecondEnergy = function(self, v)
    self.__prodE = v
    if __econUpdateRate and self.__id then __econUpdateRate(self.__army or 1, self.__id, 'prodE', v) end
  end,
  SetConsumptionPerSecondMass = function(self, v)
    self.__consM = v
    if __econUpdateRate and self.__id then __econUpdateRate(self.__army or 1, self.__id, 'consM', v) end
  end,
  SetConsumptionPerSecondEnergy = function(self, v)
    self.__consE = v
    if __econUpdateRate and self.__id then __econUpdateRate(self.__army or 1, self.__id, 'consE', v) end
  end,
  SetProductionActive = function(self, active)
    __econSetProductionActive(self.__army or 1, self.__id, active)
    -- The engine dispatches the Lua callback on EVERY call, per the flag
    -- (cfunc_UnitSetProductionActiveL, Cfile:973924-973930).
    local cb = active and self.OnProductionActive or self.OnProductionInActive
    if cb then pcall(function() cb(self) end) end
  end,
  SetConsumptionActive = function(self, active)
    __econSetConsumptionActive(self.__army or 1, self.__id, active)
    -- The engine dispatches only on a CHANGE (Moho::Unit::SetConsumptionActive,
    -- Cfile:953877-953883) — mass fabricators re-drive their production off this.
    local want = active == true
    if self.__consumptionActive ~= want then
      self.__consumptionActive = want
      local cb = want and self.OnConsumptionActive or self.OnConsumptionInActive
      if cb then pcall(function() cb(self) end) end
    end
  end,
  -- The granted share of the requested resources this tick. The engine pushes
  -- mResourceConsumed (Cfile:976943); HandleResourceManagement resets it to 0
  -- every tick (Cfile:953937) and sets it to CEconRequest::LimitingRate only
  -- while the unit is alive AND consumption is active AND it has a request
  -- (Cfile:953945-953948). LimitingRate is 1.0 for an empty request and
  -- min(granted/requested) otherwise (Cfile:1107891-1107909).
  --
  -- This used to return a flat 1 ("assume full supply"), so shield regen, intel
  -- upkeep and upgrade throttling never noticed an energy stall.
  GetResourceConsumed = function(self)
    -- IsDead is the engine's own first condition (Cfile:953945).
    if self.__dead or self.__destroyQueued then return 0 end
    return __econResourceConsumed(self.__army or 1, self.__id)
  end,

  -- Motion.
  GetNavigator = function(self) return self.__navigator end,
  IsMoving = function(self)
    if self.__goal then return true end
    return false
  end,
  GetVelocity = function(self)
    local s = self.__speed or 0
    local h = self.__heading or 0
    return math.sin(h) * s, 0, math.cos(h) * s
  end,
}, entity)

-- ---------------------------------------------------------------------
-- weapon_methods (CWeapon) — the unit's Weapon* bindings without the prefix.
-- GetWeapon(i) returns a proxy over (unit, index); Weapon (weapon.lua:13)
-- derives from this.
-- ---------------------------------------------------------------------
local WEAPON_NAMES = {
  'BeenDestroyed', 'CanFire', 'ChangeDamage', 'ChangeDamageRadius', 'ChangeDamageType',
  'ChangeFiringTolerance', 'ChangeMaxHeightDiff', 'ChangeMaxRadius', 'ChangeMinRadius',
  'ChangeProjectileBlueprint', 'ChangeRateOfFire', 'CreateProjectile', 'GetBlueprint',
  'GetCurrentTarget', 'GetCurrentTargetPos', 'GetFireClockPct', 'GetFiringRandomness',
  'GetParent', 'GetProjectileBlueprint', 'IsFireControl', 'PlaySound',
  'ResetTarget', 'SetEnabled', 'SetFireControl', 'SetFireTargetLayerCaps',
  'SetFiringRandomness', 'SetTargetEntity', 'SetTargetGround',
  'SetTargetingPriorities', 'SetValidTargetsForCurrentLayer', 'SetWeaponPriorities',
  'TransferTarget', 'WeaponHasTarget',
}

local function weaponUnitState(u, state)
  if u and u.IsUnitState then return u:IsUnitState(state) end
  if state == 'Busy' then return u and u.__busy == true end
  if state == 'Immobile' then return u and u.__immobile == true end
  if state == 'MakingAttackRun' then return u and u.__makingAttackRun == true end
  return false
end

local function weaponMuzzleBone(w)
  if w.__bone ~= nil then return w.__bone end
  local aim = w.__aim
  return aim and aim.__muzzleBone or nil
end

local function weaponMCanFire(w)
  if w.__canFire ~= nil then return w.__canFire == true end
  -- Compatibility for weapons/aim controllers created before mCanFire became
  -- an explicit mirrored field.
  local aim = w.__aim
  return not aim or aim.__destroyed == true or aim.__onTarget == true
end

local function normalizeWeaponAngle(value)
  while value > math.pi do value = value - 2 * math.pi end
  while value < -math.pi do value = value + 2 * math.pi end
  return value
end

local function unitHasSiloSubsystem(u)
  if not u then return false end
  if u.__siloBuild ~= nil then return u.__siloBuild ~= false end
  for _, category in ipairs((u.__bp and u.__bp.Categories) or {}) do
    if category == 'SILO' then return true end
  end
  return false
end

-- UnitWeapon::CheckSilo (Cfile:984729-984746). CountedProjectile alone is
-- insufficient: the native gate only consults storage when the owning unit
-- actually has the SILO subsystem.
function __weaponCheckSilo(w)
  local bp = w.__bp or {}
  local u = w.__unit or w.unit
  if not bp.CountedProjectile or not unitHasSiloSubsystem(u) then return true end
  local count
  if bp.NukeWeapon then
    count = u.GetNukeSiloAmmoCount and u:GetNukeSiloAmmoCount() or u.__nukeSiloAmmo or 0
  else
    count = u.GetTacticalSiloAmmoCount and u:GetTacticalSiloAmmoCount()
      or u.__tacticalSiloAmmo or 0
  end
  return count ~= 0
end

-- TargetSolutionStatusGun (Cfile:985075-985115). Radius overrides are kept as
-- radii in this Lua mirror and squared here, including negative values. Only
-- a negative MaxHeightDiff means "use the blueprint value".
function __weaponTargetSolution(w, targetPos)
  local u = w.__unit or w.unit
  local unitPos = u and u.__pos
  if not unitPos or not targetPos then return false end
  local bp = w.__bp or {}
  local dx = (targetPos[1] or 0) - (unitPos[1] or 0)
  local dz = (targetPos[3] or 0) - (unitPos[3] or 0)
  local distSq = dx * dx + dz * dz

  local maxRadius = w.__maxRadius
  if maxRadius == nil then maxRadius = bp.MaxRadius or 0 end
  if distSq > maxRadius * maxRadius then return false end

  local minRadius = w.__minRadius
  if minRadius == nil then minRadius = bp.MinRadius or 0 end
  if minRadius * minRadius >= distSq then return false end

  local maxHeight = w.__maxHeightDiff
  if maxHeight == nil then
    maxHeight = math.huge
  elseif maxHeight < 0 then
    maxHeight = bp.MaxHeightDiff or math.huge
  end
  if math.abs((targetPos[2] or 0) - (unitPos[2] or 0)) > maxHeight then return false end

  local arc = bp.HeadingArcRange or 180
  if arc < 180 then
    local origin = unitPos
    local bone = weaponMuzzleBone(w)
    if bone ~= nil and (type(bone) ~= 'number' or bone >= 0) then
      origin = __boneWorld(u, bone)
    end
    local bearing = math.atan(
      (targetPos[1] or 0) - (origin[1] or 0),
      (targetPos[3] or 0) - (origin[3] or 0)
    )
    local center = (bp.HeadingArcCenter or 0) * 0.017453292
    local delta = normalizeWeaponAngle(bearing - (u.__heading or 0) - center)
    if math.abs(delta) > arc * 0.017453292 then return false end
  end
  return true
end

-- The retail bomb-drop solver, specialized to this sim's vertical gravity.
-- CalcBombDrop first computes the horizontal release point from current
-- velocity; UnitWeapon::CanFire then applies BombDropThreshold and the two
-- unnormalised forward-dot tests (Cfile:858984-859065, 984551-984621).
function __weaponBombDropCanFire(w)
  local u = w.__unit or w.unit
  local target = w.__target
  local rawTarget = target and target.__pos or w.__targetGround
  if not u or not u.__pos or not rawTarget then return false end

  local targetPos = { rawTarget[1] or 0, rawTarget[2] or 0, rawTarget[3] or 0 }
  local air = (u.__bp and u.__bp.Air) or {}
  local predict = air.PredictAheadForBombDrop or 0
  if predict > 0 and target and target.GetVelocity
    and target.__unitMotion and target.__physBody then
    -- PredictAheadBomb returns the unchanged position without both native
    -- subsystems. With them, it rotates the tick velocity by impulse.y * 0.1
    -- before integrating each whole/fractional prediction tick; Y is fixed.
    local tvx, _, tvz = target:GetVelocity()
    local impulse = target.__physBody.impulse or { 0, 0, 0 }
    local angle = (impulse[2] or 0) * 0.1
    local sinAngle, cosAngle = math.sin(angle), math.cos(angle)
    local ticks = predict * 10
    while ticks > 0 do
      local nextX = cosAngle * tvx + sinAngle * tvz
      local nextZ = -sinAngle * tvx + cosAngle * tvz
      tvx, tvz = nextX, nextZ
      local fraction = math.min(1, ticks)
      targetPos[1] = targetPos[1] + tvx * fraction
      targetPos[3] = targetPos[3] + tvz * fraction
      ticks = ticks - 1
    end
  end

  local vx, vy, vz
  if u.GetVelocity then
    vx, vy, vz = u:GetVelocity()
  else
    local speed, heading = u.__speed or 0, u.__heading or 0
    vx, vy, vz = math.sin(heading) * speed, 0, math.cos(heading) * speed
  end
  vx, vy, vz = vx * 10, vy * 10, vz * 10
  local gravity = __simGravity or 4.9
  local discriminant = vy * vy + 2 * gravity * ((u.__pos[2] or 0) - targetPos[2])
  if discriminant < 0 or gravity <= 0 then return false end
  local root = math.sqrt(discriminant)
  local projectedSpeed = math.abs(vy)
  local flightTime = (projectedSpeed - root) / gravity
  if flightTime < 0 then flightTime = (projectedSpeed + root) / gravity end
  if flightTime < 0 then return false end

  local dropX = targetPos[1] - vx * flightTime
  local dropZ = targetPos[3] - vz * flightTime
  local releaseDx = dropX - (u.__pos[1] or 0)
  local releaseDz = dropZ - (u.__pos[3] or 0)
  local distance = math.sqrt(releaseDx * releaseDx + releaseDz * releaseDz)
  local threshold = (w.__bp and w.__bp.BombDropThreshold) or 0
  if threshold >= distance * 2 then return false end
  if threshold < distance then return true end

  local heading = u.__heading or 0
  local forwardX, forwardZ = math.sin(heading), math.cos(heading)
  if releaseDx * forwardX + releaseDz * forwardZ > 0 then return false end
  local targetDx = targetPos[1] - (u.__pos[1] or 0)
  local targetDz = targetPos[3] - (u.__pos[3] or 0)
  return targetDx * forwardX + targetDz * forwardZ >= 0.866
end

-- The non-range part of UnitWeapon::CanFire (Cfile:984489-984621). It is
-- separate because CFireWeaponTask invokes this native method directly, while
-- the public Lua binding additionally checks silo storage and target solution.
function __weaponUnitCanFire(w)
  local u = w.__unit or w.unit
  if not u then return false end
  if (u.__stunTicks or 0) ~= 0 or weaponUnitState(u, 'Busy') then return false end

  local unitBp = u.__bp or {}
  local air = unitBp.Air or {}
  local layer = u.__layer or u.Layer or 'Land'
  if air.CanFly and layer ~= 'Air' then return false end
  if (unitBp.AI or {}).NeedUnpack and not weaponUnitState(u, 'Immobile') then
    return false
  end

  local bp = w.__bp or {}
  if bp.AboveWaterFireOnly or bp.BelowWaterFireOnly then
    local transform = u.__pos or { 0, 0, 0 }
    local bone = weaponMuzzleBone(w)
    if bone ~= nil and (type(bone) ~= 'number' or bone >= 0) then
      transform = __boneWorld(u, bone)
    end
    local above = (transform[2] or 0) > (__mapWaterLevel or -10000)
    if bp.AboveWaterFireOnly and not above then return false end
    if bp.BelowWaterFireOnly and above then return false end
  end

  local canFire = weaponMCanFire(w)
  if not air.Winged then return canFire end

  if bp.AutoInitiateAttackCommand then
    local vx, vy, vz
    if u.GetVelocity then
      vx, vy, vz = u:GetVelocity()
    else
      local speed, heading = u.__speed or 0, u.__heading or 0
      vx, vy, vz = math.sin(heading) * speed, 0, math.cos(heading) * speed
    end
    local velocityPerSecond = math.sqrt(vx * vx + vy * vy + vz * vz) * 10
    if velocityPerSecond < (u.__speedMult or 1) * (air.MaxAirspeed or 0) * 0.25 then
      return false
    end
  end

  if not bp.NeedToComputeBombDrop
    or (w.__target == nil and w.__targetGround == nil) then
    return canFire
  end
  if not weaponUnitState(u, 'MakingAttackRun') then return false end
  return __weaponBombDropCanFire(w) and canFire
end

local weapon = withNoops(WEAPON_NAMES, {
  -- The ONLY writer of mTargetPriorities
  -- (cfunc_UnitWeaponSetTargetingPrioritiesL, Cfile:988316-988366); the weapon
  -- ctor leaves the vector empty (Cfile:984183-984185). weapon.lua:364-385
  -- builds the table from bp.TargetPriorities through ParseEntityCategory, so
  -- the entries are exactly the category objects EntityCategoryContains takes.
  -- Until now this was a withNoops no-op, so every priority list was dropped
  -- and FindBestEnemy had nothing to rank by.
  SetTargetingPriorities = function(self, priTable)
    local list = {}
    for i, c in ipairs(priTable or {}) do list[i] = c end
    self.__targetPriorities = list
  end,
  GetBlueprint = function(self) return self.__bp end,
  GetParent = function(self) return self.__unit end,
  BeenDestroyed = function(self) return self.__destroyed == true end,
  -- The native binding is named WeaponHasTarget despite the C++ class already
  -- being UnitWeapon (func_UnitWeaponHasTarget_LuaFuncDef, Cfile:987316).
  -- CAiTarget::HasTarget is true for both entity and ground targets.
  WeaponHasTarget = function(self)
    local target = self.__target
    if target ~= nil then
      return target.__dead ~= true and target.__destroyed ~= true
    end
    return self.__targetGround ~= nil
  end,
  GetCurrentTarget = function(self) return self.__target end,
  SetEnabled = function(self, e)
    self.__enabled = e
    return self
  end,
  SetFireTargetLayerCaps = function(self, caps)
    if type(caps) ~= 'string' then
      error('UnitWeapon:SetFireTargetLayerCaps(mask) requires a layer mask string', 2)
    end
    self.__fireTargetLayerCaps = caps
  end,

  -- Weapon:CanFire() (Cfile:987703-987735): HasTarget && UnitWeapon::CanFire &&
  -- CheckSilo && Zielloesung verfuegbar. `mCanFire` selbst schreibt NUR der
  -- Aim-Manipulator (Cfile:862074-862092); ohne Turm bleibt es auf dem
  -- Ctor-Wert 1. Enabled und CannotAttackGround gehoeren ausdruecklich nicht
  -- zu dieser Lua-Bindung.
  CanFire = function(self)
    if not self:WeaponHasTarget() then return false end
    if not __weaponUnitCanFire(self) or not __weaponCheckSilo(self) then return false end
    local targetPos = self.__target and self.__target.__pos or self.__targetGround
    return __weaponTargetSolution(self, targetPos)
  end,

  -- Das Ziel setzen — die FLANKE loest die Callbacks aus (Cfile:985364/985494):
  -- OnGotTarget nur bei kein->ein Ziel, OnLostTarget nur bei ein->kein Ziel.
  -- Wer sie bei jedem Aufruf feuert, startet die Salven-FSM immer wieder neu.
  SetTargetEntity = function(self, target) __weaponSetTarget(self, target) end,
  SetTargetGround = function(self, pos) __weaponSetTarget(self, nil, __vec3(pos)) end,
  ResetTarget = function(self) __weaponSetTarget(self, nil, nil) end,

  -- GetCurrentTargetPos: die Weltposition dessen, worauf die Waffe zielt
  -- (Cfile:987621). defaultweapons.lua:114 rechnet damit die Detonationshoehe.
  GetCurrentTargetPos = function(self)
    if self.__target and self.__target.__pos then
      local p = self.__target.__pos
      return Vector(p[1], p[2], p[3])
    end
    if self.__targetGround then
      local p = self.__targetGround
      return Vector(p[1], p[2], p[3])
    end
    return nil
  end,

  -- GetFireClockPct = 1 - mFireClock / (10/RoF) (Cfile:988512-988531).
  GetFireClockPct = function(self)
    local bp = self.__bp or {}
    local rof = bp.RateOfFire or 1
    local full = math.floor(10 / rof)
    if full <= 0 then return 1 end
    return 1 - ((self.__fireClock or 0) / full)
  end,

  -- Runtime-Overrides: Radiuswerte werden nativ quadriert, daher wirkt auch
  -- ein negativer Radius als Betrag. Nur ein negatives MaxHeightDiff faellt
  -- auf den Blueprint-Wert zurueck (Cfile:985083-985097, 987912-987982).
  ChangeRateOfFire = function(self, rof) self.__rateOfFire = rof end,
  ChangeMaxRadius = function(self, r) self.__maxRadius = r end,
  ChangeMinRadius = function(self, r) self.__minRadius = r end,
  -- The vertical firing gate (weapons.lua reads __maxHeightDiff or the
  -- blueprint MaxHeightDiff); was a no-op stub before.
  ChangeMaxHeightDiff = function(self, v) self.__maxHeightDiff = v end,
  ChangeDamage = function(self, d) self.__damage = d end,
  ChangeDamageRadius = function(self, r) self.__damageRadius = r end,
  ChangeDamageType = function(self, t) self.__damageType = t end,
  ChangeProjectileBlueprint = function(self, bpId) self.__projectileId = bpId end,
  GetProjectileBlueprint = function(self)
    return self.__projectileId or (self.__bp and self.__bp.ProjectileId)
  end,

  -- UnitWeapon:CreateProjectile(muzzlebone) — DER SCHUSS (Cfile:985613-985800).
  --
  -- Ohne ProjectileId feuert die Engine kein Projektil, sondern macht einen
  -- DoInstaHit und liefert nil (Cfile:985658-985675) — CreateProjectileAtMuzzle
  -- prueft genau darauf.
  --
  -- MuzzleVelocity != 0 ueberschreibt den Betrag der Startgeschwindigkeit.
  -- Lebensdauer in TICKS: ProjectileLifetime * 10, sonst
  -- (MaxRadius / MuzzleVelocity) * ProjectileLifetimeUsesMultiplier * 10.
  CreateProjectile = function(self, bone)
    local bp = self.__bp or {}
    local u = self.__unit
    local projId = self:GetProjectileBlueprint()
    if not projId or projId == '' then
      -- DoInstaHit: der Treffer geschieht sofort, ohne Flugkoerper.
      __weaponInstaHit(self)
      return nil
    end

    local pos, quat = __boneWorld(u, bone)
    -- Zielrichtung: die Engine nimmt die Muendungsachse, mit
    -- UseFiringSolutionInsteadOfAimBone die Richtung zum Ziel (Cfile:985700ff).
    -- Unsere Tuerme drehen sich noch nicht (die AimManipulatoren sind Attrappen),
    -- deshalb zielen wir IMMER ueber die Zielloesung — sonst schoesse jede Waffe
    -- stur nach vorn.
    --
    -- Gezielt wird auf den KOERPER (CAiTarget::GetTargetPosGun — ein Zielpunkt
    -- AUF der Einheit), nicht auf die Fuesse: `__pos` ist die Bodenposition, und
    -- ein Schuss auf die Fuesse faellt mit der Gravitation VOR dem Ziel in den
    -- Boden — Wirkungstreffer gab es dann nur per Zufall.
    local tp = nil
    if self.__target then
      tp = __unitCollision(self.__target)
    elseif self.__targetGround then
      tp = self.__targetGround
    end

    local speed = nil
    if bp.MuzzleVelocity and bp.MuzzleVelocity ~= 0 then
      speed = bp.MuzzleVelocity
      -- GetMuzzleVelocity (Cfile:656416-656432 / 0x51F710): the shot speed is
      -- scaled DOWN at close range — when MuzzleVelocityReduceDistance > dist
      -- (muzzle to target-pos-gun), speed = MuzzleVelocity * sqrt(dist /
      -- MuzzleVelocityReduceDistance). CreateProjectile then rescales the oriented
      -- velocity by that value (Cfile:985766-985775). The reduced speed feeds BOTH
      -- the flight magnitude and the v0 the ballistic pitch below solves for, so
      -- the arc stays consistent with the actual flight speed. (MuzzleVelocityRandom
      -- is FRandGaussian-driven and needs the lockstep sim random stream —
      -- documented gap, not applied here.)
      local rd = bp.MuzzleVelocityReduceDistance
      if rd and rd > 0 and tp then
        local rdx, rdy, rdz = tp[1] - pos[1], tp[2] - pos[2], tp[3] - pos[3]
        local dist = math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz)
        if rd > dist then speed = speed * math.sqrt(dist / rd) end
      end
    end

    if tp then
      local dx, dy, dz = tp[1] - pos[1], tp[2] - pos[2], tp[3] - pos[3]
      local aimed = false

      -- BALLISTISCHE FEUERLOESUNG (Moho::AI_CalculateFiringPitch,
      -- Cfile:790870-790905). Ein Projektil mit Gravitation faellt auf dem Weg —
      -- die Engine hebt den Abschusswinkel genau so an, dass der Bogen auf dem
      -- Ziel landet (dafuer steht `BallisticArc = 'RULEUBA_LowArc'` im
      -- Blueprint). Woertlich aus der Decomp:
      --   dxz  = horizontale Distanz
      --   A    = -(dxz^2 * gravity.y) / (2 * v^2)        (gravity.y = -4.9)
      --   disc = dxz^2 - 4 * A * (dy + A)
      --   lowArc  = atan((dxz - sqrt(disc)) / (2A))
      --   highArc = atan((dxz + sqrt(disc)) / (2A))      (Artillerie)
      -- Ohne die Loesung fiel jeder flache Schuss VOR dem Ziel in den Boden.
      local projPhys = __registered.Projectile[string.lower(tostring(projId))]
      projPhys = projPhys and projPhys.Physics
      local useGravity = projPhys and projPhys.UseGravity ~= false
      local v0 = speed or (projPhys and projPhys.InitialSpeed) or 0

      if useGravity and v0 > 0 and bp.BallisticArc ~= 'RULEUBA_None' then
        local dxz = math.sqrt(dx * dx + dz * dz)
        if dxz > 0.001 then
          local A = (__simGravity * dxz * dxz) / (2 * v0 * v0)
          local disc = dxz * dxz - 4 * A * (dy + A)
          if disc >= 0 and A > 0 then
            local sq = math.sqrt(disc)
            local t = (bp.BallisticArc == 'RULEUBA_HighArc') and (dxz + sq) or (dxz - sq)
            local pitch = math.atan(t / (2 * A))
            local horiz = math.cos(pitch)
            quat = __orientFromDir({
              (dx / dxz) * horiz, math.sin(pitch), (dz / dxz) * horiz,
            })
            aimed = true
          end
        end
      end

      -- Ausser ballistischer Reichweite oder ohne Gravitation: direkt zielen.
      if not aimed then
        local len = math.sqrt(dx * dx + dy * dy + dz * dz)
        if len > 0 then
          quat = __orientFromDir({ dx / len, dy / len, dz / len })
        end
      end
    end

    local damage = self.__damage or bp.Damage or 0
    local radius = self.__damageRadius or bp.DamageRadius or 0
    local proj = __projCreate(
      u, projId, pos, quat, speed, damage, radius,
      self.__damageType or bp.DamageType or 'Normal', self.__target,
      bp.IgnoresAlly ~= false
    )
    -- Lebensdauer (Cfile:985775-985791): TWO INDEPENDENT overrides, not if/elseif.
    -- ProjectileLifetime sets the lifetime; then ProjectileLifetimeUsesMultiplier
    -- OVERRIDES it when > 0 (the second block runs after and wins, gated on the
    -- MULTIPLIER field — not MuzzleVelocity). If neither applies the projectile
    -- keeps its own Physics.Lifetime, so SetLifetime is only called when one did.
    if proj and not proj.__destroyQueued then
      local life = nil
      if bp.ProjectileLifetime and bp.ProjectileLifetime > 0 then
        life = bp.ProjectileLifetime
      end
      -- MaxRadius/MuzzleVelocity would divide by zero for a degenerate blueprint;
      -- weapons that set the multiplier always carry a nonzero MuzzleVelocity, so
      -- guarding it is a safe no-op that avoids a Lua inf.
      if bp.ProjectileLifetimeUsesMultiplier and bp.ProjectileLifetimeUsesMultiplier > 0
        and bp.MuzzleVelocity and bp.MuzzleVelocity ~= 0 then
        life = ((bp.MaxRadius or 0) / bp.MuzzleVelocity) * bp.ProjectileLifetimeUsesMultiplier
      end
      if life and life > 0 then proj:SetLifetime(life) end
    end
    return proj
  end,

  -- Weapon:PlaySound(cue) — die Waffe bittet um ihren Feuersound. Die Sim hat
  -- keine Audio-Ausgabe (die hat die UI-VM); gesammelt wird er trotzdem, damit
  -- die Tests sehen, DASS geschossen wurde.
  PlaySound = function(self, cue) __simSoundRequested(cue) end,
}, entity)

-- ---------------------------------------------------------------------
-- aibrain_methods (CAiBrain) — 66 bindings. The brain's LOGIC is not here:
-- AIBrain (aibrain.lua:342) derives from this class and brings its own
-- (ESRegisterUnitMassStorage, InitializeEconomyState, …). Only the C++ part
-- lives here, and its economy accessors read the real army economy.
-- ---------------------------------------------------------------------
local AIBRAIN_NAMES = {
  'AddArmyStat', 'AssignThreatAtPosition', 'AssignUnitsToPlatoon', 'BuildPlatoon',
  'BuildStructure', 'BuildUnit', 'CanBuildPlatoon', 'CanBuildStructureAt',
  'CheckBlockingTerrain', 'CreateResourceBuildingNearest', 'CreateUnitNearSpot',
  'DecideWhatToBuild', 'DisbandPlatoon', 'DisbandPlatoonUniquelyNamed',
  'FindClosestArmyWithBase', 'FindPlaceToBuild', 'FindUnit', 'FindUnitToUpgrade',
  'FindUpgradeBP', 'GetArmyIndex', 'GetArmyStat',
  'GetAttackVectors', 'GetAvailableFactories', 'GetBlueprintStat', 'GetCurrentEnemy',
  'GetCurrentUnits', 'GetEconomyIncome', 'GetEconomyRequested', 'GetEconomyStored',
  'GetEconomyStoredRatio', 'GetEconomyTrend', 'GetEconomyUsage', 'GetFactionIndex',
  'GetHighestThreatPosition', 'GetListOfUnits', 'GetMapWaterRatio', 'GetNoRushTicks',
  'GetNumPlatoonsTemplateNamed', 'GetNumPlatoonsWithAI', 'GetNumUnitsAroundPoint',
  'GetPersonality', 'GetPlatoonUniquelyNamed', 'GetPlatoonsList', 'GetThreatAtPosition',
  'GetThreatBetweenPositions', 'GetThreatsAroundPosition', 'GetUnitBlueprint',
  'GetUnitsAroundPoint', 'GiveResource', 'GiveStorage', 'IsAnyEngineerBuilding',
  'IsOpponentAIRunning', 'MakePlatoon', 'NumCurrentlyBuilding', 'PickBestAttackVector',
  'PlatoonExists', 'RemoveArmyStatsTrigger', 'SetArmyStat', 'SetArmyStatsTrigger',
  'SetCurrentEnemy', 'SetCurrentPlan', 'SetGreaterOf', 'SetResourceSharing',
  'SetUpAttackVectorsToArmy', 'TakeResource',
}

local aibrain = withNoops(AIBRAIN_NAMES, {
  GetArmyIndex = function(self) return self.__army or 1 end,
  -- `brain:GetArmyStartPos()` gibt ZWEI Zahlen zurueck, x und z
  -- (cfunc_CAiBrainGetArmyStartPosL, Cfile:735971-735976: zweimal
  -- `lua_pushnumber`, `return 2`). Die Quelle ist der 2D-Vektor, den
  -- `SetArmyStart` abgelegt hat (Cfile:1024524) — keine Hoehe.
  --
  -- Stand bis hierher in der stillen No-op-Liste: `scenarioutilities.lua:1030`
  -- und `CreateInitialArmyUnit` fragen danach, und beide bekamen nil.
  GetArmyStartPos = function(self)
    local v = __armyVar(self.__army or 1)
    if not v.start then
      error('GetArmyStartPos: Armee ' .. tostring(self.__army)
        .. ' hat keine Startposition (SetArmyStart/GenerateArmyStart fehlt)', 2)
    end
    return v.start[1], v.start[2]
  end,
  GetFactionIndex = function(self) return self.__faction or 1 end,

  GetEconomyStored = function(self, res) return __econStored(self.__army or 1, res) end,
  GetEconomyStoredRatio = function(self, res) return __econStoredRatio(self.__army or 1, res) end,
  GetEconomyIncome = function(self, res) return __econIncome(self.__army or 1, res) end,
  GetEconomyUsage = function(self, res) return __econUsage(self.__army or 1, res) end,
  GetEconomyRequested = function(self, res) return __econRequested(self.__army or 1, res) end,
  GetEconomyTrend = function(self, res) return __econTrend(self.__army or 1, res) end,
  GiveResource = function(self, res, amount) __econGive(self.__army or 1, res, amount) end,
  -- NOT a negative GiveResource. GiveResource accumulates into mResources (the
  -- income accumulator, Cfile:735044-735053) and returns nothing (Cfile:735054);
  -- TakeResource drains mTotals.mStored by min(requested, stored), writes back
  -- max(0, stored - taken) and RETURNS the amount taken
  -- (cfunc_CAiBrainTakeResourceL, Cfile:735173-735270; help string
  -- "taken = TakeResource(type,amount)", Cfile:735162).
  -- The return value is load-bearing: simutils.lua:152-155 pipes it straight
  -- into GiveResource on the receiving brain.
  TakeResource = function(self, res, amount) return __econTake(self.__army or 1, res, amount) end,

  GetListOfUnits = function(self, cat) return __armyUnits(self.__army or 1, cat) end,
  GetCurrentUnits = function(self, cat) return table.getn(__armyUnits(self.__army or 1, cat)) end,

  SetArmyStat = function(self, name, value)
    self.__stats = self.__stats or {}
    self.__stats[name] = { Value = value }
  end,
  GetArmyStat = function(self, name, default)
    local s = self.__stats and self.__stats[name]
    return s or { Value = default }
  end,

  -- Die BEDROHUNGSKARTE der Engine (ein Raster, das die KI liest). Unsere Sim
  -- fuehrt keines — GetThreatAtPosition liefert deshalb 0: „hier ist nichts
  -- eingetragen". Das ist keine erfundene Zahl, sondern der Zustand einer leeren
  -- Karte, und es ist eine ZAHL: defaultunits.lua:1223 rechnet ungeprueft
  -- `threat / 2` und riss ohne sie den ganzen Todes-Pfad mit (kein Wrack).
  GetThreatAtPosition = function(self, pos, rings, enemy, threatType) return 0 end,
  AssignThreatAtPosition = function(self, pos, threat, decay, threatType) end,
})

-- ---------------------------------------------------------------------
-- cursor_methods (CMauiCursor) — 5 bindings, UI VM only (scr_UserInits).
-- Cursor (cursor.lua:6) derives from this and calls _c_CreateCursor in __init.
-- The texture name is what the browser turns into a CSS cursor.
-- ---------------------------------------------------------------------
local CURSOR_NAMES = { 'Hide', 'ResetToDefault', 'SetDefaultTexture', 'SetNewTexture', 'Show' }

local cursor = withNoops(CURSOR_NAMES, {
  SetDefaultTexture = function(self, filename, hotspotX, hotspotY)
    self.__defaultTexture = { filename, hotspotX or 0, hotspotY or 0 }
  end,
  ResetToDefault = function(self)
    local d = self.__defaultTexture
    if d then self:SetNewTexture(d[1], d[2], d[3]) end
  end,
  SetNewTexture = function(self, filename, hotspotX, hotspotY)
    self.__texture = filename
    self.__hotspot = { hotspotX or 0, hotspotY or 0 }
    if __uiSetCursorTexture then __uiSetCursorTexture(filename, hotspotX or 0, hotspotY or 0) end
  end,
  Show = function(self) self.__hidden = false end,
  Hide = function(self) self.__hidden = true end,
})

-- ---------------------------------------------------------------------
-- control_methods (CMauiControl) — 25 bindings, UI VM only.
-- Control (control.lua:28) derives from this. The LazyVars (Left/Top/…) are
-- attached by InternalCreate* (see maui.lua), not by these methods.
-- ---------------------------------------------------------------------
local CONTROL_NAMES = {
  'AbandonKeyboardFocus', 'AcquireKeyboardFocus', 'ApplyFunction', 'ClearChildren',
  'Destroy', 'DisableHitTest', 'EnableHitTest', 'GetAlpha', 'GetCurrentFocusControl',
  'GetName', 'GetParent', 'GetRenderPass', 'GetRootFrame', 'Hide', 'HitTest',
  'IsHidden', 'IsHitTestDisabled', 'NeedsFrameUpdate', 'SetAlpha', 'SetHidden',
  'SetName', 'SetNeedsFrameUpdate', 'SetParent', 'SetRenderPass', 'Show',
}

local control = withNoops(CONTROL_NAMES, {
  GetParent = function(self) return self.__parent or nil end,
  SetParent = function(self, parent)
    local oldParent = self.__parent or false
    local newParent = parent or false
    if oldParent == newParent then return end

    -- CMauiControl::SetParent first unlinks the intrusive child-list node from
    -- its old parent, then inserts it once at the new parent (Cfile:1124016).
    -- Remove every stale occurrence so state produced by the old adapter is
    -- repaired when that control is reparented.
    if oldParent then
      local oldChildren = oldParent.__children or {}
      for i = table.getn(oldChildren), 1, -1 do
        if oldChildren[i] == self then table.remove(oldChildren, i) end
      end
    end

    self.__parent = newParent
    if newParent then
      newParent.__children = newParent.__children or {}
      for i = table.getn(newParent.__children), 1, -1 do
        if newParent.__children[i] == self then table.remove(newParent.__children, i) end
      end
      newParent.__children[table.getn(newParent.__children) + 1] = self
    end
    __mauiDirty = true
  end,
  ClearChildren = function(self)
    for _, c in ipairs(self.__children or {}) do c:Destroy() end
    self.__children = {}
    __mauiDirty = true
  end,
  Destroy = function(self)
    self:ClearChildren()
    if self.OnDestroy then self:OnDestroy() end
    __mauiControls[self.__id] = nil
    self.__destroyed = true
    __mauiDirty = true
  end,

  GetName = function(self) return self.__name end,
  SetName = function(self, name) self.__name = name end,

  Hide = function(self) self:SetHidden(true) end,
  Show = function(self) self:SetHidden(false) end,
  SetHidden = function(self, hidden)
    local value = hidden == true
    -- OnHide returning true vetoes both the state change and propagation.
    -- Otherwise the engine updates this control before recursively applying
    -- the same operation to every child (Cfile:1124397-1124417).
    if self.OnHide and self:OnHide(value) == true then return end
    self.__hidden = value
    for _, child in ipairs(self.__children or {}) do
      child:SetHidden(value)
    end
    __mauiDirty = true
  end,
  IsHidden = function(self) return self.__hidden == true end,

  SetAlpha = function(self, alpha, children)
    self.__alpha = alpha
    if children then
      for _, c in ipairs(self.__children or {}) do c:SetAlpha(alpha, true) end
    end
    __mauiDirty = true
  end,
  GetAlpha = function(self) return self.__alpha or 1 end,

  -- "Control:DisableHitTest([recursive])" / "Control:EnableHitTest([recursive])"
  -- (Cfile:1125051/1125109). Das OPTIONALE recursive-Flag ist kein Beiwerk:
  -- uiutil.lua:993 (`ret:DisableHitTest(true)`) macht damit die Deko-Klammern
  -- eines Dialogs mausdurchlaessig. Wer es ignoriert, laesst die Klammern
  -- weiterhin treffen — und weil sie mit den Knoepfen auf DERSELBEN Tiefe liegen
  -- und in der Baumreihenfolge davor stehen, gewinnt bei `mDepth > best`
  -- (Cfile:1124509, echt groesser) die Klammer. Der Tutorial-Dialog war so nicht
  -- mehr zu beantworten.
  DisableHitTest = function(self, recursive)
    self.__hitTest = false
    if recursive then
      for _, c in ipairs(self.__children or {}) do c:DisableHitTest(true) end
    end
  end,
  EnableHitTest = function(self, recursive)
    self.__hitTest = true
    if recursive then
      for _, c in ipairs(self.__children or {}) do c:EnableHitTest(true) end
    end
  end,
  IsHitTestDisabled = function(self) return self.__hitTest == false end,

  -- Tastatur-Fokus (Cfile:1125718/1125768/1125828). Hat ein Control den Fokus,
  -- bekommt NUR es die Tasten — und die Keymap schweigt (M3: IsKeyDown liefert
  -- dann false, Cfile:1141557). Genau deshalb loest ein Hotkey nicht aus,
  -- waehrend jemand im Chat tippt.
  -- MAUI_SetKeyboardFocus (Cfile:1141557-1141596) is the ONLY writer of
  -- Maui_CurrentFocusControl. Order and target both matter: the NEW focus is
  -- assigned first (Cfile:1141575), and only then is the OLD control notified
  -- through vtable offset 68 = slot 17 = OnKeyboardFocusChange
  -- (`mPrev[-1].mNext[8].mNext`, Cfile:1141582; vtable layout
  -- Cfile:396337-396366; the binding runs RunScript "OnKeyboardFocusChange",
  -- Cfile:1124573-1124578). Nothing is called on the control that GAINS focus,
  -- and there is no `old ~= self` guard — re-acquiring on the focused control
  -- notifies it (mapselect.lua:233/251/254 does exactly that).
  AcquireKeyboardFocus = function(self, exclusive)
    local old = __mauiFocus
    __mauiFocus = self
    self.__focusExclusive = exclusive == true
    if old and old.OnKeyboardFocusChange then old:OnKeyboardFocusChange() end
  end,
  AbandonKeyboardFocus = function(self)
    if __mauiFocus == self then
      __mauiFocus = false
      if self.OnLoseKeyboardFocus then self:OnLoseKeyboardFocus() end
    end
  end,
  GetCurrentFocusControl = function(self)
    return __mauiFocus or nil
  end,

  SetNeedsFrameUpdate = function(self, needs) self.__needsFrameUpdate = needs == true end,
  NeedsFrameUpdate = function(self) return self.__needsFrameUpdate == true end,
  SetRenderPass = function(self, pass) self.__renderPass = pass end,
  GetRenderPass = function(self) return self.__renderPass or 0 end,

  GetRootFrame = function(self)
    local c = self
    while c.__parent do c = c.__parent end
    return c
  end,
})

-- ---------------------------------------------------------------------
-- bitmap_methods (CMauiBitmap) — 18 bindings.
-- SetNewTexture fuellt BitmapWidth/BitmapHeight aus den Texturmassen
-- (Cfile:1118647) — darum bemisst sich ein Bitmap ohne Layout-Helfer nach
-- seiner DDS (bitmap.lua:69-70).
-- ---------------------------------------------------------------------
local BITMAP_NAMES = {
  'GetFrame', 'GetNumFrames', 'InternalSetSolidColor', 'Loop', 'Play',
  'SetBackwardPattern', 'SetForwardPattern', 'SetFrame', 'SetFramePattern',
  'SetFrameRate', 'SetLoopPingPongPattern', 'SetNewTexture', 'SetPingPongPattern',
  'SetTiled', 'SetUV', 'ShareTextures', 'Stop', 'UseAlphaHitTest',
}

local bitmap = withNoops(BITMAP_NAMES, {
  SetNewTexture = function(self, filename, border)
    self.__texture = filename
    self.__border = border or 1
    local w, h = GetTextureDimensions(filename)
    self.BitmapWidth:Set(w or 0)
    self.BitmapHeight:Set(h or 0)
    __mauiDirty = true
  end,
  InternalSetSolidColor = function(self, color)
    self.__solidColor = color
    __mauiDirty = true
  end,
  SetUV = function(self, u0, v0, u1, v1)
    self.__uv = { u0, v0, u1, v1 }
    __mauiDirty = true
  end,
  SetTiled = function(self, tiled) self.__tiled = tiled == true end,
  ShareTextures = function(self, other)
    if other and other.__texture then self:SetNewTexture(other.__texture, other.__border) end
  end,
  GetFrame = function(self) return self.__frame or 0 end,
  GetNumFrames = function(self) return 1 end,
}, control)

-- ---------------------------------------------------------------------
-- text_methods (CMauiText) — 9 bindings.
-- GetStringAdvance ist Pflicht: ohne Textbreite kann kein Layout rechnen
-- (Cfile:1146720). Die Breite kommt aus der Engine (Schriftmetrik).
-- ---------------------------------------------------------------------
local TEXT_NAMES = {
  'GetStringAdvance', 'GetText', 'SetCenteredHorizontally', 'SetCenteredVertically',
  'SetDropShadow', 'SetNewClipToWidth', 'SetNewColor', 'SetNewFont', 'SetText',
}

-- TextAdvance ist die Breite des gesetzten Textes (text.lua:47 macht daraus die
-- Breite des Controls). Sie haengt an Text UND Schrift — also nach jeder
-- Aenderung von beidem neu ziehen.
local function refreshTextAdvance(self)
  self.TextAdvance:Set(
    __mauiStringAdvance(self.__text or '', self.__fontFamily or '', self.__fontSize or 12)
  )
end

local text = withNoops(TEXT_NAMES, {
  SetText = function(self, str)
    -- tostring, weil die UI-Lua auch ZAHLEN durchreicht (economy.lua schreibt
    -- ihre Werte direkt in die Controls). Die Engine nimmt einen String entgegen;
    -- LuaPlus wandelt eine Zahl beim Uebergeben selbst um. Ohne diese Umwandlung
    -- bekommt die Schriftmetrik eine Zahl zu messen — und verschluckt sich.
    self.__text = str ~= nil and tostring(str) or ''
    refreshTextAdvance(self)
    __mauiDirty = true
  end,
  GetText = function(self) return self.__text or '' end,
  SetNewFont = function(self, family, pointSize)
    self.__fontFamily = family
    self.__fontSize = pointSize
    -- Die Engine fuellt FontAscent/FontDescent/FontExternalLeading aus der
    -- Schrift (Cfile:1145928-1145930); text.lua:39 macht daraus die Hoehe.
    local asc, desc = __mauiFontMetrics(family, pointSize)
    self.FontAscent:Set(asc)
    self.FontDescent:Set(desc)
    self.FontExternalLeading:Set(0)
    refreshTextAdvance(self)
    __mauiDirty = true
  end,
  SetNewColor = function(self, color)
    self.__color = color
    __mauiDirty = true
  end,
  SetCenteredHorizontally = function(self, on) self.__centerH = on == true end,
  SetCenteredVertically = function(self, on) self.__centerV = on == true end,
  GetStringAdvance = function(self, str)
    return __mauiStringAdvance(str or '', self.__fontFamily or '', self.__fontSize or 12)
  end,
}, control)

-- ---------------------------------------------------------------------
-- frame_methods (CMauiFrame) — 3 bindings.
-- ---------------------------------------------------------------------
local FRAME_NAMES = { 'GetTargetHead', 'GetTopmostDepth', 'SetTargetHead' }
local frame = withNoops(FRAME_NAMES, {
  -- "int GetTargetHead()" (Cfile:1136990) — der Bildschirm, auf dem dieser Frame
  -- liegt. Wir haben genau einen Head; __mauiCreateRootFrame haengt ihn als
  -- __head an. uiutil.lua:671 baut damit seine Dialog-Tiefe:
  --   GetFrame(parent:GetRootFrame():GetTargetHead()):GetTopmostDepth() + 1
  GetTargetHead = function(self) return self.__head or 0 end,
  SetTargetHead = function(self, head) self.__head = head end,

  -- "float GetTopmostDepth()" (Cfile:1136937) — die groesste Tiefe, die in
  -- diesem Frame vergeben ist. Ein Dialog legt sich damit UEBER alles, was schon
  -- da ist (uiutil.lua:671, +1). Ein fester Wert (hier stand 5000000) waere eine
  -- erfundene Zahl: zwei Dialoge saessen auf derselben Tiefe, und der zweite
  -- laege je nach Zeichenreihenfolge zufaellig hinten.
  GetTopmostDepth = function(self)
    local top = 0
    for _, c in pairs(__mauiControls) do
      if not c.__destroyed then
        local root = c
        while root.__parent do root = root.__parent end
        if root == self then
          local d = c.Depth()
          if d and d > top then top = d end
        end
      end
    end
    return top
  end,
}, control)

-- ---------------------------------------------------------------------
-- border_methods (CMauiBorder) — 2 Bindungen.
--
-- Ein Border ist der 9-Slice-Rahmen der Original-UI (Dialoge, Panels): vier
-- Kanten + vier Ecken, die Mitte bleibt frei.
--
--   SetNewTextures(vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)
--   SetSolidColor(color)
--
-- (mHelp woertlich, Cfile:1123156.) Die Methode setzt dabei die beiden LazyVars,
-- die die Engine dem Control mitgibt: BorderWidth aus der BREITE der
-- vertical-Textur, BorderHeight aus der HOEHE der horizontal-Textur
-- (Cfile:1122728/1122748 — SetValue(mBorderWidthLV, width) bzw.
-- SetValue(mBorderHeightLV, height)). border.lua:11-13 sagt es selbst:
-- "SetTextures will set the BorderWidth and BorderHeight lazy vars."
--
-- Jedes Argument darf nil sein: border.lua:28 ruft die Methode SECHSMAL, jedes
-- Mal mit genau einer gesetzten Textur (eine LazyVar je Kachel, OnDirty).
local BORDER_NAMES = { 'SetNewTextures', 'SetSolidColor' }
local border = withNoops(BORDER_NAMES, {
  SetNewTextures = function(self, vertical, horizontal, upperLeft, upperRight, lowerLeft, lowerRight)
    self.__border = self.__border or {}
    local b = self.__border
    if vertical then b.vertical = vertical end
    if horizontal then b.horizontal = horizontal end
    if upperLeft then b.upperLeft = upperLeft end
    if upperRight then b.upperRight = upperRight end
    if lowerLeft then b.lowerLeft = lowerLeft end
    if lowerRight then b.lowerRight = lowerRight end

    -- Die Masse kommen aus den TEXTUREN, nicht aus einer Zahl im Skript.
    if b.vertical then
      local w = GetTextureDimensions(b.vertical)
      if w then self.BorderWidth:Set(w) end
    end
    if b.horizontal then
      local _, h = GetTextureDimensions(b.horizontal)
      if h then self.BorderHeight:Set(h) end
    end
    __mauiDirty = true
  end,
  SetSolidColor = function(self, color)
    self.__border = self.__border or {}
    self.__border.solidColor = color
    __mauiDirty = true
  end,
}, control)

-- ---------------------------------------------------------------------
-- Publish. Unknown moho.<x> keys become empty classes on demand, so a script
-- deriving from a subsystem we have not built yet still loads (and then fails
-- loudly at the first real call, which is what we want).
-- ---------------------------------------------------------------------
moho = setmetatable({}, {
  __index = function(t, k)
    local c = Class() {}
    rawset(t, k, c)
    return c
  end,
})

-- ---------------------------------------------------------------------
-- projectile_methods (Moho::Projectile) — 30 Bindungen, nur Sim-VM
-- (docs/research/engine-api.md, Klasse `Projectile`).
--
-- Projectile.lua:16: `Projectile = Class(moho.projectile_methods, Entity)`.
--
-- JEDER Setter gibt `self` zurueck (Cfile:947725, `return 1` mit dem Lua-Objekt)
-- — die Original-Lua verkettet:
--   defaultweapons.lua:777  unit:CreateProjectile(id,0,0,0,nil,nil,nil):SetCollision(false)
-- Wer hier nichts zurueckgibt, laesst genau diese Zeile auf nil laufen.
--
-- Und SetTurnRate ist GRAD/Sekunde, nicht Radiant: die Engine schreibt direkt
-- mTurnRateDeg (Cfile:947724) und multipliziert im MotionTick mit
-- 0.0017453292 = pi/180 * 0.1. Der mHelp-Text („radians_per_second") ist falsch.
-- ---------------------------------------------------------------------
local PROJECTILE_NAMES = {
  'ChangeDetonateAboveHeight', 'ChangeDetonateBelowHeight', 'ChangeMaxZigZag',
  'ChangeZigZagFrequency', 'CreateChildProjectile', 'GetCurrentSpeed',
  'GetCurrentTargetPosition', 'GetLauncher', 'GetTrackingTarget', 'GetVelocity',
  'SetAcceleration', 'SetBallisticAcceleration', 'SetCollideEntity',
  'SetCollideSurface', 'SetCollision', 'SetDamage', 'SetDestroyOnWater',
  'SetLifetime', 'SetLocalAngularVelocity', 'SetMaxSpeed', 'SetNewTarget',
  'SetNewTargetGround', 'SetScaleVelocity', 'SetStayUpright', 'SetTurnRate',
  'SetVelocity', 'SetVelocityAlign', 'SetVelocityRandomUpVector',
  'StayUnderwater', 'TrackTarget',
}

local projectile = withNoops(PROJECTILE_NAMES, {
  GetLauncher = function(self) return self.__launcher end,
  GetTrackingTarget = function(self) return self.__target end,

  GetVelocity = function(self)
    local v = self.__vel or { 0, 0, 0 }
    return v[1], v[2], v[3]
  end,
  GetCurrentSpeed = function(self)
    local v = self.__vel or { 0, 0, 0 }
    return math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
  end,
  GetCurrentTargetPosition = function(self)
    if self.__target and self.__target.__pos then
      local p = self.__target.__pos
      return Vector(p[1], p[2], p[3])
    end
    if self.__targetGround then
      local p = self.__targetGround
      return Vector(p[1], p[2], p[3])
    end
    return nil
  end,

  -- SetVelocity(speed) ODER SetVelocity(vx, vy, vz) — beide Formen sind belegt
  -- (mHelp der Bindung). Mit einem Argument bleibt die RICHTUNG und nur der
  -- Betrag wird gesetzt.
  SetVelocity = function(self, x, y, z)
    local v = self.__vel or { 0, 0, 0 }
    if y == nil then
      local len = math.sqrt(v[1] * v[1] + v[2] * v[2] + v[3] * v[3])
      if len > 0 then
        self.__vel = { v[1] / len * x, v[2] / len * x, v[3] / len * x }
      else
        local f = __quatForward(self.__orient)
        self.__vel = { f[1] * x, f[2] * x, f[3] * x }
      end
    else
      self.__vel = { x, y, z }
    end
    return self
  end,
  SetMaxSpeed = function(self, s) self.__maxSpeed = s; return self end,
  SetAcceleration = function(self, a) self.__accel = a; return self end,
  SetBallisticAcceleration = function(self, ...)
    -- The binding accepts exactly three forms (Cfile:947551-947609):
    --   p:SetBallisticAcceleration()          restore global gravity
    --   p:SetBallisticAcceleration(y)         vertical acceleration
    --   p:SetBallisticAcceleration(x, y, z)   full vector
    local n = select('#', ...)
    if n == 0 then
      self.__ballistic = { 0, -(__simGravity or 4.9), 0 }
    elseif n == 1 then
      local y = ...
      self.__ballistic = { 0, y, 0 }
    elseif n == 3 then
      local x, y, z = ...
      self.__ballistic = { x, y, z }
    else
      error('Projectile:SetBallisticAcceleration expected 0, 1, or 3 arguments', 2)
    end
    return self
  end,
  SetTurnRate = function(self, degPerSec) self.__turnRate = degPerSec; return self end,
  SetLifetime = function(self, seconds)
    self.__lifetimeEnd = __gameTick + math.floor(seconds * 10)
    return self
  end,
  TrackTarget = function(self, on) self.__trackTarget = on ~= false; return self end,
  SetNewTarget = function(self, target) self.__target = target; return self end,
  SetNewTargetGround = function(self, pos) self.__targetGround = __vec3(pos); return self end,
  SetDamage = function(self, amount, radius)
    self.__damage = amount
    if radius then self.__damageRadius = radius end
    if self.DamageData then
      self.DamageData.DamageAmount = amount
      if radius then self.DamageData.DamageRadius = radius end
    end
    return self
  end,
  SetCollision = function(self, on)
    self.__collideEntity = on ~= false
    self.__collideSurface = on ~= false
    return self
  end,
  SetCollideEntity = function(self, on) self.__collideEntity = on ~= false; return self end,
  SetCollideSurface = function(self, on) self.__collideSurface = on ~= false; return self end,
  SetDestroyOnWater = function(self, on) self.__destroyOnWater = on ~= false; return self end,
  SetVelocityAlign = function(self, on) self.__velocityAlign = on ~= false; return self end,
  SetStayUpright = function(self, on) self.__stayUpright = on ~= false; return self end,
  StayUnderwater = function(self, on) self.__stayUnderwater = on ~= false; return self end,
  SetScaleVelocity = function(self, x, y, z)
    if y == nil then
      self.__scaleVel = { x, x, x }
    else
      self.__scaleVel = { x, y, z }
    end
    return self
  end,
  CreateChildProjectile = function(self, bpId)
    return __projCreate(self, bpId, self.__pos, self.__orient, nil,
      self.__damage or 0, self.__damageRadius or 0, self.__damageType or 'Normal', self.__target,
      true)
  end,
}, entity)

-- ---------------------------------------------------------------------
-- prop_methods (Moho::Prop) — GENAU EINE eigene Bindung: AddBoundedProp
-- (engine-api.md, Klasse `Prop`; Cfile:1015752). Alles andere erbt ein Prop von
-- Entity. Prop.lua:16: `Prop = Class(moho.prop_methods, Entity)`.
-- ---------------------------------------------------------------------
local prop = withNoops({ 'AddBoundedProp' }, {
  -- Begrenzt die Zahl der Wracks auf der Karte (Prioritaet = Masse). Unsere Sim
  -- kennt keine Obergrenze — hier passiert nichts, und das ist keine Luege:
  -- die Engine wirft nur bei Ueberlauf welche weg.
  AddBoundedProp = function(self, priority) self.__boundedPriority = priority end,
}, entity)

-- ---------------------------------------------------------------------
-- CollisionBeamEntity (Moho::CollisionBeamEntity) — die WAFFEN-DAUERSTRAHLEN.
--
-- DefaultBeamWeapon:OnCreate baut pro Muendung EINE CollisionBeam-Instanz
-- (defaultweapons.lua:802-816: BeamType{ Weapon, BeamBone=0, OtherBone=
-- muzzleBone, CollisionCheckInterval = BeamCollisionDelay*10 }) und
-- Enable()t sie beim Feuern statt ein Projektil zu erzeugen. Die Engine
-- castet dann pro CollisionCheckInterval einen Strahl (MotionTick zaehlt,
-- Cfile:911386-911416; CheckCollision) und ruft bei WECHSEL des Getroffenen
-- OnImpact(type, entity) — die Lua macht den Schaden (CollisionBeam.lua:186).
-- Bindungen: __init/SetBeamFx/Enable/Disable/IsEnabled/GetLauncher
-- (cfunc_CollisionBeamEntity*, Cfile:16648-16658), Rest erbt von Entity
-- (GetBoneCount = 2: Bone 0 = Anfang, Bone 1 = Treffpunkt).
-- Der Strahl-Tick selbst laeuft in weapons.lua (__beamTick).
-- ---------------------------------------------------------------------
__collisionBeams = {}

local collision_beam = withNoops({
  '__init', 'SetBeamFx', 'Enable', 'Disable', 'IsEnabled', 'GetLauncher',
}, {
  __init = function(self, spec)
    self.Weapon = spec.Weapon
    self.__muzzleBone = spec.OtherBone
    self.__interval = spec.CollisionCheckInterval or 10
    self.__intervalCount = 0
    self.__enabled = false
    self.__army = (spec.Weapon and spec.Weapon.unit and spec.Weapon.unit.__army) or 1
    -- Bone 0 = Muendung, Bone 1 = Treffpunkt (bis zum ersten Check identisch).
    self.__beamBones = { { 0, 0, 0 }, { 0, 0, 0 } }
    self.__beamOrient = { 1, 0, 0, 0 }
    __collisionBeams[#__collisionBeams + 1] = self
    -- Die Engine ruft OnCreate bei der Entity-Erzeugung — CollisionBeam.lua:40
    -- legt darin BeamEffectsBag/TerrainEffectsBag/Trash an; ohne den Aufruf
    -- stirbt CreateBeamEffects an der fehlenden Tabelle.
    if self.OnCreate then self:OnCreate() end
  end,
  Enable = function(self)
    if self.__enabled then return end
    self.__enabled = true
    if self.OnEnable then self:OnEnable() end
    -- EnableCollisionCheck primes the counter to the interval (Cfile:911198);
    -- MotionTick therefore checks on the very next tick, not after one period.
    self.__intervalCount = self.__interval
  end,
  Disable = function(self)
    if not self.__enabled then return end
    self.__enabled = false
    if self.OnDisable then self:OnDisable() end
  end,
  IsEnabled = function(self) return self.__enabled == true end,
  GetLauncher = function(self) return self.Weapon and self.Weapon.unit end,
  -- Der sichtbare Beam-Emitter haengt ohnehin an uns (AttachBeamToEntity,
  -- Bone 0 -> Bone 1) — hier nur merken.
  SetBeamFx = function(self, fx, collideOnStart)
    self.__fxBeam = fx
    -- The optional native argument defaults to TRUE (Cfile:911887-911900).
    local collide = collideOnStart
    if collide == nil then collide = true end
    self.__collideOnStart = collide == true
    if self.__collideOnStart and __beamCheckCollision then
      __beamCheckCollision(self)
    end
  end,
  GetBoneCount = function(self) return 2 end,
}, entity)

rawset(moho, 'entity_methods', Class() (entity))
-- MIT entity_methods als Basis — anders als projectile/prop: CollisionBeam.lua
-- mischt Entity NICHT selbst dazu (`Class(moho.CollisionBeamEntity)` pur,
-- CollisionBeam.lua:16); im Original erbt die C++-Klasse von Entity.
rawset(moho, 'CollisionBeamEntity', Class(moho.entity_methods) (collision_beam))
rawset(moho, 'unit_methods', Class(moho.entity_methods) (unit))
rawset(moho, 'weapon_methods', Class(moho.entity_methods) (weapon))
-- OHNE entity_methods als Basis — und das ist kein Versehen:
--   Projectile.lua:16  Projectile = Class(moho.projectile_methods, Entity)
--   Prop.lua:16        Prop       = Class(moho.prop_methods, Entity)
-- Die Original-Lua mischt die Entity-Methoden SELBST dazu (Entity aus
-- /lua/sim/Entity.lua ist bereits Class(moho.entity_methods)). Wuerden wir hier
-- ebenfalls von entity_methods erben, kaeme jedes Entity-Feld ueber ZWEI Wege in
-- die Klasse — und class.lua:147 bricht mit „field 'X' is ambiguous" ab.
rawset(moho, 'projectile_methods', Class() (projectile))
rawset(moho, 'prop_methods', Class() (prop))
rawset(moho, 'aibrain_methods', Class() (aibrain))
rawset(moho, 'cursor_methods', Class() (cursor))

-- maui (nur UI-VM). group_methods hat keine eigenen Bindungen — ein Group ist
-- ein CMauiControl mit der Klasse "group" (deshalb steht CMauiGroup auch nicht
-- in der Decomp-Liste). Die leere Klasse liefert das lazy-moho von selbst.
rawset(moho, 'control_methods', Class() (control))
-- ---------------------------------------------------------------------
-- item_list_methods (CMauiItemList) — 18 Bindungen.
--
-- Die Zeilenliste des Spiels: JEDES Dropdown ist eine (combo.lua:117), dazu
-- Kartenauswahl, Punkteliste, Chat, EULA. Die Engine haelt Zeilen, Auswahl und
-- Scroll-Position selbst — die mHelp-Strings (Cfile:1140151-1141154) sind hier
-- woertlich die Signatur:
--
--   itemlist = ItemList:AddItem('newitem')      item = ItemList:GetItem(index)
--   ItemList:ModifyItem(index, string)          ItemList:DeleteItem(index)
--   int ItemList:GetItemCount()                 bool ItemList:Empty()
--   index = ItemList:GetSelection()             ItemList:SetSelection(index)
--   float ItemList:GetRowHeight()               ItemList:ShowItem(index)
--   bool NeedsScrollBar()                       ItemList:ScrollToTop()
--   SetNewColors(fg, bg, selFg, selBg, mouseFg, mouseBg)
--   SetNewFont(family, pointsize)
--
-- Die Auswahl ist 0-BASIERT (combo.lua rechnet mit index+1 in Lua-Tabellen), und
-- "keine Auswahl" ist -1.
-- ---------------------------------------------------------------------
local ITEM_LIST_NAMES = {
  'AddItem', 'DeleteAllItems', 'DeleteItem', 'Empty', 'GetItem', 'GetItemCount',
  'GetRowHeight', 'GetSelection', 'GetStringAdvance', 'ModifyItem', 'NeedsScrollBar',
  'ScrollToTop', 'SetNewColors', 'SetNewFont', 'SetSelection', 'ShowItem',
  'ShowMouseoverItem', 'ShowSelection',
}
local item_list = withNoops(ITEM_LIST_NAMES, {
  AddItem = function(self, text)
    self.__items[table.getn(self.__items) + 1] = tostring(text)
    __mauiDirty = true
    return self
  end,
  ModifyItem = function(self, index, text)
    self.__items[index + 1] = tostring(text)
    __mauiDirty = true
    return self
  end,
  DeleteItem = function(self, index)
    table.remove(self.__items, index + 1)
    __mauiDirty = true
    return self
  end,
  DeleteAllItems = function(self)
    self.__items = {}
    self.__selection = -1
    self.__top = 0
    __mauiDirty = true
    return self
  end,
  GetItem = function(self, index) return self.__items[index + 1] end,
  GetItemCount = function(self) return table.getn(self.__items) end,
  Empty = function(self) return table.getn(self.__items) == 0 end,
  GetSelection = function(self) return self.__selection end,
  SetSelection = function(self, index)
    self.__selection = index
    __mauiDirty = true
  end,

  -- Die Zeilenhoehe kommt aus der SCHRIFT, nicht aus einer Konstanten: die
  -- Engine misst Ober- und Unterlaenge der gesetzten Schrift (dieselbe Metrik,
  -- die text.lua:39 benutzt). combo.lua rechnet daraus seine Hoehe.
  GetRowHeight = function(self)
    local a, d = __mauiFontMetrics(self.__fontFamily, self.__fontSize)
    return math.floor(a + d + 0.5)
  end,
  GetStringAdvance = function(self, str)
    return __mauiStringAdvance(str, self.__fontFamily, self.__fontSize)
  end,

  SetNewFont = function(self, family, pointsize)
    self.__fontFamily = family or ''
    self.__fontSize = pointsize or 12
    __mauiDirty = true
  end,
  SetNewColors = function(self, fg, bg, selFg, selBg, mouseFg, mouseBg)
    -- The six LazyVars call this binding one slot at a time. Nil means
    -- "leave unchanged", not "clear" (Cfile:1140253-1140347).
    local colors = self.__colors or {}
    if fg ~= nil then colors.fg = fg end
    if bg ~= nil then colors.bg = bg end
    if selFg ~= nil then colors.selFg = selFg end
    if selBg ~= nil then colors.selBg = selBg end
    if mouseFg ~= nil then colors.mouseFg = mouseFg end
    if mouseBg ~= nil then colors.mouseBg = mouseBg end
    self.__colors = colors
    __mauiDirty = true
    -- The binder leaves stack slot 1 in place and returns it.
    return self
  end,
  ShowSelection = function(self, on) self.__showSelection = on ~= false end,
  ShowMouseoverItem = function(self, on) self.__showMouseover = on ~= false end,

  -- "bool NeedsScrollBar() - returns true if a scrollbar is needed, else false":
  -- passen mehr Zeilen in die Liste, als sie hoch ist?
  NeedsScrollBar = function(self)
    local rows = math.floor(self.Height() / math.max(1, self:GetRowHeight()))
    return table.getn(self.__items) > rows
  end,
  ScrollToTop = function(self)
    self.__top = 0
    __mauiDirty = true
  end,
  ShowItem = function(self, index)
    -- Die Zeile ins Sichtfenster holen (Cfile: SetTopItem/ScrollToItem).
    local rows = math.max(1, math.floor(self.Height() / math.max(1, self:GetRowHeight())))
    if index < self.__top then
      self.__top = index
    elseif index >= self.__top + rows then
      self.__top = index - rows + 1
    end
    __mauiDirty = true
  end,

  -- ACHTUNG: das Scrollable-Protokoll (GetScrollValues/ScrollLines/ScrollPages/
  -- ScrollSetTop) gehoert hier NICHT hin. `control.lua:104-118` definiert es
  -- bereits, und `ItemList = Class(moho.item_list_methods, Control)` haette dann
  -- zwei Basisklassen mit demselben Feld — class.lua:147 sagt dazu woertlich
  -- "field 'ScrollPages' is ambiguous in class definition" und der Import von
  -- itemlist.lua bricht ab.
  --
  -- Das passt auch zur Engine: eine CMauiItemList scrollt in C++, nicht ueber
  -- Lua-Methoden. Der Scrollbar fragt sie direkt (__mauiScrollValues in maui.lua).
}, control)

-- ---------------------------------------------------------------------
-- edit_methods (CMauiEdit) — 31 Bindungen.
--
-- Das Textfeld: Chat, Umbenennen, Konsole, Lobby, Bau-Templates. Das Editieren
-- selbst laeuft in der Engine ueber MET_Char (CMauiEdit::HandleKeyEvent) — die
-- Lua sieht nur GetText/SetText und die Callbacks OnEnterPressed/OnEscPressed.
-- ---------------------------------------------------------------------
local EDIT_NAMES = {
  'AbandonFocus', 'AcquireFocus', 'ClearText', 'DisableInput', 'EnableInput',
  'GetBackgroundColor', 'GetCaretColor', 'GetCaretPosition', 'GetFontHeight',
  'GetForegroundColor', 'GetHighlightBackgroundColor', 'GetHighlightForegroundColor',
  'GetMaxChars', 'GetStringAdvance', 'GetText', 'IsBackgroundVisible', 'IsCaretVisible',
  'IsEnabled', 'SetCaretCycle', 'SetCaretPosition', 'SetDropShadow', 'SetMaxChars',
  'SetNewBackgroundColor', 'SetNewCaretColor', 'SetNewFont', 'SetNewForegroundColor',
  'SetNewHighlightBackgroundColor', 'SetNewHighlightForegroundColor', 'SetText',
  'ShowBackground', 'ShowCaret',
}
local edit = withNoops(EDIT_NAMES, {
  -- SetText truncates to MaxChars, caret -> end, fires OnTextChanged
  -- (0x78F380, Cfile:1131601-1131654) — __editSetText in maui.lua.
  SetText = function(self, text) __editSetText(self, tostring(text or '')) end,
  GetText = function(self) return self.__text end,
  -- ClearText clears text/caret/selection + OnTextChanged (Cfile:1131658).
  ClearText = function(self) __editClearText(self) end,
  -- SetMaxChars stores AND truncates existing text (0x78F570, Cfile:1131686).
  SetMaxChars = function(self, n)
    self.__maxChars = math.max(0, math.floor(tonumber(n) or 0))
    __editEnforceMaxChars(self)
  end,
  GetMaxChars = function(self) return self.__maxChars end,
  SetCaretPosition = function(self, p) self.__caret = p end,
  GetCaretPosition = function(self) return self.__caret end,
  -- EnableInput/DisableInput set mIsEnabled AND mCaretVisible together;
  -- disabling abandons the keyboard focus (sub_78F360, Cfile:1131585).
  EnableInput = function(self)
    self.__enabled = true
    self.__caretVisible = true
    __mauiDirty = true
  end,
  DisableInput = function(self)
    self.__enabled = false
    self.__caretVisible = false
    self:AbandonKeyboardFocus()
    __mauiDirty = true
  end,
  IsEnabled = function(self) return self.__enabled end,
  -- Background / caret / highlight / dropshadow state (CMauiEdit ctor
  -- defaults Cfile:1131436-1131500; the renderer reads all of it).
  ShowBackground = function(self, show)
    self.__showBackground = show == true
    __mauiDirty = true
  end,
  IsBackgroundVisible = function(self) return self.__showBackground == true end,
  ShowCaret = function(self, show)
    self.__caretVisible = show == true
    __mauiDirty = true
  end,
  IsCaretVisible = function(self) return self.__caretVisible == true end,
  SetNewCaretColor = function(self, c)
    self.__caretColor = c
    __mauiDirty = true
  end,
  GetCaretColor = function(self) return self.__caretColor end,
  SetCaretCycle = function(self, seconds, minAlpha, maxAlpha)
    self.__caretCycle = { seconds = seconds or 1.5, minAlpha = minAlpha or 62, maxAlpha = maxAlpha or 255 }
  end,
  SetNewHighlightForegroundColor = function(self, c)
    self.__hlColors.fg = c
    __mauiDirty = true
  end,
  GetHighlightForegroundColor = function(self) return self.__hlColors.fg end,
  SetNewHighlightBackgroundColor = function(self, c)
    self.__hlColors.bg = c
    __mauiDirty = true
  end,
  GetHighlightBackgroundColor = function(self) return self.__hlColors.bg end,
  SetDropShadow = function(self, show)
    self.__dropShadow = show == true
    __mauiDirty = true
  end,
  SetNewFont = function(self, family, pointsize)
    self.__fontFamily = family or ''
    self.__fontSize = pointsize or 12
    __mauiDirty = true
  end,
  GetFontHeight = function(self)
    local a, d = __mauiFontMetrics(self.__fontFamily, self.__fontSize)
    return math.floor(a + d + 0.5)
  end,
  GetStringAdvance = function(self, str)
    return __mauiStringAdvance(str, self.__fontFamily, self.__fontSize)
  end,
  SetNewForegroundColor = function(self, c) self.__colors.fg = c __mauiDirty = true end,
  SetNewBackgroundColor = function(self, c) self.__colors.bg = c __mauiDirty = true end,
  GetForegroundColor = function(self) return self.__colors.fg end,
  GetBackgroundColor = function(self) return self.__colors.bg end,
  -- AcquireFocus only takes effect on an ENABLED edit and shows the caret
  -- (sub_78F310, Cfile:1131557); abandoning hides it (Cfile:1131570-1131582).
  AcquireFocus = function(self)
    if not self.__enabled then return end
    self.__caretVisible = true
    self:AcquireKeyboardFocus(false)
    __mauiDirty = true
  end,
  AbandonFocus = function(self)
    self.__caretVisible = false
    self:AbandonKeyboardFocus()
    __mauiDirty = true
  end,
}, control)

-- ---------------------------------------------------------------------
-- scrollbar_methods (CMauiScrollbar) — 4 Bindungen (mHelp woertlich):
--
--   Scrollbar:SetScrollable(scrollable)
--   Scrollbar:SetTextures(background, thumbMiddle, thumbTop, thumbBottom)
--   DoScrollLines(float)   DoScrollPages(float)
--
-- Der Scrollbar rechnet nichts selbst: er ruft das Scrollable-Protokoll auf dem
-- Objekt, das er bekommen hat (Cfile:1124664/1124731/1124775).
-- ---------------------------------------------------------------------
local SCROLLBAR_NAMES = { 'DoScrollLines', 'DoScrollPages', 'SetNewTextures', 'SetScrollable' }
local scrollbar = withNoops(SCROLLBAR_NAMES, {
  SetScrollable = function(self, scrollable)
    self.__scrollable = scrollable or false
    __mauiDirty = true
  end,
  SetNewTextures = function(self, background, thumbMiddle, thumbTop, thumbBottom)
    -- scrollbar.lua's four LazyVars update one texture per call. The native
    -- binding preserves every slot whose argument is nil (Cfile:1144046).
    local textures = self.__textures or {}
    if background ~= nil then textures.background = background end
    if thumbMiddle ~= nil then textures.thumbMiddle = thumbMiddle end
    if thumbTop ~= nil then textures.thumbTop = thumbTop end
    if thumbBottom ~= nil then textures.thumbBottom = thumbBottom end
    self.__textures = textures
    __mauiDirty = true
    -- The binder leaves stack slot 1 in place and returns it.
    return self
  end,
  DoScrollLines = function(self, lines)
    __mauiScroll(self.__scrollable, self.__axis, 'lines', lines)
  end,
  DoScrollPages = function(self, pages)
    __mauiScroll(self.__scrollable, self.__axis, 'pages', pages)
  end,
}, control)

-- ---------------------------------------------------------------------
-- movie_methods (CMauiMovie) — 7 Bindungen (mHelp woertlich):
--
--   bool Movie:InternalSet(filename)
--   Play()   Stop()   Loop(bool)   IsLoaded()
--   number GetFrameRate() - returns the frame rate of the movie in FPS
--   int GetNumFrames() - returns the number of frames in the movie
--
-- Es gibt keinen SFD-Decoder — und dafuer hat die Engine einen dokumentierten
-- Weg: CMauiMovie::LoadFile gibt FALSE zurueck, wenn kein Film geladen werden
-- kann (Cfile:1143020-1143035; genau das passiert auch mit /nomovie auf der
-- Kommandozeile). movie.lua:32-53 faengt das ab und ruft OnStopped().
--
-- Damit laeuft der ECHTE Weg: splash.lua zieht durch zum Hauptmenue, und
-- main.lua baut sein Menue ohne Hintergrundfilm — beides ohne einen einzigen
-- Sonderfall im Code. Ein Film, der nie geladen wurde, hat 0 Bilder und 0 FPS;
-- das ist keine erfundene Zahl, sondern die Wahrheit ueber ein leeres Movie.
local MOVIE_NAMES = { 'GetFrameRate', 'GetNumFrames', 'InternalSet', 'IsLoaded', 'Loop', 'Play', 'Stop' }
local movie = withNoops(MOVIE_NAMES, {
  InternalSet = function(self, filename)
    self.__file = filename or false
    self.__playing = false
    return false
  end,
  IsLoaded = function(self) return false end,
  Play = function(self) self.__playing = true end,
  Stop = function(self) self.__playing = false end,
  Loop = function(self, loop) self.__loop = loop == true end,
  GetFrameRate = function(self) return 0 end,
  GetNumFrames = function(self) return 0 end,
}, control)

-- ---------------------------------------------------------------------
-- UIWorldView (CUIWorldView) — 17 Bindungen. Die Weltansicht ist ein CONTROL.
--
-- Das ist der Grund, warum sich im Original die Minimap verschieben laesst: sie
-- IST eine WorldView (minimap.lua:115), die in einem Fenster haengt.
--
-- Ihr __init liegt in C++ — mHelp woertlich (Cfile:1300209):
--   moho.UIWorldView:__init(parent_control, cameraName, depth, isMiniMap, trackCamera)
--
-- Die uebrigen Signaturen ebenso woertlich:
--   Reset()                         SetCartographic(bool)     bool IsCartographic()
--   LockInput(camera)               UnlockInput(camera)       IsInputLocked(camera)
--   EnableResourceRendering(bool)   bool IsResourceRenderingEnabled()
--   SetHighlightEnabled(bool)       bool HasHighlightCommand()
--   GetsGlobalCameraCommands(bool)  string GetRightMouseButtonOrder()
--   (vector2f|nil) = GetScreenPos(unit)
--   VECTOR2 Project(self, VECTOR3) - Weltpunkt -> Control-Koordinaten
--   ZoomScale(x, y, wheelRot, wheelDelta)
--
-- Gezeichnet wird die Welt von der 3D-Engine, nicht vom maui-Renderer: das
-- Control sagt nur, WO und WIE GROSS. Was hier Zustand ist, ist Zustand; was
-- Geometrie braucht (Project, GetScreenPos), liefert die 3D-Seite ueber
-- __uiWorldProject — ohne sie wird nicht geraten, sondern nil gemeldet.
-- ---------------------------------------------------------------------
local WORLDVIEW_NAMES = {
  '__init', 'CameraReset', 'EnableResourceRendering', 'GetRightMouseButtonOrder',
  'GetScreenPos', 'GetsGlobalCameraCommands', 'HasHighlightCommand', 'IsCartographic',
  'IsInputLocked', 'IsResourceRenderingEnabled', 'LockInput', 'Project', 'Reset',
  'SetCartographic', 'SetHighlightEnabled', 'UnlockInput', 'ZoomScale',
}
local worldview = withNoops(WORLDVIEW_NAMES, {
  __init = function(self, parent, cameraName, depth, isMiniMap, trackCamera)
    __uiCreateWorldView(self, parent, cameraName, depth, isMiniMap, trackCamera)
  end,

  SetCartographic = function(self, on)
    self.__cartographic = on == true
    __mauiDirty = true
  end,
  IsCartographic = function(self) return self.__cartographic == true end,

  EnableResourceRendering = function(self, on)
    self.__resourceIcons = on == true
    __mauiDirty = true
  end,
  IsResourceRenderingEnabled = function(self) return self.__resourceIcons == true end,

  LockInput = function(self) self.__inputLocked = true end,
  UnlockInput = function(self) self.__inputLocked = false end,
  IsInputLocked = function(self) return self.__inputLocked == true end,

  SetHighlightEnabled = function(self, on) self.__highlight = on == true end,
  HasHighlightCommand = function(self) return false end,

  GetsGlobalCameraCommands = function(self, on) self.__globalCameraCommands = on == true end,

  -- "string moho.UIWorldView:GetRightMouseButtonOrder()" — welcher Befehl haengt
  -- gerade an der rechten Maustaste. Die Entscheidung trifft die Engine aus der
  -- Auswahl; solange es sie nicht gibt, wird NICHTS behauptet.
  GetRightMouseButtonOrder = function(self) return nil end,

  -- Weltpunkt -> Control-Koordinaten. Das kann nur die 3D-Seite (Projektion der
  -- Kamera); sie haengt sich als __uiWorldProject ein.
  Project = function(self, pos)
    if not __uiWorldProject then return nil end
    return __uiWorldProject(self.__id, pos[1], pos[2], pos[3])
  end,
  GetScreenPos = function(self, unit)
    if not __uiWorldProject or not unit then return nil end
    local p = unit:GetPosition()
    return __uiWorldProject(self.__id, p[1], p[2], p[3])
  end,
}, control)

rawset(moho, 'bitmap_methods', Class(moho.control_methods) (bitmap))
rawset(moho, 'text_methods', Class(moho.control_methods) (text))
rawset(moho, 'frame_methods', Class(moho.control_methods) (frame))
rawset(moho, 'border_methods', Class(moho.control_methods) (border))
rawset(moho, 'item_list_methods', Class(moho.control_methods) (item_list))
rawset(moho, 'edit_methods', Class(moho.control_methods) (edit))
rawset(moho, 'scrollbar_methods', Class(moho.control_methods) (scrollbar))
-- ---------------------------------------------------------------------
-- camera_methods (CameraImpl) — 25 Bindungen, mHelp woertlich:
--
--   Camera:Reset()                       Camera:SnapTo(position, orientationHPR, zoom)
--   Camera:MoveTo(position, orientationHPR, zoom, seconds)
--   Camera:MoveToRegion(region[,seconds])
--   Camera:SetZoom(zoom, seconds)        Camera:GetZoom()
--   Camera:SetTargetZoom(zoom)           Camera:GetTargetZoom()
--   Camera:GetMinZoom()                  Camera:GetMaxZoom()
--   Camera:SetMaxZoomMult()              Camera:GetFocusPosition()
--   Camera:Spin(headingRate[,zoomRate])  Camera:HoldRotation()  Camera:RevertRotation()
--   Camera:TrackEntities(ents,zoom,seconds)  Camera:TargetEntities(ents,zoom,seconds)
--   Camera:NoseCam(ent,pitchAdjust,zoom,seconds,transition)
--   Camera:SaveSettings() / RestoreSettings(settings)
--   Camera:EnableEaseInOut() / DisableEaseInOut()  Camera:SetAccMode(accTypeName)
--   Camera:UseGameClock() / UseSystemClock()
--
-- Es gibt MEHRERE Kameras, ueber ihren Namen unterschieden ('WorldCamera',
-- 'MiniMap', 'CameraHead2') — worldview.lua:593 holt sie mit GetCamera(name).
--
-- Die Kamera SELBST ist die 3D-Seite (TypeScript). Hier steht nur der Zustand
-- und die Bruecke: __uiCameraCall(name, methode, …). Fehlt die Bruecke, wird
-- nichts behauptet.
-- ---------------------------------------------------------------------
local CAMERA_NAMES = {
  'DisableEaseInOut', 'EnableEaseInOut', 'GetFocusPosition', 'GetMaxZoom', 'GetMinZoom',
  'GetTargetZoom', 'GetZoom', 'HoldRotation', 'MoveTo', 'MoveToRegion', 'NoseCam',
  'Reset', 'RestoreSettings', 'RevertRotation', 'SaveSettings', 'SetAccMode',
  'SetMaxZoomMult', 'SetTargetZoom', 'SetZoom', 'SnapTo', 'Spin', 'TargetEntities',
  'TrackEntities', 'UseGameClock', 'UseSystemClock',
}
local camera = withNoops(CAMERA_NAMES, {
  GetZoom = function(self) return __uiCameraGet(self.__name, 'zoom') end,
  GetTargetZoom = function(self) return __uiCameraGet(self.__name, 'targetZoom') end,
  GetMinZoom = function(self) return __uiCameraGet(self.__name, 'minZoom') end,
  GetMaxZoom = function(self) return __uiCameraGet(self.__name, 'maxZoom') end,
  GetFocusPosition = function(self) return __uiCameraGet(self.__name, 'focus') end,
  SetZoom = function(self, zoom, seconds) __uiCameraSet(self.__name, 'zoom', zoom, seconds) end,
  SetTargetZoom = function(self, zoom) __uiCameraSet(self.__name, 'targetZoom', zoom) end,
  SetMaxZoomMult = function(self, mult) __uiCameraSet(self.__name, 'maxZoomMult', mult) end,
  Reset = function(self) __uiCameraSet(self.__name, 'reset', true) end,
  SnapTo = function(self, pos, hpr, zoom) __uiCameraMove(self.__name, pos, hpr, zoom, 0) end,
  MoveTo = function(self, pos, hpr, zoom, seconds)
    __uiCameraMove(self.__name, pos, hpr, zoom, seconds or 0)
  end,
})
rawset(moho, 'camera_methods', Class() (camera))

rawset(moho, 'movie_methods', Class(moho.control_methods) (movie))
rawset(moho, 'UIWorldView', Class(moho.control_methods) (worldview))


-- CMauiLuaDragger: KEIN Control (kein Layout, kein Parent) — die Engine haelt
-- ihn separat und ruft OnMove/OnRelease/OnCancel (Cfile:1130393-1130413).
-- dragger.lua:15 raeumt ihn selbst weg: `OnRelease -> self:Destroy()`.
rawset(moho, 'dragger_methods', Class() ({
  Destroy = function(self)
    __mauiDraggerDestroy(self)
    self.__destroyed = true
  end,
}))
