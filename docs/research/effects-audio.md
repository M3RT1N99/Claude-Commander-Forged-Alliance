# agent5

## Summary
Effects in SupCom:FA are completely data-driven: 2,724 effect blueprints (Lua DSL files `*_emit.bp` in `effects.scd`) in three types — EmitterBlueprint (Particles, 2,437), TrailEmitterBlueprint (Poly-Trails, 184), BeamBlueprint (Beams, 103). An emitter is essentially a texture + ramp texture + 21 curves (each `XRange` + keys `{x=Zeit_in_Ticks, y=Mittelwert, z=Zufalls-Spread}`) + 13 flags; The particle integration (position, rotation, size, frame animation, Alpha=t/lifetime→Ramp-U) happens completely analytically in the vertex shader (`effects/particle.fx`), i.e. it can be recreated 1:1 in WebGL/WebGPU. Lua scripts only reference emitters via path strings, bundled in `lua/EffectTemplates.lua` (~586 templates) and generated via engine functions `CreateEmitterAtBone/CreateAttachedEmitter/CreateTrail/CreateBeamEmitterOnEntity`. Audio is Blueprints reference sounds as `Sound { Bank='UEL', Cue='UEL0201_Move_Loop', LodCutoff='UnitMove_LodCutoff' }`, totaling 1,896 cues.

## Key Facts
- Emitter blueprints are ONLY in gamedata/effects.scd under effects/Emitters/ — 2724 files: 2437 EmitterBlueprint, 184 TrailEmitterBlueprint, 103 BeamBlueprint (no _emit.bp in units/projectiles/env.scd).
- The .bp format is pure Lua: the file calls the global function EmitterBlueprint{...} / TrailEmitterBlueprint{...} / BeamBlueprint{...} (defined in mohodata.scd → lua/system/Blueprints.lua); BlueprintId defaults to the lowercase file path.
- An EmitterBlueprint has 21 curves (SizeCurve, X/Y/ZDirectionCurve, EmitRateCurve, LifetimeCurve, VelocityCurve, RampSelectionCurve) — each with XRange + Keys {x,y,z}.
- Curve evaluation (SEfxCurve::GetValue): linear interpolation of y AND z between the keys, then return (rand()-0.5)*z + y — so z is the random spread, not a third value.
- Time unit of all curves/lifetimes are Sim-Ticks (10/s); the shader gets time = tick + frameDelta. Lifetime = -1 means infinite.
- The complete particle physics is in the vertex shader effects/particle.fx: without drag pos = P0 + V*t + 0.5*A*t^2, with drag (ParticleResistance) pos = (dz*A - dy*V)*(e^(-dx*t)-1) + dy*A*t + P0; Size = Size.x + Size.y*t; Rotation = angle0 + rotRate*t.
- color = particle texture * ramp texture; the ramp is sampled with U = t/lifetime and V = RampSelection (ramp encodes color+alpha over lifetime). 747 particle textures are located in textures.scd under textures/particles/.
- BlendMode mapping (from CWorldParticles.cpp ResolveParticleTechniqueSuffix): 0=ALPHABLEND, 1=MODULATEINVERSE, 2=MODULATE2XINVERSE, 3=ADD, 4=PREMODALPHA, 5=REFRACT. The most common value in the data is 3 (ADD, ~1744x), then 0 (~658x).
- Trails (TrailEmitterBlueprint) are ribbon/poly trails with TrailLength, Size, TextureRepeatRate, RepeatTexture + RampTexture — created via CreateTrail(entity,bone,army,bp).
- Projectile Trails: lua/sim/DefaultProjectiles.lua defines FxTrails (list of EmitterBlueprints via CreateEmitterOnEntity), PolyTrail/PolyTrails (TrailEmitterBlueprints via CreateTrail) and Beams (BeamBlueprints via CreateBeamEmitterOnEntity) — classes EmitterProjectile, SinglePolyTrailProjectile, MultiCompositeEmitterProjectile, etc.
- Muzzle flash: lua/sim/defaultweapons.lua PlayFxMuzzleSequence -> CreateAttachedEmitter(unit, muzzleBone, army, v):ScaleEmitter(FxMuzzleFlashScale) via the table FxMuzzleFlash (typically an EffectTemplate).
- Impacts/Explosions: lua/defaultexplosions.lua + lua/EffectUtilities.lua (CreateEffects, CreateBoneEffects, CreateEffectsWithOffset, CreateRandomEffects) iterate over EffectTemplate tables from lua/EffectTemplates.lua (~586 template tables, 180 KB, paths composed of EmtBpPath='/effects/emitters/').
- Sounds are NOT in an .scd, but in the plain text folder <FA>/sounds/: 78 *.xwb, 80 *.xsb, 1 SupCom.xgs, plus sounds/Voice/{US,DE}. Engine: AudioEngine::Create("/sounds") enumerates *.xwb and *.xsb and loads SupCom.xgs.
- XWB header is 'WBND' (Version 43 / HeaderVersion 42) with 5 segments (BANKDATA@0x34, ENTRYMETADATA@0x94, SEEKTABLES, ENTRYNAMES, ENTRYWAVEDATA); Entry metadata is 24 bytes per entry (Duration, MiniWaveFormat, PlayRegion offset+length).
- ALL FA waves are PCM (formatTag=0), 16 bit: SFX 32000 Hz mono (blockAlign 2), music 44100 Hz stereo (blockAlign 4, streaming bank with alignment 2048) — no XMA/ADPCM/WMA, so no decoder necessary, just prefix WAV header.
- XSB header is 'SDBK' (tool/format version 43); Fields: numSimpleCues@0x13, numComplexCues@0x15, numWaveBanks@0x1B, numSounds@0x1C, cueNamesLength@0x1E, simpleCuesOffset@0x22, complexCuesOffset@0x26, cueNamesOffset@0x2A, waveBankNameTableOffset@0x3A (64 Byte/Name), soundsOffset@0x46, soundBankName@0x4A (64 Bytes). Cue names are a zero-separated list of strings.
- Blueprint Sound Reference: Audio = { AmbientMove = Sound { Bank='UEL', Cue='UEL0201_Move_Loop', LodCutoff='UnitMove_LodCutoff' }, ... }; the global Lua function Sound{} builds a CSndParams (mBank, mCue, mLodCutoff) and resolves BankId+CueId at runtime. A total of 1896 cues across all 80 .xsb.
- Sound Lua API: user-side PlaySound(sndParams, prepareOnly) / StopSound(handle,[immediate]) / SetVolume(category,vol) / PlayVoice(params,duck); sim-side PlayLoop(self,sndParams) / StopLoop(self,handle); Entity has PlaySound and SetAmbientSound, Weapon has PlaySound(bp.Audio.Fire).
- Music system: lua/UserMusic.lua — battle and peace cues from bank 'Music' (cues: Main_Menu, Base_Building, Battle), switching after 20 battle events, switching back after 200 ticks of rest; Ducking is implemented in CUserSoundManager via XACT variables 'Duck'/'DuckLength'.

## Details
## 1. Partikel/Emitter — Format & Parameter

### Dateiformat
`gamedata/effects.scd` (ZIP) → `effects/Emitters/*.bp`. Plaintext Lua, calling a global constructor function:

- `EmitterBlueprint { ... }` — 2437 files
- `TrailEmitterBlueprint { ... }` — 184 files
- `BeamBlueprint { ... }` — 103 files
- Total 2724 (of which 2702 with suffix `_emit.bp`, 22 without).

Registration in `mohodata.scd → lua/system/Blueprints.lua`: `LoadBlueprints()` scans `/effects,/env,/meshes,/projectiles,/props,/units` for `*.bp` and executes them as Lua; Store the functions `EmitterBlueprint/BeamBlueprint/TrailEmitterBlueprint` in `original_blueprints.{Emitter,Beam,TrailEmitter}`; `BlueprintId` = lowercase source path (i.e. `/effects/emitters/xyz_emit.bp`) unless explicitly set. Then `RegisterEmitterBlueprint()` etc. to the engine.

### EmitterBlueprint fields (verified against REmitterBlueprint, size 0x284)
Basis `REffectBlueprint`: `BlueprintId`, `HighFidelity/MedFidelity/LowFidelity` (bool, default 1).

Skalare / Flags:
| field | Default | Meaning |
|---|---|---|
| `Lifetime` | 0 | Emitter-Lebensdauer in Ticks; `-1` = unendlich |
| `Repeattime` | 0 | Cycle length (curve XRange reference) |
| `TextureFramecount` | 0 | Frames im Textur-Strip (>1 ⇒ „Animate"-Technique) |
| `TextureStripcount` | 1 | Number of lines (texture variants) in the texture |
| `Blendmode` | 0 | 0..5 (siehe unten) |
| `SortOrder` | 0 | Render-Sortierung |
| `LODCutoff` | 100 | Kamera-Distanz-Cutoff |
| `LocalVelocity` | true | Velocity im lokalen Bone-Space |
| `LocalAcceleration` | false | |
| `Gravity` | false | |
| `AlignRotation` | false | ⇒ Technique „Align" (Quad an Bewegungsrichtung) |
| `AlignToBone` | false | ⇒ Technique „AlignToBone" |
| `Flat` | false | ⇒ Technique “Flat” (XZ plane instead of billboard) |
| `EmitIfVisible` | true | |
| `CatchupEmit` | true | |
| `CreateIfVisible` | false | |
| `ParticleResistance` | false | ⇒ Drag-Modell im Shader |
| `InterpolateEmission` | true | Distribute particles along motion track between ticks |
| `SnapToWaterline` | true | |
| `OnlyEmitOnWater` | false | |
| `Texture` | '' | z.B. `/textures/particles/line_white_add_06.dds` |
| `RampTexture` | '' | z.B. `/textures/particles/ramp_antimatter_01.dds` |

### The 21 curves
Sequence according to `REmitterBlueprint` or Enum `EEmitterCurve`:
`SizeCurve, XDirectionCurve, YDirectionCurve, ZDirectionCurve, EmitRateCurve, LifetimeCurve, VelocityCurve, XAccelCurve, YAccelCurve, ZAccelCurve, ResistanceCurve, StartSizeCurve, EndSizeCurve, InitialRotationCurve, RotationRateCurve, FrameRateCurve, TextureSelectionCurve, XPosCurve, YPosCurve, ZPosCurve, RampSelectionCurve`

Each curve:
```
EmitRateCurve = { XRange = 4.00, Keys = { { x=2.044, y=25.643, z=0.000 }, ... } }
```
- `XRange` = timeline length (ticks), usually == `repeattime`.
- Key: `x` = Zeitpunkt, `y` = Mittelwert, `z` = **Zufalls-Spread**.

**Auswertung (SEfxCurve::GetValue, 1:1 nachbauen):**
```
finde ersten Key mit key.x > interp
 wenn keiner: y=last.y, z=last.z
 wenn erster:  y=first.y, z=first.z
 sonst: f = (interp - prev.x)/(cur.x - prev.x)
        y = lerp(prev.y, cur.y, f);  z = lerp(prev.z, cur.z, f)
return (random01() - 0.5) * z + y
```
(File: `faf-re/src/sdk/moho/effects/rendering/SEfxCurve.cpp:319`)

Verified in your own decomp (Cfile/ForgedAlliance.exe.c) and as
`src/effects/curves.ts` umgesetzt (Suite: `scripts/verify-emitter-curves.ts`):
- `Moho::SEfxCurve::GetValue` @0x514E50, Cfile:649014-649070. 0 Keys → 0.0
  (:649030-649031); Scan `while (key.x <= t)` (:649049); t before the first key
  → Clamp on first.y/z (:649054-649058); t on/behind the last key →
  Clamp on last.y/z (:649036-649045); otherwise `(rand-0.5)*(preZ+(curZ-preZ)*f)
  + f*(curY-preY) + preY` (:649065-649067). rand = Mersenne-Twister × 2^-32,
  Range [0,1), ONE move per invocation (func_RandomFloatSafe :648929-648937).
- GetValue does NOT wrap time or read XRange. The cyclical one
  The break is at the CALLER: `t = fmod(TICKCOUNT - tick, Repeattime)` plus
  Vorzeichen-Korrektur (floored modulo), Cfile:894655-894661 (EmitRate) bzw.
  :894693-894698 (per particle). `Repeattime = 0` → fmod = NaN → GetValue
  clamps to the first key.
- `func_MakeEmitterCurve` Cfile:649226-649274 builds the runtime curve:
  Keys are inserted sorted (stable ascending according to x, sub_5151B0
  :649185-649191); Curve without keys → Default XRange=10, one key {5,0,0}
  (:649264-649271). In the real data: 0 unsorted curves, 159 curves
  with double x (result there = y of the LAST key with the same x).
- Blueprint field order of the 21 curves: `REmitterBlueprint::Init`
  Cfile:645017-645079 (= list above). The runtime lanes (`mCurves`,
  CEfxEmitter-Ctor Cfile:893987-894008) are sorted differently: XDir, YDir,
  ZDir, EmitRate, Lifetime, Velocity, XAccel, YAccel, ZAccel, Resistance,
  Size, XPos, YPos, ZPos, StartSize, EndSize, InitialRotation, RotationRate,
  FrameRate, TextureSelection, RampSelection.

Emitter runtime scalars (Enum `EEmitterParam`, settable via `effect:SetEmitterParam('name',v)`): `POSITION_X/Y/Z, TICKCOUNT, LIFETIME, REPEATTIME, TICKINCREMENT, BLENDMODE, FRAMECOUNT, USE_LOCAL_VELOCITY, USE_LOCAL_ACCELERATION, USE_GRAVITY, ALIGN_ROTATION, INTERPOLATE_EMISSION, TEXTURE_STRIPCOUNT, ALIGN_TO_BONE, SORTORDER, FLAT, SCALE, LODCUTOFF, EMITIFVISIBLE, CATCHUPEMIT, CREATEIFVISIBLE, SNAPTOWATERLINE, ONLYEMITONWATER, PARTICLERESISTANCE`.

### How the engine plays them (the crucial part for the replication)
`effects/particle.fx` (in effects.scd) contains the complete simulation in the **vertex shader** `WorldVS`. The following vertex attributes are provided per particle quad:
`Corner(float2 quad corner ±1)`, `Pos(float4: xyz=spawn position, w=start angle)`, `Size(float2: x=BeginSize, y=Size-Rate)`, `Velocity(float4: xyz=speed, w=rotation rate)`, `Acceleration(float3)`, `inTime(float4: x=SpawnTime, y=Lifetime, z=Framerate, w=FrameSize)`, `inTexOffset(float3: x=Texture line offset, y=Ramp-V, z=Line height)`, `dragCoeff(float3)`.

Global shader var `time = tick + frameDelta` (ticks!).
```
t = time - spawnTime;  alpha = t / lifetime;   // >=1 ⇒ Partikel tot
DragEnabled? pos = (dz*A - dy*V)*(e^(-dx*t) - 1) + dy*A*t + P0
           : pos = P0 + V*t + 0.5*A*t^2
rot = Pos.w + Velocity.w * t
quad = rotate(Corner, rot) * (Size.x + Size.y * t)
Flat?  pos += quad.x*(1,0,0) + quad.y*(0,0,1)
     : pos += quad.x*InverseView[0] + quad.y*InverseView[1]   // Billboard
uv0 = (Corner+1)*0.5;  bei Animate: frame=floor(framerate*t); uv0.x = uv0.x*framesize + framesize*frame;
                                    uv0.y = uv0.y*texOff.z + texOff.x
uv1 = (alpha, texOff.y)   // Ramp-Lookup!
Farbe = tex2D(ParticleTex0, uv0) * tex2D(RampTex, uv1)
```
Technique name = `TRamp` + [`Animate`] + [`Align` | `AlignToBone` | `Flat`] + `_<BLEND>`; additionally `TLight_*` (LightParticle), `TBeam_OneTexture_*` / `TBeam_TwoTexture_*`, `TPolyTrail_*`.

**BlendMode → Render State** (from `CWorldParticles.cpp:443 ResolveParticleTechniqueSuffix` + particle.fx):
| Wert | Suffix | Blend (Src, Dst) |
|---|---|---|
| 0 | `_ALPHABLEND` | SrcAlpha, InvSrcAlpha |
| 1 | `_MODULATEINVERSE` | Zero, InvSrcColor |
| 2 | `_MODULATE2XINVERSE` | InvDestColor, InvSrcColor |
| 3 | `_ADD` | SrcAlpha, One |
| 4 | `_PREMODALPHA` | One, InvSrcAlpha |
| 5 | `_REFRACT` | SrcAlpha, InvSrcAlpha + Refraktion (samplet Backbuffer) |
All: Depth-Test Less, **no** Depth-Write, Cull None.
Frequency in the data: 3(ADD) ≈1744, 0 ≈658, 1 ≈181, 2 ≈17, 4 ≈26, 5 ≈21.

### Beams
`BeamBlueprint` (RBeamBlueprint, size 0x84):
```
BeamBlueprint {
    Lifetime = 2,                       # default 1
    TextureName = '/textures/particles/UEF_adjacency_beam_01.dds',
    Thickness = 0.015,                  # default 1
    StartColor = {x=0.2,y=0.2,z=1,w=0.1},   # RGBA
    EndColor   = {x=0.2,y=0.2,z=1,w=0.1},
    Length = 8,                         # default 10
    UShift = 0.0, VShift = 0.0,
    # weitere: LODCutoff (default 200), RepeatRate (0), BlendMode (default 3)
}
```
Runtime `SWorldBeam`: Start/End transform (with load transform for interpolation), Width, StartColor/EndColor (Vector4), 2 textures, UShift/VShift/RepeatRate, BlendMode.
Lua: `CreateBeamEmitter(bp,army)`, `CreateBeamEmitterOnEntity(entity,bone,army,bp)`, `CreateBeamEntityToEntity(e,b,other,b,army,bp)`, `CreateAttachedBeam(entity,bone,army,length,thickness,texture)`, `AttachBeamEntityToEntity(...)`. Beam Params (`effect:SetBeamParam(name,v)`): `POSITION/ENDPOSITION (xyz), LENGTH, LIFETIME, STARTCOLOR(rgba), ENDCOLOR(rgba), THICKNESS, USHIFT, VSHIFT, REPEATRATE, LODCUTOFF`.

### Trails (Ketten-/Poly-Trails)
`TrailEmitterBlueprint` (RTrailBlueprint, size 0x80):
```
TrailEmitterBlueprint {
    BlueprintId = 'aeon_cannon_trail',
    Lifetime = -1.00,
    TrailLength = 10,          # Anzahl Segmente
    Size = 0.12,               # -> StartSize
    SortOrder = 0,
    BlendMode = 0,
    TextureRepeatRate = 1,
    LODCutoff = 160,
    RepeatTexture = [[/textures/particles/trail_white_01.dds]],
    RampTexture   = [[/textures/particles/ramp_trail_01.dds]],
}
```
Runtime `CEfxTrailEmitter` (size 0x1B8): `mTrailLength`, `mTotalTicks`, `mLife`, `mLength`. Render: `TPolyTrail_<BLEND>`, PS = `tex2D(Ramp, uv1) * tex2D(RepeatTex, uv0)`. Additionally `EmitIfVisible`, `CatchupEmit`.

## 2. Projectile trails
`mohodata.scd → lua/sim/DefaultProjectiles.lua` — drei orthogonale Mechanismen, oft kombiniert:
- **`FxTrails`** = List of *EmitterBlueprints* (particle smoke plume), in `OnCreate`: `CreateEmitterOnEntity(self, army, fx):ScaleEmitter(FxTrailScale):OffsetEmitter(0,0,FxTrailOffset)`. Default `'/effects/emitters/missile_munition_trail_01_emit.bp'`.
- **`PolyTrail` / `PolyTrails` + `PolyTrailOffset` + `RandomPolyTrails`** = *TrailEmitterBlueprints* via `CreateTrail(self, -1, army, bp):OffsetEmitter(0,0,off)`.
- **`Beams` / `BeamName`** = *BeamBlueprints* via `CreateBeamEmitterOnEntity(self, -1, army, bp)`.

Class hierarchy: `Projectile` → `EmitterProjectile` → {`SingleBeamProjectile`, `MultiBeamProjectile`, `SinglePolyTrailProjectile`, `MultiPolyTrailProjectile`} → {`SingleCompositeEmitterProjectile`, `MultiCompositeEmitterProjectile`}; plus `OnWaterEntryEmitterProjectile` (trail change when water enters, `TrailDelay`, `EnterWaterSound`).

## 3rd magnitude
- **2,724** Emitter Family Blueprints (2437 Emitter / 184 Trail / 103 Beam) — all in `effects.scd`.
- **747** Partikeltexturen (`textures.scd → textures/particles/`), inkl. `ramp_*.dds` Farbrampen.
- **~586** top-level templates in `lua/EffectTemplates.lua` (180 KB), which bundle emitter paths into effect lists (e.g. `FireCloudMed01`, `ConcussionRingSml01`, `DefaultHitExplosion01`).
- **335** weitere Effekt-Entities (`effects/Entities/*` — Meshes + `_proj.bp` + `_script.lua`), plus `effects/Explosion`, `effects/Nuke`, `effects/QuantumWarhead`, `effects/EMPFluxWarhead`.
- 11 `.fx`-Shader in effects.scd (`particle.fx`, `mesh.fx`, `terrain.fx`, `water2.fx`, `sky.fx`, `ui.fx`, `vision.fx`, `cartographic.fx`, `range.fx`, `primbatcher.fx`, `frame.fx`).

### Engine Lua API (Effects)
From `EffectLuaStartupRegistrations.cpp` (help texts 1:1):
```
CreateEmitterAtEntity(entity, army, emitter_bp_name)
CreateEmitterOnEntity(entity, army, emitter_bp_name)
CreateEmitterAtBone(entity, bone, army, emitter_blueprint)
CreateAttachedEmitter(entity, bone, army, emitter_blueprint)
CreateTrail(entity, bone, army, trail_blueprint)
CreateBeamEmitter(blueprint, army)
CreateBeamEmitterOnEntity(entity, tobone, army, blueprint)
CreateBeamEntityToEntity(entity, bone, other, bone, army, blueprint)
CreateAttachedBeam(entity, bone, army, length, thickness, texture_filename)
CreateBeamToEntityBone(entity, bone, other, bone, army, thickness, texture_filename)
AttachBeamEntityToEntity(self, bone, other, bone, army, blueprint)
AttachBeamToEntity(emitter, entity, tobone, army)
CreateLightParticle(entity, bone, army, size, lifetime, textureName, rampName)
CreateLightParticleIntel(...)
CreateDecal(position, heading, tex1, tex2, type, sizeX, sizeZ, lodParam, duration, army, fidelity)
CreateSplat(position, heading, textureName, sizeX, sizeZ, lodParam, duration, army, fidelity)
CreateSplatOnBone(boneName, offset, textureName, sizeX, sizeZ, lodParam, duration, army)
# Methods on the returned effect (chainbar):
effect:SetEmitterParam('name', value)
effect:SetBeamParam('name', value)
effect:ScaleEmitter(scale)
effect:OffsetEmitter(x, y, z)
effect:ResizeEmitterCurve(parameter, time_in_ticks)
effect:SetEmitterCurveParam(param_name, height, size)   # height=y, size=z(Spread)
effect:Destroy()
```
`bone = -1` bedeutet Entity-Root.

### How unit/weapon scripts reference effects
- `lua/EffectTemplates.lua` defines tables from path strings, e.g.
  `FireCloudMed01 = { EmtBpPath..'fire_cloud_06_emit.bp', EmtBpPath..'explosion_fire_sparks_01_emit.bp' }` mit `EmtBpPath = '/effects/emitters/'`; Kombination via `TableCat(...)`.
- `lua/EffectUtilities.lua` is the distribution layer: `CreateEffects(obj,army,tbl)`, `CreateEffectsWithOffset`, `CreateEffectsWithRandomOffset`, `CreateBoneEffects(obj,bone,army,tbl)`, `CreateBoneEffectsOffset`, `CreateBoneTableEffects`, `CreateRandomEffects`, `ScaleEmittersParam` — all iterate the template table and call `CreateEmitterAtEntity/AtBone/OnEntity`.
- **Muzzle flash**: `mohodata → lua/sim/defaultweapons.lua`, `PlayFxMuzzleSequence(muzzle)` → `for k,v in self.FxMuzzleFlash do CreateAttachedEmitter(self.unit, muzzle, army, v):ScaleEmitter(self.FxMuzzleFlashScale) end`. Analogous to `FxChargeMuzzleFlash`, `FxRackChargeMuzzleFlash`.
- **Explosions/Impacts**: `lua/defaultexplosions.lua` (`CreateDefaultHitExplosion`, `CreateScalableUnitExplosion`, `CreateFlash`, `CreateDebrisProjectiles`, …) uses `EffectTemplate.*` + `CreateEffects*`.
- **Collision-Beams**: `lua/defaultcollisionbeams.lua` + `mohodata → lua/sim/CollisionBeam.lua`.

## 4. AUDIO

### Ablageort & Format
**Important:** there is **no** `sounds.scd`. All audio data is in the directory uncompressed
`<FA>/sounds/`:
- 78 × `*.xwb` — XACT Wave Banks (Magic `WBND`)
- 80 × `*.xsb` — XACT Sound Banks (Magic `SDBK`)
- 1 × `SupCom.xgs` —
- `<FA>/sounds/Voice/{US,DE}/` — Voice banks.

Engine (`AudioEngine.cpp:3618 func_LoadSoundPath`): `EnumerateFiles(voicePath, "*.xwb", false, …)` then `"*.xsb"`; `CUserSoundManager` ctor: `mVoiceEngine(AudioEngine::Create("/sounds"))`; `func_InitSound` loads `/sounds/SupCom.xgs` via the VFS. Other engines: `mAmbientEngine`, `mTutorialEngine`.

### XWB-Header (Hex-verifiziert, Explosions.xwb / Music.xwb / UEL.xwb)
```
0x00  char[4]  "WBND"          (57 42 4E 44)
0x04  u32      dwVersion        = 43 (0x2B)
0x08  u32      dwHeaderVersion  = 42 (0x2A)
0x0C  Segment[5] { u32 offset; u32 length; }   // BANKDATA, ENTRYMETADATA, SEEKTABLES, ENTRYNAMES, ENTRYWAVEDATA
      -> BANKDATA @0x34 len 0x60; ENTRYMETADATA @0x94; ENTRYNAMES len 0 (!); ENTRYWAVEDATA am Ende
BANKDATA @0x34:
  0x34 u32 dwFlags            (0x00080000 = SEEKTABLES/in-memory; 0x00080001 = + STREAMING bei Music/…Stream)
  0x38 u32 dwEntryCount       (Explosions=13, UEL=87, Music=12)
  0x3C char[64] szBankName    ("Explosions", "UEL", "Music")
  0x7C u32 dwEntryMetaDataElementSize = 24
  0x80 u32 dwEntryNameElementSize     = 64
0x84 u32 dwAlignment (4 for in-memory, 2048 for streaming bank)
  0x88 u32 CompactFormat      = 0
  0x8C FILETIME BuildTime
ENTRYMETADATA: 24 B je Eintrag:
  u32 dwFlagsAndDuration   (Duration = >>4)
  u32 Format (MINIWAVEFORMAT, gepackt)
  u32 PlayRegion.dwOffset  (relativ zu ENTRYWAVEDATA.offset)
  u32 PlayRegion.dwLength
  u32 LoopRegion.dwStartSample
  u32 LoopRegion.dwTotalSamples
MINIWAVEFORMAT Bitfelder: tag[1:0], channels[4:2], samplesPerSec[22:5], blockAlign[30:23], bitsPerSample[31]
```
**Measured values:** ALL banks `tag=0` = **PCM**, `bits=1` = **16 bit**.
- SFX/Explosions/Units: 1 channel, 32000 Hz, blockAlign 2 (e.g. `0x810FA004`).
- Music: 2 channels, 44100 Hz, blockAlign 4 (`0x82158888`), streaming bank, alignment 2048.
- `ENTRYNAMES` segment is empty ⇒ Waves have **no names**, only indices; the names come from the `.xsb`.

⇒ **Extraction is trivial**: Bytes `[waveDataOffset + PlayRegion.dwOffset, +dwLength)` are raw PCM16-LE; just put a 44-byte RIFF/WAVE header in front of it. **No codec, no XMA/ADPCM/WMA.**

### XSB-Header (Hex-verifiziert, Explosions.xsb / Music.xsb)
```
0x00  char[4] "SDBK"           (53 44 42 4B)
0x04  u16 toolVersion   = 43
0x06  u16 formatVersion = 43
0x08  u16 crc
0x0A  u32 lastModifiedLow
0x0E  u32 lastModifiedHigh
0x12  u8  platform (=1)
0x13  u16 numSimpleCues        (FA: 0)
0x15  u16 numComplexCues       (Explosions=9, Music=3)
0x17  u16 unknown
0x19  u16 hashBuckets          (KORRIGIERT: Zahl der Cue-Name-Hash-Buckets, NICHT "numTotalCues" — Music hat hier 16 bei 3 Cues; gemessen beim Parser-Bau)
0x1B  u8  numWaveBanks         (Explosions=2 -> Explosions + ExplosionsStream)
0x1C  u16 numSounds            (Explosions=10, Music=3)
0x1E  u32 cueNamesLength
0x22  u32 simpleCuesOffset     (0xFFFFFFFF wenn keine)
0x26  u32 complexCuesOffset
0x2A u32 cueNamesOffset (zero-separated ASCII list, length = cueNamesLength)
0x2E  u32 unknownOffset
0x32  u32 variationTablesOffset
0x36  u32 unknownOffset2
0x3A  u32 waveBankNameTableOffset   (64 Byte pro Bankname)
0x3E  u32 cueNameHashTableOffset
0x42  u32 cueNameHashValsOffset
0x46  u32 soundsOffset
0x4A  char[64] soundBankName
```
Beispiel Explosions.xsb (1253 B): waveBanks = `Explosions`, `ExplosionsStream`; Cues = `Explosion_Medium, Expl_Water_Lrg_01, Expl_Water_Lrg_02, UEF_Nuke_Impact, Aeon_Nuke_Impact, Cybran_Nuke_Impact, Explosion_Large_01, Explosion_Bomb, Expl_Anti_Nuke`.
Music.xsb: `Main_Menu, Base_Building, Battle`.
**Total 1896 cues across all 80 .xsb.** The Cue→Sound→Clip→Event chain is now COMPLETELY verified and implemented (src/formats/xsb.ts, measured byte-precise against all 100 .xsb including voice; end position == entryLength for all 4446 sounds; XACT 3.0 has 5-byte clip meta without filter fields, event type 4 = PlayWave + 7-byte pitch/vol variation — own discovery, differs from the XACT 3.4 references). Resolution Traps: XAS_Weapons.xwb is internally named `XAS_Weapon` (resolve via INNER bank name); XAA.xsb references UAA across banks.

### Referencing from blueprints
Global Lua function `Sound{}` (`cfunc_SoundL`, builds `CSndParams` from `{Cue, Bank, LodCutoff}`); additionally `RPCSound{}` (with RPC loop variable) and `GetCueBank()`.
```lua
-- units/UEL0201/UEL0201_unit.bp
Audio = {
    AmbientMove = Sound { Bank = 'UEL',        Cue = 'UEL0201_Move_Loop',  LodCutoff = 'UnitMove_LodCutoff' },
    StartMove   = Sound { Bank = 'UEL',        Cue = 'UEL0201_Move_Start', LodCutoff = 'UnitMove_LodCutoff' },
    StopMove    = Sound { Bank = 'UEL',        Cue = 'UEL0201_Move_Stop',  LodCutoff = 'UnitMove_LodCutoff' },
    Destroyed   = Sound { Bank = 'UELDestroy', Cue = 'UEL_Destroy_Med_Land', LodCutoff = 'UnitMove_LodCutoff' },
    UISelection = Sound { Bank = 'Interface',  Cue = 'UEF_Select_Tank',    LodCutoff = 'UnitMove_LodCutoff' },
},
Weapon = { { Audio = { Fire = Sound { Bank='UELWeapon', Cue='UEL0201_Cannon_Sgl', LodCutoff='Weapon_LodCutoff' } } } }
```
`CSndParams` (size 0x50): `mBank` (string), `mCue` (string), `mLodCutoff` (CSndVar*), `mRpcLoopVariable`, lazily resolved `mBankId`/`mCueId` (u16). `LodCutoff` is the **name of an XACT variable** from `SupCom.xgs` (e.g. `UnitMove_LodCutoff`, `Weapon_LodCutoff`), not a numerical value.

Bank naming convention: `U<Faction><Domain>` — `UEL/UEA/UEB/UES` (UEF Land/Air/Building/Sea), `UAL/UAA/…` (Aeon), `URL/URA/…` (Cybran), `XS*` (Seraphim), `X??` (FA extensions); plus `…Weapon`, `…Destroy`, `…Stream` variants; global: `Interface`, `Explosions`, `Impacts`, `UnitsGlobal`, `UnitRumble`, `Music`, `AmbientTest`, `Op_Briefing`, `FMV_BG`, `*Select`.

### Sound-Lua-API
User-Layer (`CUserSoundManager.cpp`):
`handle = PlaySound(sndParams, prepareOnly)`, `StartSound(handle)`, `bool = SoundIsPrepared(handle)`, `StopSound(handle, [immediate=false])`, `StopAllSounds`, `PauseSound(category, bPause)`, `PauseVoice(category, bPause)`, `SetVolume(category, volume)`, `float GetVolume(category)`, `DisableWorldSounds`, `EnableWorldSounds`, `PlayVoice(params, duck)`, `PlayTutorialVO(params)`.
Sim-Layer (`Sim.cpp`): `handle = PlayLoop(self, sndParams)`, `StopLoop(self, handle)`.
Entity methods (`Entity.cpp`): `PlaySound`, `SetAmbientSound`. Weapon (`UnitWeapon.cpp`): `PlaySound`. Unit scripts use `unit:PlayUnitSound('DeathExplosion')` etc. (Name = Key in `bp.Audio`).
`SAudioRequest` (sim→user Bridge, size 0x1C): `{ Vec3 position, ELayer layer, CSndParams* params, HSound* sound, EAudioRequestType type }` mit `type ∈ {EntitySound=0, StartLoop=1, StopLoop=2}`.

3D Audio: `AudioEngine::Calculate3D(worldPos, engine, cue)` (X3DAudio Emitter/Listener, Doppler, LPF, Reverb). Global XACT variables that the engine sets per frame: `CameraDistance`, `ZoomPercent`, `Angle`. Ducking via `Duck`/`DuckLength` variables (`mDuckMode`, `mActiveDuckingSounds`).

### Open-Source-Parser (Web-Recherche)
- **`unxwb`** (Luigi Auriemma) — the default extractor for XACT Wave Banks; covers WBND/version 43.
- **`xnb_parse`** (fesh0r) — Python: `xnb_parse/xact/xwb.py`, `xsb.py` — clean, readable reference parser for both formats. Good template for a JS/TS port.
- **MonoGame** — has XWB read code (`WaveBank`/`SoundBank` in `MonoGame.Framework/Audio/`); a full-fledged `XactImporter/XactProcessor` was never completed (Issue #2661), but the runtime readers are usable.
- **`XWBTool`** (Microsoft DirectXTK) — official tool, creates/reads XWB; documents the structure.
- **multimedia.cx MultimediaWiki: “XACT”** — the definitive format documentation for WBND and SDBK.
- `towav`/`xma_parse` are only necessary for XMA (Xbox 360) — **irrelevant for FA** since everything is PCM.

**Recommendation:** own small XWB reader (~100 lines, PCM slices → WAV/AudioBuffer) + XSB reader for the cue name table. Since only cue→wave assignment is needed, you can alternatively export all waves as `<Bank>/<CueName>.ogg` offline once with `unxwb`+`xnb_parse` and only load named files in the browser - this bypasses the complex complex cue/variation logic of XACT.

## 5. Musik / Ambient
- **Music**: `lua.scd → lua/UserMusic.lua`. Two cue lists from bank `Music`: `BattleCues = { Sound{Cue='Battle', Bank='Music'} }`, `PeaceCues = { Sound{Cue='Base_Building', Bank='Music'} }`. Logic: `NotifyBattle()` counts combat events; ≥ `BattleEventThreshold = 20` events (reset if > `BattleCounterReset = 30` ticks pause) ⇒ `StartBattleMusic()` (hard cut, `StopSound(Music,true)`); after `PeaceTimer = 200` ticks (20 s) without a fight ⇒ `StartPeaceMusic()` (fade-out via `StopSound(Music)` + `WaitFor(Music)`, 3 s pause, then peace cue). Cues rotate cyclically. `Music.xwb` = 250 MB streaming bank, 12 waves, 44.1 kHz stereo PCM; `Music.xsb` cues: `Main_Menu`, `Base_Building`, `Battle`.
- **Ambient**: `AmbientTest.xsb/.xwb` (Cues: `AMB_Menu_Loop`, `Gen_Fire_Loop`, `Gen_Fire_Start`, `Gen_Tree_Crush`, `AMB_Planet_Rumble_zoom`, `AMB_SER_OP_Briefing`); `gamedata/ambience.scd` is **empty** (just a directory entry) — so ambient loops run via the normal bank/cue paths + `mAmbientEngine` in the `CUserSoundManager`.
- **Unit Ambient Loops**: `bp.Audio.AmbientMove` etc. → `Entity:SetAmbientSound(params)` or sim-side `PlayLoop(self, params)`; `HSound` is the loop handle with intrusive list in `CSimSoundManager`, `UpdateLoopCompletionState()` signals end. `UnitRumble.xsb/.xwb` provides distance/zoom dependent rumble loops (modulated via the XACT variables `CameraDistance`/`ZoomPercent`).
- **UI**: `Interface.xsb` (119 Cues: `UI_Menu_Accept_01`, `UI_Menu_Rollover`, `UEF_Select_Tank`, …). Faction select banks: `AEONSelect.xwb`, `CYBRANSelect.xwb`, `UEFSelect.xwb`, `SeraphimSelect.xwb/.xsb`.

## Refs
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\REmitterBlueprint.h:144 (REmitterBlueprint, 21 curves + flags + textures, size 0x284)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RTrailBlueprint.h:28 (RTrailBlueprint, size 0x80)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RBeamBlueprint.h:28 (RBeamBlueprint, size 0x84)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\REffectBlueprint.h:23 (Base: BlueprintId + High/Med/LowFidelity)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\SEfxCurve.cpp:319 (SEfxCurve::GetValue — Interpolation + Zufalls-Spread)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\SEfxCurve.h:29
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEfxEmitter.h:52 (CEfxEmitter, size 0x6F8)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEfxTrailEmitter.h:29 (size 0x1B8)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEfxBeam.h:15 (size 0x298)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\EffectLuaStartupRegistrations.cpp:53-106 (all Create*-Lua signatures), :1940/:2253/:2273/:2293/:2313 (SetEmitterParam/ScaleEmitter/ResizeEmitterCurve/SetEmitterCurveParam/OffsetEmitter)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEffectManagerImpl.h:47-165 (CreateEmitter/CreateAttachedEmitter/CreateEmitterAtBone/CreateTrail/CreateBeam/CreateLightParticle)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\render\EEmitterCurve.h (21 Kurven-Lanes), EEmitterParam.h (26 Skalar-Lanes), EBeamParam.h (21 Beam-Lanes)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\SWorldParticle.h:19 (Runtime-Partikel, size 0x8C)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\SWorldBeam.h:20 (size 0xCC)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\CWorldParticles.cpp:443 (BlendMode -> Technique-Suffix Mapping), :510 (time = tick + frameDelta)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\BeamRenderHelpers.cpp:2024-2048 (TBeam_OneTexture/TwoTexture Technique-Auswahl)
- C:\Users\Marti\Documents\02Projects\faf\Draiget\faf-re\src\sdk\moho\audio\CSndParams.h:117 (mBank/mCue/mLodCutoff/mBankId/mCueId), :168 (cfunc_SoundL builds CSndParams from {Cue,Bank,LodCutoff})
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\AudioEngine.cpp:3618 (func_LoadSoundPath: *.xwb + *.xsb enumerieren), :4099 (/sounds/SupCom.xgs)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\AudioEngine.h:38-205 (IXACTSoundBank/IXACTCue/IXACTEngine ABI), :493 GetBankIndex, :503 GetCueIndex, :590 Calculate3D
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\CUserSoundManager.cpp:55-67 (Lua-Hilfetexte PlaySound/StopSound/SetVolume/PlayVoice), :1239 (AudioEngine::Create("/sounds"))
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\SAudioRequest.h:24 (EAudioRequestType: EntitySound/StartLoop/StopLoop)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:1143 (PlayLoop(self,sndParams) / StopLoop(self,handle))
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:237 (Entity:PlaySound / Entity:SetAmbientSound)
- ZIP: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\gamedata\effects.scd -> effects/Emitters/*.bp (2724), effects/particle.fx, effects/Entities/*, effects/Explosion|Nuke|QuantumWarhead|EMPFluxWarhead
- ZIP: gamedata/effects.scd -> effects/Emitters/adisruptor_cannon_muzzle_01_emit.bp (EmitterBlueprint-Referenzbeispiel), adjacency_uef_beam_01_emit.bp (BeamBlueprint), aeon_cannon_trail_emit.bp (TrailEmitterBlueprint)
- ZIP: gamedata/mohodata.scd -> lua/system/Blueprints.lua (EmitterBlueprint/BeamBlueprint/TrailEmitterBlueprint registration, LoadBlueprints)
- ZIP: gamedata/mohodata.scd -> lua/sim/DefaultProjectiles.lua (FxTrails/PolyTrails/Beams), lua/sim/defaultweapons.lua:169 PlayFxMuzzleSequence, lua/sim/CollisionBeam.lua
- ZIP: gamedata/lua.scd -> lua/EffectTemplates.lua (180 KB, ~586 Templates), lua/EffectUtilities.lua (56 KB), lua/defaultexplosions.lua, lua/defaultcollisionbeams.lua, lua/UserMusic.lua
- ZIP: gamedata/textures.scd -> textures/particles/ (747 files, incl. ramp_*.dds)
- ZIP: gamedata/units.scd -> units/UEL0201/UEL0201_unit.bp (Audio = { ... Sound{Bank,Cue,LodCutoff} })
- Files: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\sounds\ (78 x .xwb, 80 x .xsb, SupCom.xgs, Voice/US, Voice/DE) — hex checked: Explosions.xwb, Music.xwb, UEL.xwb, Explosions.xsb, Music.xsb, SupCom.xgs
- Web: https://wiki.multimedia.cx/index.php/XACT (WBND/SDBK Formatdoku)
- Web: https://github.com/fesh0r/xnb_parse/blob/master/xnb_parse/xact/xwb.py (Python XWB/XSB Parser)
- Web: https://github.com/microsoft/DirectXTK/wiki/XWBTool (offizielles XWB-Tool)
- Web: https://github.com/MonoGame/MonoGame/issues/2661 (MonoGame XactImporter/XactProcessor Status)
- Scratchpad extracts: C:\Users\Marti\AppData\Local\Temp\claude\c--Users-Marti-Documents-02Projects-Claude-Commander-Forged-Alliance\795d25b0-6aed-4269-81c5-1f3b66283dbf\scratchpad\{particle.fx, EffectTemplates.lua, EffectUtilities.lua, defaultexplosions.lua, defaultcollisionbeams.lua, DefaultProjectiles.lua, CollisionBeam.lua, Blueprints.lua, UserMusic.lua}
