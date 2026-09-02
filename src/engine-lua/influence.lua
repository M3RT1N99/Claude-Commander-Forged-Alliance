-- === Die Bedrohungskarte (Moho::CInfluenceMap) ============================
--
-- Jede Armee hat ihre EIGENE Karte: `CArmyImpl::mIMmap` entsteht bei der
-- Armee-Erzeugung mit `operator new(48)` und `CInfluenceMap(size, army, sim,
-- index)` (Cfile:1017321-1017333). Es gibt keine am Sim.
--
-- Die Zellgroesse steht EINMAL fest, aus den Kartenmassen:
--
--     gridSize = max(32, max(sizeX, sizeZ) / 16)          -- Ganzzahldivision
--     mWidth   = sizeX / gridSize
--     mHeight  = sizeZ / gridSize
--
-- (Cfile:1017315-1017328, Cfile:1035142-1035150; `sizeX`/`sizeZ` sind
-- `heightfield.width - 1` bzw. `height - 1`, also genau das, was `GetMapSize()`
-- liefert, Cfile:1089735-1089738.) Fuer jede FA-Kartengroesse ab 512 ergibt das
-- ein **16x16**-Gitter, fuer 256 ein 8x8 — die Karte ist grob, und die
-- Original-KI weiss das: sie uebergibt `ring = 16` mit der Bedeutung „die ganze
-- Karte" (aibrain.lua:3660, aiutilities.lua:1747).

--- Die 14 Felder von `Moho::SThreat`, in Speicherreihenfolge (Cfile:1034157-1034171,
--- bestaetigt durch Serializer Cfile:1041350-1041363 und Deserializer
--- Cfile:1041330-1041345: 14 Floats, 56 Byte).
---
--- Die NAMEN sind IDA-Beschriftungen, keine Zeichenketten aus der Binaerdatei —
--- `SThreatTypeInfo::Init` registriert nur die Groesse und kein einziges Feld
--- (Cfile:1036250-1036255). Anzahl, Typ, Groesse und REIHENFOLGE sind belegt,
--- die Schreibweise der Namen ist es nicht. Sie sind hier nur Schluessel.
local SCHWELLENFELDER = {
  'overallInfluence', 'influenceStructuresNotMex', 'influenceStructures',
  'navalInfluence', 'airInfluence', 'landInfluence', 'experimentalInfluence',
  'commanderInfluence', 'artilleryInfluence', 'antiAirInfluence',
  'antiSurfaceInfluence', 'antiSubInfluence', 'economyInfluence',
  'unknownInfluence',
}

--- `Moho::EThreatType` — 15 Aufzaehlungswerte auf 14 Felder
--- (`EThreatTypeTypeInfo::AddEnums`, Cfile:1034500-1034530). Die
--- Lua-sichtbaren Zeichenketten sind die Literale ohne das Praefix
--- `THREATTYPE_`; die Umwandlung ist case-INsensitiv (`memicmp`,
--- gpg::REnumType::SetLexical, Cfile:1381888-1381944) und laesst das Praefix
--- optional.
---
--- `Overall` und `OverallNotAssigned` lesen BEIDE `overallInfluence`
--- (Cfile:1034558-1034620) — daher 15 Namen auf 14 Felder.
local BEDROHUNGSTYPEN = {
  overall = 'overallInfluence',
  overallnotassigned = 'overallInfluence',
  structures = 'influenceStructures',
  structuresnotmex = 'influenceStructuresNotMex',
  naval = 'navalInfluence',
  land = 'landInfluence',
  air = 'airInfluence',
  experimental = 'experimentalInfluence',
  commander = 'commanderInfluence',
  artillery = 'artilleryInfluence',
  antiair = 'antiAirInfluence',
  antisurface = 'antiSurfaceInfluence',
  antisub = 'antiSubInfluence',
  economy = 'economyInfluence',
  unknown = 'unknownInfluence',
}

--- Die Reihenfolge, in der die Engine die gueltigen Namen aufzaehlt, wenn ein
--- unbekannter kommt: `SCR_GetEnum` baut daraus „Invalid enum value <s>\n
--- Valid Options are:\n   <name>\n…" und ruft `LuaState::Error`
--- (Cfile:598371-598416). Ein falscher Typ ist also ein FEHLER, kein stiller
--- Standardwert.
local TYPNAMEN = {
  'Overall', 'OverallNotAssigned', 'StructuresNotMex', 'Structures', 'Naval',
  'Air', 'Land', 'Experimental', 'Commander', 'Artillery', 'AntiAir',
  'AntiSurface', 'AntiSub', 'Economy', 'Unknown',
}

local function feldFuer(typ, wo)
  if typ == nil then return BEDROHUNGSTYPEN.overall end
  if type(typ) ~= 'string' then error(wo .. ': string expected', 3) end
  local schluessel = string.lower(typ)
  -- Das Praefix ist optional (SetLexical prueft es mit strncmp und ueberspringt
  -- es, Cfile:1381900).
  if string.sub(schluessel, 1, 11) == 'threattype_' then
    schluessel = string.sub(schluessel, 12)
  end
  local feld = BEDROHUNGSTYPEN[schluessel]
  if not feld then
    error('Invalid enum value ' .. typ .. '\nValid Options are:\n   '
      .. table.concat(TYPNAMEN, '\n   ') .. '\n', 3)
  end
  return feld
end

--- `OverallNotAssigned` laesst die geteilte `threat`-Spur in BEIDEN Zweigen
--- weg (Cfile:1034599-1034612), anders als `Overall` (Cfile:1034584-1034597).
--- Die Erkennung muss dasselbe Praefix abschneiden wie `feldFuer`, sonst
--- verhalten sich `'OverallNotAssigned'` und `'THREATTYPE_OverallNotAssigned'`
--- verschieden — und das sind derselbe Aufzaehlungswert.
local function istNichtZugewiesen(typ)
  if type(typ) ~= 'string' then return false end
  local s = string.lower(typ)
  if string.sub(s, 1, 11) == 'threattype_' then s = string.sub(s, 12) end
  return s == 'overallnotassigned'
end

local function neueSThreat()
  local t = {}
  for _, f in ipairs(SCHWELLENFELDER) do t[f] = 0.0 end
  return t
end

--- Der spielbare Ausschnitt der Karte. `STIMap` setzt ihn auf die GANZE Karte;
--- nur Kampagnenskripte verengen ihn ueber `SetPlayableArea`. Deklariert, weil
--- das strikte `_G` sonst wirft.
---
--- Die Kante ist um eins verschoben, und zwar in DIESE Richtung — die Kette
--- steht in drei Schritten im Decomp:
---   * `mPlayableRect.x1 = quellHeightfield.width - 1`         (Cfile:722515)
---   * das LAUFZEIT-Heightfield entsteht als
---     `CHeightField(quell.width - 1, quell.height - 1)`       (Cfile:722527)
---     und dessen Konstruktor ruft `InitField(width + 1, …)`   (Cfile:525532),
---     setzt also `this->width` wieder auf `quell.width`       (Cfile:527345)
---   * `GetMapSize()` liefert `laufzeit.width - 1`             (Cfile:1089736)
--- Also ist `mPlayableRect.x1` genau `GetMapSize()` — nicht eins weniger.
__playableRect = false

local function playableRect()
  if __playableRect then return __playableRect end
  local sx, sz = GetMapSize()
  return { x0 = 0, z0 = 0, x1 = sx, z1 = sz }
end

--- Setzt den spielbaren Ausschnitt (Cfile:722554-722557 ist derselbe Schreibweg
--- mit expliziten Massen).
function __setPlayableRect(x0, z0, x1, z1)
  __playableRect = { x0 = x0, z0 = z0, x1 = x1, z1 = z1 }
end

__influenceMaps = {}

--- Legt die Karte einer Armee an. Die Engine tut das bei der Armee-Erzeugung;
--- bei uns beim ersten Zugriff, weil `GetMapSize()` erst nach
--- `setTerrainSource` antwortet — und OHNE Karte gibt es keine Bedrohungskarte,
--- also wirft es dort, statt ein Gitter zu erfinden.
local function karte(army)
  local m = __influenceMaps[army]
  if m then return m end
  local sizeX, sizeZ = GetMapSize()
  local groesser = sizeX
  if sizeZ > groesser then groesser = sizeZ end
  local gridSize = groesser // 16
  if gridSize <= 32 then gridSize = 32 end
  m = {
    gridSize = gridSize,
    width = sizeX // gridSize,
    height = sizeZ // gridSize,
    zellen = {},
  }
  m.total = m.width * m.height
  for i = 0, m.total - 1 do
    m.zellen[i] = { threat = neueSThreat(), decay = neueSThreat(), threats = {} }
  end
  __influenceMaps[army] = m
  return m
end

--- `Moho::CInfluenceMap::VectorToCoords` (Cfile:1034865-1034887): x und z auf
--- ganze Zahlen ABSCHNEIDEN, ganzzahlig durch `mGridSize` teilen, je Achse in
--- [0, width-1] bzw. [0, height-1] klemmen. `pos.y` geht nicht ein.
local function zelleAus(m, x, z)
  local cx = math.floor(x) // m.gridSize
  if cx >= m.width - 1 then cx = m.width - 1 end
  if cx < 0 then cx = 0 end
  local cz = math.floor(z) // m.gridSize
  if cz >= m.height - 1 then cz = m.height - 1 end
  if cz < 0 then cz = 0 end
  return cx, cz
end

--- Der Mittelpunkt einer Zelle in Weltkoordinaten (Cfile:1035855-1035859).
--- `mGridSize / 2` ist eine GANZZAHLDIVISION, und y ist immer exakt 0.
local function zellenMitte(m, cx, cz)
  return m.gridSize // 2 + cx * m.gridSize, 0.0, m.gridSize // 2 + cz * m.gridSize
end

--- `Moho::InfluenceGrid::GetThreat(cell, typ, army)` (Cfile:1034558-1034620).
---
--- Zwei Zweige, und die Unsymmetrie zwischen ihnen ist echt und kein Artefakt:
--- mit `army >= 0` ist es `cell.threat.<f> + cell.threats[army].<f>`, mit
--- `army < 0` die Summe ueber ALLE Armeen OHNE `cell.threat`.
--- `OverallNotAssigned` laesst `cell.threat` in beiden Zweigen weg.
local function zellenBedrohung(zelle, feld, ohneGeteilt, army)
  local wert = 0.0
  if army and army >= 0 then
    if not ohneGeteilt then wert = zelle.threat[feld] end
    local a = zelle.threats[army]
    if a then wert = wert + a[feld] end
    return wert
  end
  for _, a in pairs(zelle.threats) do wert = wert + a[feld] end
  return wert
end

--- `Moho::CInfluenceMap::GetThreatRect` (Cfile:1035045-1035081): eine
--- UNGEWICHTETE Summe ueber das einschliessende Quadrat
--- [x-radius..x+radius] x [z-radius..z+radius] in ZELLEN (nicht Welteinheiten),
--- Zellen ausserhalb des Gitters uebersprungen und, wenn `onMap`, zusaetzlich
--- ausserhalb von `mPlayableRect / gridSize`. Ein negativer Radius: 0.
local function rechteck(m, cx, cz, radius, onMap, feld, ohneGeteilt, army)
  if cz - radius > cz + radius then return 0.0 end
  local rx0, rx1, rz0, rz1
  if onMap then
    local r = playableRect()
    rx0, rx1 = r.x0 // m.gridSize, r.x1 // m.gridSize
    rz0, rz1 = r.z0 // m.gridSize, r.z1 // m.gridSize
  end
  local summe = 0.0
  for z = cz - radius, cz + radius do
    if z >= 0 and z < m.height and (not onMap or (z >= rz0 and z <= rz1)) then
      for x = cx - radius, cx + radius do
        if x >= 0 and x < m.width and (not onMap or (x >= rx0 and x <= rx1)) then
          summe = summe + zellenBedrohung(m.zellen[x + z * m.width], feld, ohneGeteilt, army)
        end
      end
    end
  end
  return summe
end

--- Der Armee-Index, den die Bindungen entgegennehmen, ist 1-BASIERT und wird
--- mit -1 umgerechnet; ausserhalb des Bereichs wirft die Engine
--- „Invalid army index passed in to <Name>" (Cfile:740435-740445).
---
--- Das trifft auch `-1`: `aiattackutilities.lua:245` setzt `enemyIndex = -1` in
--- der Absicht „alle Armeen" und uebergibt es an drei Bindungen — die Engine
--- rechnet -1 - 1 = -2 und wirft. Der Weg ist im Original also tot, und er muss
--- bei uns genauso tot sein, sonst rechnet unsere KI mit Zahlen, die es im
--- Spiel nicht gibt.
local function armeeIndex(wert, wo)
  if wert == nil then return -1 end
  if type(wert) ~= 'number' then error(wo .. ': number expected', 3) end
  local i = math.floor(wert) - 1
  local n = 0
  for _ in pairs(__brains) do n = n + 1 end
  if i < 0 or i >= n then
    error('Invalid army index passed in to ' .. wo, 3)
  end
  return i
end

--- Der geteilte Rumpf hinter `CAiBrain:GetThreatAtPosition` (Cfile:740447-740454)
--- und `CAiBrain:GetHighestThreatPosition` (Cfile:740710): beide arbeiten auf der
--- Karte der RUFENDEN Armee (`mArmy->GetIGrid`), nie auf der des
--- `armyIndex`-Arguments. Der Index waehlt nur, welche Spur der Zelle gelesen
--- wird.
function __threatAtPosition(eigenArmee, pos, ring, restriction, typ, armyArg)
  local feld = feldFuer(typ, 'GetThreatAtPosition')
  local ohneGeteilt = istNichtZugewiesen(typ)
  local m = karte(eigenArmee)
  local cx, cz = zelleAus(m, pos[1], pos[3])
  return rechteck(m, cx, cz, math.floor(ring), restriction == true, feld, ohneGeteilt,
    armeeIndex(armyArg, 'GetThreatAtPosition'))
end

--- `Moho::CInfluenceMap::GetHighestThreatPosition`: ein vollstaendiger Durchlauf
--- ueber JEDE Zelle; Gleichstand entscheidet der kleinere quadrierte Abstand vom
--- Startpunkt der rufenden Armee zum Zellenmittelpunkt. Rueckgabe sind ZWEI
--- Werte — eine Vector-Tabelle {x, 0, z} und die Bedrohung als Zahl
--- (Cfile:740710-740718).
function __highestThreatPosition(eigenArmee, ring, restriction, typ, armyArg)
  local feld = feldFuer(typ, 'GetHighestThreatPosition')
  local ohneGeteilt = istNichtZugewiesen(typ)
  local m = karte(eigenArmee)
  local army = armeeIndex(armyArg, 'GetHighestThreatPosition')
  local radius = math.floor(ring)
  local sx, sz = __getBrain(eigenArmee):GetArmyStartPos()
  local besteX, besteZ, besteBedrohung, besterAbstand = 0, 0, -1.0, nil
  -- `if (radius)` — nur mit Radius geht die Engine ueber `GetThreatRect` und
  -- sieht damit `onMap`; sonst liest sie die Zelle DIREKT
  -- (`InfluenceGrid::GetThreat`) und der Ausschnitt spielt keine Rolle
  -- (Cfile:1035804-1035822). Bei `ring = 0` ist das `restriction`-Argument im
  -- Original also wirkungslos.
  local onMap = restriction == true
  for cz = 0, m.height - 1 do
    for cx = 0, m.width - 1 do
      local wert
      if radius ~= 0 then
        wert = rechteck(m, cx, cz, radius, onMap, feld, ohneGeteilt, army)
      else
        wert = zellenBedrohung(m.zellen[cx + cz * m.width], feld, ohneGeteilt, army)
      end
      local mx, _, mz = zellenMitte(m, cx, cz)
      local dx, dz = mx - sx, mz - sz
      local abstand = dx * dx + dz * dz
      if wert > besteBedrohung or (wert == besteBedrohung and besterAbstand and abstand < besterAbstand) then
        besteX, besteZ, besteBedrohung, besterAbstand = cx, cz, wert, abstand
      end
    end
  end
  local x, y, z = zellenMitte(m, besteX, besteZ)
  return Vector(x, y, z), besteBedrohung
end

--- Die SCHREIB-Abbildung ist eine ANDERE als die Lese-Abbildung, und das ist
--- keine Nachlaessigkeit, sondern steht so im Binaercode
--- (Cfile:1035572-1035720, jeder Fall einzeln ausgeschrieben):
---
---   * `Overall` teilt sich den Fall mit `Unknown` und schreibt nach
---     `unknownInfluence` (Cfile:1035574-1035581) — waehrend `GetThreat` fuer
---     `Overall` `overallInfluence` LIEST (Cfile:1034567). `overallInfluence`
---     wird von `AssignThreatAtPosition` also NIE beschrieben; es entsteht
---     allein in `CInfluenceMap::Update` aus den Aufklaerungs-Blips.
---   * `OverallNotAssigned` hat gar keinen Fall: der Aufruf schreibt nichts.
---
--- Praktische Folge, gemessen: `AIBrain:AddInitialEnemyThreat` uebergibt keinen
--- Typ, landet damit im `Overall`-Fall und schreibt nach `unknownInfluence` —
--- fuer eine Abfrage mit `'Overall'` oder `'Structures'` ist diese Bedrohung
--- unsichtbar, nur `'Unknown'` findet sie. Das ist eine Eigenart des echten
--- Spiels; wer sie „geradezieht", baut eine andere KI als die von FA.
local SCHREIBFELDER = {
  overall = 'unknownInfluence',
  unknown = 'unknownInfluence',
  structures = 'influenceStructures',
  structuresnotmex = 'influenceStructuresNotMex',
  naval = 'navalInfluence',
  land = 'landInfluence',
  air = 'airInfluence',
  experimental = 'experimentalInfluence',
  commander = 'commanderInfluence',
  artillery = 'artilleryInfluence',
  antiair = 'antiAirInfluence',
  antisurface = 'antiSurfaceInfluence',
  antisub = 'antiSubInfluence',
  economy = 'economyInfluence',
  -- overallnotassigned: KEIN Fall im switch, also kein Schreibvorgang.
}

--- `CAiBrain:AssignThreatAtPosition(position, threat, [decay], [threattype])`
--- (Cfile:1035567-1035600): schreibt in GENAU EINE Zelle, ohne Radius.
--- `cell.threat.<f> += threat`, danach `cell.decay.<f> = cell.threat.<f> * decay`.
--- Der Decay-Wert wird auf [0,1] geklemmt; fehlt er, ist er 0.01.
function __assignThreatAtPosition(eigenArmee, pos, threat, decay, typ)
  -- Die Engine liest die Position mit `SCR_FromLuaCopy<Vector3>` und wirft bei
  -- allem, was keine ist. Ohne diese Pruefung kommt der Fehler erst zwei
  -- Ebenen tiefer als „bad argument to floor" an, und das war schon einmal eine
  -- halbe Stunde Suche: `AddInitialEnemyThreat` uebergibt
  -- `ScenarioUtils.GetMarker('ARMY_n').position`, und ohne geladene Karte gibt
  -- es diesen Marker nicht.
  if type(pos) ~= 'table' or type(pos[1]) ~= 'number' or type(pos[3]) ~= 'number' then
    error('AssignThreatAtPosition: Vector3 expected (erhalten: ' .. tostring(pos) .. ')', 2)
  end
  if type(threat) ~= 'number' then error('AssignThreatAtPosition: number expected', 2) end
  -- Erst pruefen (ein unbekannter Name wirft, wie SCR_GetEnum), dann die
  -- Schreib-Abbildung nehmen.
  feldFuer(typ, 'AssignThreatAtPosition')
  local schluessel = typ and string.lower(typ) or 'overall'
  if string.sub(schluessel, 1, 11) == 'threattype_' then
    schluessel = string.sub(schluessel, 12)
  end
  local feld = SCHREIBFELDER[schluessel]
  if not feld then return end
  local m = karte(eigenArmee)
  local cx, cz = zelleAus(m, pos[1], pos[3])
  local zelle = m.zellen[cx + cz * m.width]
  -- Arbeitsteilung zwischen Bindung und Umsetzung, und beide Haelften zaehlen:
  --
  --   `cfunc_CAiBrainAssignThreatAtPositionL` setzt `decay = -1.0` als
  --   Ausgangswert; NUR wenn Argument 4 da ist, verlangt es `lua_type == 3`
  --   (sonst TypeError "number", Cfile:740295-740297) und klemmt den Wert auf
  --   [0,1] — `>= 1 -> 1`, `< 0 -> 0` (Cfile:740300-740306).
  --
  --   `CInfluenceMap::AssignThreatAtPosition` ersetzt erst danach ein
  --   NEGATIVES decay durch 0.0099999998 (Cfile:1035568-1035570).
  --
  -- Zusammen heisst das: ein FEHLENDES decay wird 0.01, ein ausdruecklich
  -- negatives wird 0 (die Bindung hat es vorher hochgeklemmt), und etwas, das
  -- keine Zahl ist, wirft. Hier stand vorher eine Zeile, die alle drei Faelle
  -- zu 0.01 zusammenzog.
  local d = decay
  if d == nil then
    d = -1.0
  elseif type(d) ~= 'number' then
    error('AssignThreatAtPosition: number expected', 2)
  else
    if d >= 1 then d = 1.0 elseif d < 0 then d = 0.0 end
  end
  if d < 0 then d = 0.0099999998 end
  zelle.threat[feld] = zelle.threat[feld] + threat
  zelle.decay[feld] = zelle.threat[feld] * d
end

--- `CAiBrain:GetThreatsAroundPosition(position, ring, restriction, threatType
--- [, armyIndex])`: eine Liste von {x, z, bedrohung} je Zelle des Quadrats, nach
--- Bedrohung absteigend. Jeder Eintrag ist eine EINFACHE, VERAENDERBARE Tabelle
--- — `aiattackutilities.lua:290-327` schreibt in die zurueckgegebenen Eintraege
--- zurueck.
function __threatsAroundPosition(eigenArmee, pos, ring, restriction, typ, armyArg)
  local feld = feldFuer(typ, 'GetThreatsAroundPosition')
  local ohneGeteilt = istNichtZugewiesen(typ)
  local m = karte(eigenArmee)
  local army = armeeIndex(armyArg, 'GetThreatsAroundPosition')
  local cx, cz = zelleAus(m, pos[1], pos[3])
  local radius = math.floor(ring)
  local onMap = restriction == true
  local rx0, rx1, rz0, rz1
  if onMap then
    local r = playableRect()
    rx0, rx1 = r.x0 // m.gridSize, r.x1 // m.gridSize
    rz0, rz1 = r.z0 // m.gridSize, r.z1 // m.gridSize
  end
  local out = {}
  for z = cz - radius, cz + radius do
    if z >= 0 and z < m.height and (not onMap or (z >= rz0 and z <= rz1)) then
      for x = cx - radius, cx + radius do
        if x >= 0 and x < m.width and (not onMap or (x >= rx0 and x <= rx1)) then
          local wert = zellenBedrohung(m.zellen[x + z * m.width], feld, ohneGeteilt, army)
          -- NUR Zellen mit echter Bedrohung: `if (Threat > 0.0)`
          -- (Cfile:1035944). Eine leere Zelle steht nicht in der Liste — wer
          -- alle Zellen zurueckgibt, laesst die KI ueber Nullen sortieren und
          -- `[1]` ist dann nicht mehr das Maximum.
          if wert > 0 then
            local mx, _, mz = zellenMitte(m, x, z)
            out[#out + 1] = { mx, mz, wert }
          end
        end
      end
    end
  end
  table.sort(out, function(a, b) return a[3] > b[3] end)
  return out
end

--- `CAiBrain:GetThreatBetweenPositions(pos1, pos2, restriction, [threatType],
--- [armyIndex])` (Hilfetext Cfile:740343-Umgebung; Rumpf Cfile:1035672-1035760).
---
--- Beide Positionen werden mit derselben Klemmung wie ueberall in ZELLEN
--- umgerechnet, dann jeweils +0.5 (Zellenmittelpunkte in Zelleinheiten), und
--- der Weg dazwischen wird abgeschritten. JEDER Schritt geht durch
--- `GetThreatRect` mit **Radius 0** — also genau eine Zelle je Schritt — und
--- bekommt `restriction` als `onMap` durchgereicht (der Decompiler nennt den
--- Parameter `ring`, aber es ist der fuenfte Parameter von `GetThreatRect`).
---
--- Der einzige Aufrufer im Spiel ist `aiattackutilities.lua:1233`
--- (GeneratePath), und er uebergibt im dritten Feld `nil` — was
--- `LuaStackObject::GetBoolean` als false liest.
---
--- UNVERIFIZIERT: die genaue Schrittregel. Die Engine baut ein `struct_Line`
--- und laeuft es ab; der dekompilierte Rumpf ist so verschraenkt, dass die
--- Tie-Break-Regel fuer exakt diagonale Linien nicht ablesbar ist. Hier steht
--- ein gewoehnlicher Bresenham ueber die Zellen. Fuer alle nicht-diagonalen
--- Linien ist die Zellenfolge dieselbe; auf der Diagonalen kann sie um eine
--- Zelle abweichen.
function __threatBetweenPositions(eigenArmee, pos1, pos2, restriction, typ, armyArg)
  local feld = feldFuer(typ, 'GetThreatBetweenPositions')
  local ohneGeteilt = istNichtZugewiesen(typ)
  local m = karte(eigenArmee)
  local army = armeeIndex(armyArg, 'GetThreatBetweenPositions')
  local onMap = restriction == true
  local x1, z1 = zelleAus(m, pos1[1], pos1[3])
  local x2, z2 = zelleAus(m, pos2[1], pos2[3])
  local dx, dz = math.abs(x2 - x1), math.abs(z2 - z1)
  local sx = x1 < x2 and 1 or -1
  local sz = z1 < z2 and 1 or -1
  local fehler = dx - dz
  local x, z = x1, z1
  local summe = 0.0
  while true do
    -- Radius 0: `GetThreatRect(this, x, z, 0, ring, …)` (Cfile:1035707).
    summe = summe + rechteck(m, x, z, 0, onMap, feld, ohneGeteilt, army)
    if x == x2 and z == z2 then break end
    local e2 = 2 * fehler
    if e2 > -dz then
      fehler = fehler - dz
      x = x + sx
    end
    if e2 < dx then
      fehler = fehler + dx
      z = z + sz
    end
  end
  return summe
end

--- `Moho::InfluenceGrid::DecayInfluence` (Cfile:1034250-1034262), gefahren von
--- `CInfluenceMap::Update`, das jede Armee laufen laesst, wenn
--- `mCurTick % 30 == armyIndex` (Cfile:1018010-1018011) — also alle 30 Ticks je
--- Armee, gegeneinander versetzt.
---
--- Je Feld: `if (threat > 0) threat = max(threat - decay, 0)` bei
--- nichtnegativem Decay. Es zerfaellt NUR die geteilte `threat`-Spur, nie die
--- Spuren der einzelnen Armeen.
---
--- Und dann die LETZTE Anweisung der Funktion, die keine Zerfallszeile ist:
--- `overallInfluence` wird nicht zerfallen, sondern NEU BERECHNET — als
--- ungewichtete Summe der 13 anderen Felder, in genau dieser Reihenfolge
--- (Cfile:1034420-1034429). Der `Overall`-Kanal ist damit keine eigene Spur,
--- sondern die Gesamtsicht auf alle anderen, und er entsteht ohne jede
--- Aufklaerung.
---
--- Hier stand vorher das Gegenteil: der Kommentar behauptete, `overallInfluence`
--- entstehe allein aus den Aufklaerungs-Blips und sei deshalb bei uns tot. Die
--- Folge war real — `aiattackutilities.lua:250` baut seine Zielliste mit
--- `GetThreatsAroundPosition(pos, 16, true, 'Overall', enemyIndex)`, und die
--- blieb immer leer.
---
--- Die Reihenfolge der Summanden ist nicht kosmetisch: Gleitkomma-Addition ist
--- nicht assoziativ, und diese Sim soll deterministisch sein.
local OVERALL_SUMMANDEN = {
  'antiSurfaceInfluence', 'experimentalInfluence', 'influenceStructures',
  'antiSubInfluence', 'commanderInfluence', 'navalInfluence',
  'economyInfluence', 'artilleryInfluence', 'airInfluence',
  'unknownInfluence', 'antiAirInfluence', 'landInfluence',
  'influenceStructuresNotMex',
}

--- Was `Update` ausserdem tut — die `entries` je Zelle aus den Aufklaerungs-
--- Blips neu aufsummieren (Cfile:1035325-1035375) — steht hier NICHT: dafuer
--- braucht es die ReconDB, die es bei uns nicht gibt. Betroffen sind damit die
--- Spuren der EINZELNEN Armeen (`threats[army]`), nicht die geteilte.
--- Siehe docs/STATUS.md.
function __influenceTick(tick)
  for army, m in pairs(__influenceMaps) do
    if tick % 30 == army - 1 then
      for i = 0, m.total - 1 do
        local zelle = m.zellen[i]
        for _, f in ipairs(SCHWELLENFELDER) do
          if f ~= 'overallInfluence' then
            local t = zelle.threat[f]
            if t > 0 then
              local n = t - zelle.decay[f]
              if n < 0 then n = 0.0 end
              zelle.threat[f] = n
            end
          end
        end
        local summe = 0.0
        for _, f in ipairs(OVERALL_SUMMANDEN) do summe = summe + zelle.threat[f] end
        zelle.threat.overallInfluence = summe
      end
    end
  end
end

--- Nur fuer die Pruefsuite: die Rohwerte einer Zelle, ohne den Weg ueber die
--- Bindungen.
function __influenceCellThreat(army, x, z, typ)
  local m = karte(army)
  local cx, cz = zelleAus(m, x, z)
  return m.zellen[cx + cz * m.width].threat[feldFuer(typ, 'debug')]
end

function __influenceGridInfo(army)
  local m = karte(army)
  return m.gridSize, m.width, m.height
end
