-- =====================================================================
-- Die Konsole der Engine: ConExecute und die ConVars.
--
-- 19 der 37 Optionen wirken ueber genau diesen Weg (options.lua):
--
--     set = function(key, value, startup)
--         ConExecute("ui_KeyboardPanSpeed " .. value)
--     end
--
-- Dahinter liegen in der Engine echte Variablen (Moho::TConVar<bool|int|float>,
-- z. B. `float Moho::ui_KeyboardPanSpeed = 90.0;`), die die C++-Seite in ihren
-- Schleifen liest — die WorldView fragt bei jedem Bild ui_KeyboardPanSpeed ab,
-- die Kamera cam_ZoomAmount, der Renderer shadow_Fidelity.
--
-- Bisher hat unser ConExecute nur geloggt. Damit war jede dieser 19 Optionen
-- eine Attrappe: der Regler bewegte sich, der Wert wurde gespeichert — und
-- niemand las ihn je.
--
-- ZWEI DINGE, die man nicht raten darf:
--
--  1. Die Namen sind NICHT case-sensitiv. options.lua schreibt `ren_Skydome`
--     und `ren_bloom`, die Engine heisst `Moho::ren_SkyDome` und
--     `Moho::ren_Bloom`. Wer exakt vergleicht, verliert genau diese zwei.
--  2. Ein Konsolenbefehl ist entweder eine VARIABLE (Name + Wert) oder eine
--     FUNKTION (CConFunc, z. B. WLD_IncreaseSimRate). Eine Funktion, die es bei
--     uns nicht gibt, wird EINMAL gemeldet — nicht still verschluckt.
--
-- STANDARD-LUA 5.4 (geht roh in host.eval, nicht durch den FA-Transpiler).
-- =====================================================================

__conVars = {}
__conUnknown = {}
__uiConSink = false

-- Die Variablen, die die Original-Lua ueber ConExecute setzt
-- (peek-lua --grep "ConExecute\("). Alle existieren in der Decomp als
-- Moho::TConVar bzw. Moho::<name>.
local KNOWN_VARS = {
  'cam_ZoomAmount', 'cam_NearZoom', 'cam_PanSpeed',
  'ui_KeyboardPanSpeed', 'ui_KeyboardPanAccelerateMultiplier',
  'ui_KeyboardRotateSpeed', 'ui_KeyboardRotateAccelerateMultiplier',
  'ui_ScreenEdgeScrollView', 'ui_ArrowKeysScrollView', 'ui_SelectTolerance',
  'ui_AlwaysRenderStrategicIcons', 'ui_RenderUnitBars', 'ui_NisRenderIcons',
  'graphics_Fidelity', 'shadow_Fidelity', 'ren_MipSkipLevels',
  'ren_SkyDome', 'ren_Bloom', 'ren_Oblivion', 'ren_SelectBoxes',
  'SC_CameraScaleLOD', 'SC_VerticalSync', 'SC_AntiAliasingSamples',
  'SC_PrimaryAdapter', 'SC_SecondaryAdapter', 'SC_ToggleCursorClip',
}

-- STARTWERTE — nur die, die in der Decomp BELEGT sind. Ein Default, den ich
-- nicht belegen kann, wird nicht erfunden: die Variable startet dann ohne Wert
-- und bekommt ihn beim Start von optionslogic.Apply(true), das jede Option mit
-- ihrem `set` durchlaeuft (Moho::OPTIONS_Apply, Cfile:1368338).
local DEFAULTS = {
  cam_ZoomAmount = 0.40000001,                   -- Cfile:421825
  cam_NearZoom = 5.0,                            -- Cfile: float Moho::cam_NearZoom = 5.0
  cam_PanSpeed = 1.0,                            -- Cfile: float Moho::cam_PanSpeed = 1.0
  ui_KeyboardPanSpeed = 90.0,                    -- Cfile:421739
  ui_KeyboardPanAccelerateMultiplier = 4.0,      -- Cfile:421740
  ui_KeyboardRotateSpeed = 10.0,                 -- Cfile:421741
  ui_KeyboardRotateAccelerateMultiplier = 2.0,   -- Cfile:421742
  ui_ScreenEdgeScrollView = true,                -- Cfile:421730
  ui_SelectTolerance = 4.0,                      -- Cfile:421734
  ui_RenderUnitBars = true,                      -- Cfile:421748
  ui_NisRenderIcons = true,                      -- Cfile:421760
  graphics_Fidelity = 2,                         -- Cfile: int Moho::graphics_Fidelity = 2
  shadow_Fidelity = 2,                           -- Cfile: int Moho::shadow_Fidelity = 2
}

local function key(name)
  return string.lower(tostring(name))
end

for _, name in ipairs(KNOWN_VARS) do
  __conVars[key(name)] = { name = name, value = DEFAULTS[name] }
end

--- Den Wert einer ConVar lesen (auch aus TS, ueber __conGet).
function __conGet(name)
  local entry = __conVars[key(name)]
  if not entry then return nil end
  return entry.value
end

local function parseValue(text)
  if text == nil or text == '' then return nil end
  local lower = string.lower(text)
  if lower == 'true' then return true end
  if lower == 'false' then return false end
  local n = tonumber(text)
  if n then return n end
  return text
end

--- ConExecute(cmd) — ein Konsolenbefehl, wie ihn die Engine kennt.
---
--- Beispiele aus der Original-Lua:
---   ConExecute("ui_KeyboardPanSpeed 90")     -- Variable setzen
---   ConExecute("ren_Skydome true")           -- (anderer Fall als Moho::ren_SkyDome!)
---   ConExecute("WLD_IncreaseSimRate")        -- Funktion ohne Argument
function ConExecute(cmd)
  if not cmd then return end
  local text = tostring(cmd)
  local name, rest = string.match(text, '^%s*(%S+)%s*(.*)$')
  if not name then return end
  rest = string.match(rest, '^(.-)%s*$') -- Leerraum hinten weg

  local entry = __conVars[key(name)]
  if entry then
    local value = parseValue(rest)
    if value == nil then
      -- Variable ohne Wert: die Engine gibt den aktuellen aus. Wir tun dasselbe.
      LOG(entry.name .. ' = ' .. tostring(entry.value))
      return
    end
    entry.value = value
    -- Die Engine ist bei uns TypeScript: sie muss von der Aenderung erfahren
    -- (Kamera, Renderer, Auswahl lesen diese Werte).
    if __uiConSink then
      __uiConSink(entry.name, value)
    end
    return
  end

  -- Kein bekannter Wert-Name -> eine Konsolen-FUNKTION (CConFunc). Die gibt es
  -- bei uns noch nicht. EINMAL melden, nicht still schlucken — sonst sieht
  -- niemand, welches Engine-Teil als Naechstes fehlt.
  if not __conUnknown[key(name)] then
    __conUnknown[key(name)] = text
    WARN('ConExecute: "' .. text .. '" — dieser Konsolenbefehl fehlt noch')
  end
end

function ConExecuteSave(cmd)
  ConExecute(cmd)
end
