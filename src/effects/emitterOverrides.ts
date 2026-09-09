import type { EmitterBpData } from './emitterRuntime'

/**
 * The Lua's per-emitter parameters as the emitter row carries them
 * (globals.lua __emitterParamsJson): the scalar EEmitterParam values by
 * canonical name, the replaced curves by blueprint field, the EBeamParam
 * values by name.
 */
export interface EmitterOverrides {
  params?: Record<string, number>
  curves?: Record<string, { XRange: number; Keys: [number, number, number][] }>
  beam?: Record<string, number>
}

/**
 * The scalar EEmitterParam names the runtime consumes, by the blueprint
 * field they stand for (mParams is the emitter's own copy of the blueprint,
 * CEfxEmitter ctor Cfile:893987-894008). The flags are tested `> 0`
 * (EFFECT_USE_LOCAL_VELOCITY :894849, EFFECT_ALIGN_TO_BONE :894894).
 * TICKCOUNT, TICKINCREMENT, ALIGN_ROTATION, SORTORDER, LODCUTOFF,
 * EMITIFVISIBLE, CATCHUPEMIT, CREATEIFVISIBLE, SNAPTOWATERLINE and
 * ONLYEMITONWATER have no reader in this runtime (docs/STATUS.md).
 */
export const EMITTER_PARAM_FIELDS: Record<string, { field: keyof EmitterBpData; flag?: boolean }> = {
  LIFETIME: { field: 'Lifetime' },
  REPEATTIME: { field: 'Repeattime' },
  FRAMECOUNT: { field: 'TextureFramecount' },
  TEXTURE_STRIPCOUNT: { field: 'TextureStripcount' },
  BLENDMODE: { field: 'Blendmode' },
  USE_LOCAL_VELOCITY: { field: 'LocalVelocity', flag: true },
  USE_LOCAL_ACCELERATION: { field: 'LocalAcceleration', flag: true },
  USE_GRAVITY: { field: 'Gravity', flag: true },
  INTERPOLATE_EMISSION: { field: 'InterpolateEmission', flag: true },
  ALIGN_TO_BONE: { field: 'AlignToBone', flag: true },
  FLAT: { field: 'Flat', flag: true },
  PARTICLERESISTANCE: { field: 'ParticleResistance', flag: true },
}

/**
 * The emitter's blueprint with the Lua's SetEmitterParam /
 * SetEmitterCurveParam / ResizeEmitterCurve applied -- the per-instance
 * mParams and mCurves the engine keeps (SetFloatParam 889215-889221,
 * SetCurveParam 894179-894204), consumed by the same curve sampling. A
 * name the runtime has no field for is left alone.
 */
export function applyEmitterOverrides(bp: EmitterBpData, e: EmitterOverrides): EmitterBpData {
  const out: EmitterBpData = { ...bp }
  for (const [name, value] of Object.entries(e.params ?? {})) {
    const m = EMITTER_PARAM_FIELDS[name]
    if (!m) continue
    ;(out as Record<string, unknown>)[m.field] = m.flag ? value > 0 : value
  }
  const curves = e.curves ?? {}
  for (const field of Object.keys(curves)) {
    const curve = curves[field]!
    ;(out as Record<string, unknown>)[field] = {
      XRange: curve.XRange,
      Keys: curve.Keys.map(([x, y, z]) => ({ x, y, z })),
    }
  }
  return out
}

/** The override signature a runtime was built with -- '' without any. */
export function emitterOverrideSignature(e: EmitterOverrides): string {
  if (!e.params && !e.curves) return ''
  // The beam parameters do not enter: nothing in the runtime reads them
  // (docs/STATUS.md) -- to be revisited with the beam renderer.
  return JSON.stringify([e.params ?? null, e.curves ?? null])
}
