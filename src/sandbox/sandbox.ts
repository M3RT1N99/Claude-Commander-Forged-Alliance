import type { UnitViewer } from '../viewer/unitViewer'
import type { UnitTextures } from '../viewer/unitMaterial'
import type { ScmModel } from '../formats/scm'
import type { ScaAnim } from '../formats/sca'
import type { BpObject } from '../formats/blueprint'

/** Geladene Render-Assets einer Unit für die Sandbox. */
export interface SandboxUnitAssets {
  id: string
  model: ScmModel
  textures: UnitTextures
  bp: BpObject
  walkAnim: ScaAnim | null
  shader: string
}

/**
 * Schlanke Sandbox-Ansicht: nur die RTS-Kamera. Die Simulation selbst läuft
 * über die eingebettete **Original-Lua-Engine** (LuaSim).
 *
 * Hier stand ein selbst erfundener Ring-Marker für Mass-Punkte. Er ist WEG:
 * nichts zeichnen, was nicht aus dem Spiel kommt. Im Original sind Mass-Punkte
 * Ressourcen-Vorkommen (`CreateResourceDeposit`, angelegt von
 * `ScenarioUtilities.lua`), und die Engine rendert ihre Icons — das kommt über
 * den Session-Start-1:1-Weg (docs/research/session-start.md), nicht über
 * Platzhalter-Geometrie. Die Marker-Daten bleiben in main.ts erhalten.
 */
export class SandboxController {
  constructor(viewer: UnitViewer) {
    viewer.setRtsControls(true)
  }
}
