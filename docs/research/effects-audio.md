# agent5

## Summary
Effekte in SupCom:FA sind vollständig datengetrieben: 2.724 Effekt-Blueprints (Lua-DSL-Dateien `*_emit.bp` in `effects.scd`) in drei Typen — EmitterBlueprint (Partikel, 2.437), TrailEmitterBlueprint (Poly-Trails, 184), BeamBlueprint (Beams, 103). Ein Emitter ist im Kern eine Textur + Ramp-Textur + 21 Kurven (je `XRange` + Keys `{x=Zeit_in_Ticks, y=Mittelwert, z=Zufalls-Spread}`) + 13 Flags; die Partikel-Integration (Position, Rotation, Größe, Frame-Animation, Alpha=t/lifetime→Ramp-U) passiert komplett analytisch im Vertex-Shader (`effects/particle.fx`), d.h. sie ist 1:1 in WebGL/WebGPU nachbaubar. Lua-Skripte referenzieren Emitter nur über Pfad-Strings, gebündelt in `lua/EffectTemplates.lua` (~586 Templates) und erzeugt über Engine-Funktionen `CreateEmitterAtBone/CreateAttachedEmitter/CreateTrail/CreateBeamEmitterOnEntity`. Audio ist XACT3: 78 `.xwb` Wave Banks + 80 `.xsb` Sound Banks + `SupCom.xgs` unter `<FA>/sounds/` (NICHT in einer .scd!) — alle Waves sind unkomprimiertes PCM16 (32 kHz mono SFX / 44,1 kHz Stereo Musik), Extraktion ist trivial; Blueprints referenzieren Sounds als `Sound { Bank='UEL', Cue='UEL0201_Move_Loop', LodCutoff='UnitMove_LodCutoff' }`, insgesamt 1.896 Cues.

## Key Facts
- Emitter-Blueprints liegen NUR in gamedata/effects.scd unter effects/Emitters/ — 2724 Dateien: 2437 EmitterBlueprint, 184 TrailEmitterBlueprint, 103 BeamBlueprint (keine _emit.bp in units/projectiles/env.scd).
- Das .bp-Format ist reines Lua: die Datei ruft die globale Funktion EmitterBlueprint{...} / TrailEmitterBlueprint{...} / BeamBlueprint{...} auf (definiert in mohodata.scd → lua/system/Blueprints.lua); BlueprintId defaultet auf den kleingeschriebenen Dateipfad.
- Ein EmitterBlueprint hat 21 Kurven (SizeCurve, X/Y/ZDirectionCurve, EmitRateCurve, LifetimeCurve, VelocityCurve, X/Y/ZAccelCurve, ResistanceCurve, Start/EndSizeCurve, InitialRotationCurve, RotationRateCurve, FrameRateCurve, TextureSelectionCurve, X/Y/ZPosCurve, RampSelectionCurve) — jede mit XRange + Keys {x,y,z}.
- Kurven-Auswertung (SEfxCurve::GetValue): lineare Interpolation von y UND z zwischen den Keys, dann Rückgabe (rand()-0.5)*z + y — z ist also die Zufalls-Streubreite, nicht ein dritter Wert.
- Zeiteinheit aller Kurven/Lifetimes sind Sim-Ticks (10/s); der Shader bekommt time = tick + frameDelta. Lifetime = -1 bedeutet unendlich.
- Die komplette Partikel-Physik steckt im Vertex-Shader effects/particle.fx: ohne Drag pos = P0 + V*t + 0.5*A*t^2, mit Drag (ParticleResistance) pos = (dz*A - dy*V)*(e^(-dx*t)-1) + dy*A*t + P0; Größe = Size.x + Size.y*t; Rotation = angle0 + rotRate*t.
- Farbe = Partikeltextur * Ramp-Textur; die Ramp wird mit U = t/lifetime und V = RampSelection gesampelt (Ramp kodiert Farbe+Alpha über die Lebenszeit). 747 Partikeltexturen liegen in textures.scd unter textures/particles/.
- BlendMode-Mapping (aus CWorldParticles.cpp ResolveParticleTechniqueSuffix): 0=ALPHABLEND, 1=MODULATEINVERSE, 2=MODULATE2XINVERSE, 3=ADD, 4=PREMODALPHA, 5=REFRACT. Häufigster Wert in den Daten ist 3 (ADD, ~1744x), dann 0 (~658x).
- Trails (TrailEmitterBlueprint) sind Ribbon/Poly-Trails mit TrailLength, Size, TextureRepeatRate, RepeatTexture + RampTexture — erzeugt per CreateTrail(entity,bone,army,bp).
- Projektil-Trails: lua/sim/DefaultProjectiles.lua definiert FxTrails (Liste von EmitterBlueprints via CreateEmitterOnEntity), PolyTrail/PolyTrails (TrailEmitterBlueprints via CreateTrail) und Beams (BeamBlueprints via CreateBeamEmitterOnEntity) — Klassen EmitterProjectile, SinglePolyTrailProjectile, MultiCompositeEmitterProjectile usw.
- Mündungsfeuer: lua/sim/defaultweapons.lua PlayFxMuzzleSequence -> CreateAttachedEmitter(unit, muzzleBone, army, v):ScaleEmitter(FxMuzzleFlashScale) über die Tabelle FxMuzzleFlash (typischerweise ein EffectTemplate).
- Einschläge/Explosionen: lua/defaultexplosions.lua + lua/EffectUtilities.lua (CreateEffects, CreateBoneEffects, CreateEffectsWithOffset, CreateRandomEffects) iterieren über EffectTemplate-Tabellen aus lua/EffectTemplates.lua (~586 Template-Tabellen, 180 KB, Pfade zusammengesetzt aus EmtBpPath='/effects/emitters/').
- Sounds liegen NICHT in einer .scd, sondern im Klartext-Ordner <FA>/sounds/: 78 *.xwb, 80 *.xsb, 1 SupCom.xgs, plus sounds/Voice/{US,DE}. Engine: AudioEngine::Create("/sounds") enumeriert *.xwb und *.xsb und lädt SupCom.xgs.
- XWB-Header ist 'WBND' (Version 43 / HeaderVersion 42) mit 5 Segmenten (BANKDATA@0x34, ENTRYMETADATA@0x94, SEEKTABLES, ENTRYNAMES, ENTRYWAVEDATA); Entry-Metadaten sind 24 Byte je Eintrag (Duration, MiniWaveFormat, PlayRegion-Offset+Länge).
- ALLE FA-Waves sind PCM (formatTag=0), 16 bit: SFX 32000 Hz mono (blockAlign 2), Musik 44100 Hz stereo (blockAlign 4, streaming-Bank mit alignment 2048) — kein XMA/ADPCM/WMA, also kein Decoder nötig, nur WAV-Header davorschreiben.
- XSB-Header ist 'SDBK' (Tool/Format-Version 43); Felder: numSimpleCues@0x13, numComplexCues@0x15, numWaveBanks@0x1B, numSounds@0x1C, cueNamesLength@0x1E, simpleCuesOffset@0x22, complexCuesOffset@0x26, cueNamesOffset@0x2A, waveBankNameTableOffset@0x3A (64 Byte/Name), soundsOffset@0x46, soundBankName@0x4A (64 Byte). Cue-Namen sind eine null-getrennte Stringliste.
- Blueprint-Sound-Referenz: Audio = { AmbientMove = Sound { Bank='UEL', Cue='UEL0201_Move_Loop', LodCutoff='UnitMove_LodCutoff' }, ... }; die globale Lua-Funktion Sound{} baut ein CSndParams (mBank, mCue, mLodCutoff) und löst zur Laufzeit BankId+CueId auf. Insgesamt 1896 Cues über alle 80 .xsb.
- Sound-Lua-API: user-side PlaySound(sndParams, prepareOnly) / StopSound(handle,[immediate]) / SetVolume(category,vol) / PlayVoice(params,duck); sim-side PlayLoop(self,sndParams) / StopLoop(self,handle); Entity hat PlaySound und SetAmbientSound, Weapon hat PlaySound(bp.Audio.Fire).
- Musiksystem: lua/UserMusic.lua — Battle- und Peace-Cues aus Bank 'Music' (Cues: Main_Menu, Base_Building, Battle), Umschaltung nach 20 Battle-Events, Rückschaltung nach 200 Ticks Ruhe; Ducking ist in CUserSoundManager per XACT-Variablen 'Duck'/'DuckLength' implementiert.

## Details
## 1. Partikel/Emitter — Format & Parameter

### Dateiformat
`gamedata/effects.scd` (ZIP) → `effects/Emitters/*.bp`. Klartext-Lua, Aufruf einer globalen Konstruktorfunktion:

- `EmitterBlueprint { ... }` — 2437 Dateien
- `TrailEmitterBlueprint { ... }` — 184 Dateien
- `BeamBlueprint { ... }` — 103 Dateien
- Gesamt 2724 (davon 2702 mit Suffix `_emit.bp`, 22 ohne).

Registrierung in `mohodata.scd → lua/system/Blueprints.lua`: `LoadBlueprints()` scannt `/effects,/env,/meshes,/projectiles,/props,/units` nach `*.bp` und führt sie als Lua aus; die Funktionen `EmitterBlueprint/BeamBlueprint/TrailEmitterBlueprint` legen sie in `original_blueprints.{Emitter,Beam,TrailEmitter}` ab; `BlueprintId` = lowercase Quellpfad (also `/effects/emitters/xyz_emit.bp`) sofern nicht explizit gesetzt. Danach `RegisterEmitterBlueprint()` etc. an die Engine.

### EmitterBlueprint-Felder (verifiziert gegen REmitterBlueprint, size 0x284)
Basis `REffectBlueprint`: `BlueprintId`, `HighFidelity/MedFidelity/LowFidelity` (bool, default 1).

Skalare / Flags:
| Feld | Default | Bedeutung |
|---|---|---|
| `Lifetime` | 0 | Emitter-Lebensdauer in Ticks; `-1` = unendlich |
| `Repeattime` | 0 | Zyklus-Länge (Kurven-XRange-Bezug) |
| `TextureFramecount` | 0 | Frames im Textur-Strip (>1 ⇒ „Animate"-Technique) |
| `TextureStripcount` | 1 | Anzahl Zeilen (Textur-Varianten) in der Textur |
| `Blendmode` | 0 | 0..5 (siehe unten) |
| `SortOrder` | 0 | Render-Sortierung |
| `LODCutoff` | 100 | Kamera-Distanz-Cutoff |
| `LocalVelocity` | true | Velocity im lokalen Bone-Space |
| `LocalAcceleration` | false | |
| `Gravity` | false | |
| `AlignRotation` | false | ⇒ Technique „Align" (Quad an Bewegungsrichtung) |
| `AlignToBone` | false | ⇒ Technique „AlignToBone" |
| `Flat` | false | ⇒ Technique „Flat" (XZ-Ebene statt Billboard) |
| `EmitIfVisible` | true | |
| `CatchupEmit` | true | |
| `CreateIfVisible` | false | |
| `ParticleResistance` | false | ⇒ Drag-Modell im Shader |
| `InterpolateEmission` | true | Partikel entlang Bewegungsspur zwischen Ticks verteilen |
| `SnapToWaterline` | true | |
| `OnlyEmitOnWater` | false | |
| `Texture` | '' | z.B. `/textures/particles/line_white_add_06.dds` |
| `RampTexture` | '' | z.B. `/textures/particles/ramp_antimatter_01.dds` |

### Die 21 Kurven
Reihenfolge laut `REmitterBlueprint` bzw. Enum `EEmitterCurve`:
`SizeCurve, XDirectionCurve, YDirectionCurve, ZDirectionCurve, EmitRateCurve, LifetimeCurve, VelocityCurve, XAccelCurve, YAccelCurve, ZAccelCurve, ResistanceCurve, StartSizeCurve, EndSizeCurve, InitialRotationCurve, RotationRateCurve, FrameRateCurve, TextureSelectionCurve, XPosCurve, YPosCurve, ZPosCurve, RampSelectionCurve`

Jede Kurve:
```
EmitRateCurve = { XRange = 4.00, Keys = { { x=2.044, y=25.643, z=0.000 }, ... } }
```
- `XRange` = Zeitachsen-Länge (Ticks), meist == `Repeattime`.
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
(Datei: `faf-re/src/sdk/moho/effects/rendering/SEfxCurve.cpp:319`)

In der eigenen Decomp verifiziert (Cfile/ForgedAlliance.exe.c) und als
`src/effects/curves.ts` umgesetzt (Suite: `scripts/verify-emitter-curves.ts`):
- `Moho::SEfxCurve::GetValue` @0x514E50, Cfile:649014-649070. 0 Keys → 0.0
  (:649030-649031); Scan `while (key.x <= t)` (:649049); t vor dem ersten Key
  → Clamp auf first.y/z (:649054-649058); t auf/hinter dem letzten Key →
  Clamp auf last.y/z (:649036-649045); sonst `(rand-0.5)*(preZ+(curZ-preZ)*f)
  + f*(curY-preY) + preY` (:649065-649067). rand = Mersenne-Twister × 2^-32,
  Bereich [0,1), EIN Zug pro Aufruf (func_RandomFloatSafe :648929-648937).
- GetValue bricht die Zeit NICHT um und liest XRange nicht. Der zyklische
  Umbruch steht beim AUFRUFER: `t = fmod(TICKCOUNT - tick, Repeattime)` plus
  Vorzeichen-Korrektur (floored modulo), Cfile:894655-894661 (EmitRate) bzw.
  :894693-894698 (pro Partikel). `Repeattime = 0` → fmod = NaN → GetValue
  clampt auf den ersten Key.
- `func_MakeEmitterCurve` Cfile:649226-649274 baut die Laufzeit-Kurve:
  Keys werden sortiert eingefügt (stabil aufsteigend nach x, sub_5151B0
  :649185-649191); Kurve ohne Keys → Default XRange=10, ein Key {5,0,0}
  (:649264-649271). In den echten Daten: 0 unsortierte Kurven, 159 Kurven
  mit doppeltem x (Ergebnis dort = y des LETZTEN Keys mit gleichem x).
- Blueprint-Feldreihenfolge der 21 Kurven: `REmitterBlueprint::Init`
  Cfile:645017-645079 (= Liste oben). Die Laufzeit-Lanes (`mCurves`,
  CEfxEmitter-Ctor Cfile:893987-894008) sind anders sortiert: XDir, YDir,
  ZDir, EmitRate, Lifetime, Velocity, XAccel, YAccel, ZAccel, Resistance,
  Size, XPos, YPos, ZPos, StartSize, EndSize, InitialRotation, RotationRate,
  FrameRate, TextureSelection, RampSelection.

Emitter-Laufzeit-Skalare (Enum `EEmitterParam`, per `effect:SetEmitterParam('name',v)` setzbar): `POSITION_X/Y/Z, TICKCOUNT, LIFETIME, REPEATTIME, TICKINCREMENT, BLENDMODE, FRAMECOUNT, USE_LOCAL_VELOCITY, USE_LOCAL_ACCELERATION, USE_GRAVITY, ALIGN_ROTATION, INTERPOLATE_EMISSION, TEXTURE_STRIPCOUNT, ALIGN_TO_BONE, SORTORDER, FLAT, SCALE, LODCUTOFF, EMITIFVISIBLE, CATCHUPEMIT, CREATEIFVISIBLE, SNAPTOWATERLINE, ONLYEMITONWATER, PARTICLERESISTANCE`.

### Wie die Engine sie abspielt (der entscheidende Teil für den Nachbau)
`effects/particle.fx` (in effects.scd) enthält die komplette Simulation im **Vertex-Shader** `WorldVS`. Pro Partikel-Quad werden folgende Vertex-Attribute geliefert:
`Corner(float2 Quad-Ecke ±1)`, `Pos(float4: xyz=Spawn-Position, w=Startwinkel)`, `Size(float2: x=BeginSize, y=Size-Rate)`, `Velocity(float4: xyz=Geschwindigkeit, w=Rotationsrate)`, `Acceleration(float3)`, `inTime(float4: x=SpawnTime, y=Lifetime, z=Framerate, w=FrameSize)`, `inTexOffset(float3: x=Texturzeilen-Offset, y=Ramp-V, z=Zeilenhöhe)`, `dragCoeff(float3)`.

Globale Shader-Var `time = tick + frameDelta` (Ticks!).
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
Technique-Name = `TRamp` + [`Animate`] + [`Align` | `AlignToBone` | `Flat`] + `_<BLEND>`; zusätzlich `TLight_*` (LightParticle), `TBeam_OneTexture_*` / `TBeam_TwoTexture_*`, `TPolyTrail_*`.

**BlendMode → Render-State** (aus `CWorldParticles.cpp:443 ResolveParticleTechniqueSuffix` + particle.fx):
| Wert | Suffix | Blend (Src, Dst) |
|---|---|---|
| 0 | `_ALPHABLEND` | SrcAlpha, InvSrcAlpha |
| 1 | `_MODULATEINVERSE` | Zero, InvSrcColor |
| 2 | `_MODULATE2XINVERSE` | InvDestColor, InvSrcColor |
| 3 | `_ADD` | SrcAlpha, One |
| 4 | `_PREMODALPHA` | One, InvSrcAlpha |
| 5 | `_REFRACT` | SrcAlpha, InvSrcAlpha + Refraktion (samplet Backbuffer) |
Alle: Depth-Test Less, **kein** Depth-Write, Cull None.
Häufigkeit in den Daten: 3(ADD) ≈1744, 0 ≈658, 1 ≈181, 2 ≈17, 4 ≈26, 5 ≈21.

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
Runtime `SWorldBeam`: Start/End-Transform (mit Last-Transform für Interpolation), Width, StartColor/EndColor (Vector4), 2 Texturen, UShift/VShift/RepeatRate, BlendMode.
Lua: `CreateBeamEmitter(bp,army)`, `CreateBeamEmitterOnEntity(entity,bone,army,bp)`, `CreateBeamEntityToEntity(e,b,other,b,army,bp)`, `CreateAttachedBeam(entity,bone,army,length,thickness,texture)`, `AttachBeamEntityToEntity(...)`. Beam-Params (`effect:SetBeamParam(name,v)`): `POSITION/ENDPOSITION (xyz), LENGTH, LIFETIME, STARTCOLOR(rgba), ENDCOLOR(rgba), THICKNESS, USHIFT, VSHIFT, REPEATRATE, LODCUTOFF`.

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
Runtime `CEfxTrailEmitter` (size 0x1B8): `mTrailLength`, `mTotalTicks`, `mLife`, `mLength`. Render: `TPolyTrail_<BLEND>`, PS = `tex2D(Ramp, uv1) * tex2D(RepeatTex, uv0)`. Zusätzlich `EmitIfVisible`, `CatchupEmit`.

## 2. Trails bei Projektilen
`mohodata.scd → lua/sim/DefaultProjectiles.lua` — drei orthogonale Mechanismen, oft kombiniert:
- **`FxTrails`** = Liste von *EmitterBlueprints* (Partikel-Rauchfahne), in `OnCreate`: `CreateEmitterOnEntity(self, army, fx):ScaleEmitter(FxTrailScale):OffsetEmitter(0,0,FxTrailOffset)`. Default `'/effects/emitters/missile_munition_trail_01_emit.bp'`.
- **`PolyTrail` / `PolyTrails` + `PolyTrailOffset` + `RandomPolyTrails`** = *TrailEmitterBlueprints* via `CreateTrail(self, -1, army, bp):OffsetEmitter(0,0,off)`.
- **`Beams` / `BeamName`** = *BeamBlueprints* via `CreateBeamEmitterOnEntity(self, -1, army, bp)`.

Klassenhierarchie: `Projectile` → `EmitterProjectile` → {`SingleBeamProjectile`, `MultiBeamProjectile`, `SinglePolyTrailProjectile`, `MultiPolyTrailProjectile`} → {`SingleCompositeEmitterProjectile`, `MultiCompositeEmitterProjectile`}; dazu `OnWaterEntryEmitterProjectile` (Trail-Wechsel bei Wassereintritt, `TrailDelay`, `EnterWaterSound`).

## 3. Größenordnung
- **2.724** Emitter-Familie-Blueprints (2437 Emitter / 184 Trail / 103 Beam) — alle in `effects.scd`.
- **747** Partikeltexturen (`textures.scd → textures/particles/`), inkl. `ramp_*.dds` Farbrampen.
- **~586** Top-Level-Templates in `lua/EffectTemplates.lua` (180 KB), die Emitter-Pfade zu Effekt-Listen bündeln (z.B. `FireCloudMed01`, `ConcussionRingSml01`, `DefaultHitExplosion01`).
- **335** weitere Effekt-Entities (`effects/Entities/*` — Meshes + `_proj.bp` + `_script.lua`), plus `effects/Explosion`, `effects/Nuke`, `effects/QuantumWarhead`, `effects/EMPFluxWarhead`.
- 11 `.fx`-Shader in effects.scd (`particle.fx`, `mesh.fx`, `terrain.fx`, `water2.fx`, `sky.fx`, `ui.fx`, `vision.fx`, `cartographic.fx`, `range.fx`, `primbatcher.fx`, `frame.fx`).

### Lua-API der Engine (Effekte)
Aus `EffectLuaStartupRegistrations.cpp` (Hilfetexte 1:1):
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
# Methoden auf dem zurückgegebenen Effekt (chainbar):
effect:SetEmitterParam('name', value)
effect:SetBeamParam('name', value)
effect:ScaleEmitter(scale)
effect:OffsetEmitter(x, y, z)
effect:ResizeEmitterCurve(parameter, time_in_ticks)
effect:SetEmitterCurveParam(param_name, height, size)   # height=y, size=z(Spread)
effect:Destroy()
```
`bone = -1` bedeutet Entity-Root.

### Wie Unit-/Waffen-Skripte Effekte referenzieren
- `lua/EffectTemplates.lua` definiert Tabellen aus Pfadstrings, z.B.
  `FireCloudMed01 = { EmtBpPath..'fire_cloud_06_emit.bp', EmtBpPath..'explosion_fire_sparks_01_emit.bp' }` mit `EmtBpPath = '/effects/emitters/'`; Kombination via `TableCat(...)`.
- `lua/EffectUtilities.lua` ist die Verteil-Schicht: `CreateEffects(obj,army,tbl)`, `CreateEffectsWithOffset`, `CreateEffectsWithRandomOffset`, `CreateBoneEffects(obj,bone,army,tbl)`, `CreateBoneEffectsOffset`, `CreateBoneTableEffects`, `CreateRandomEffects`, `ScaleEmittersParam` — alle iterieren die Template-Tabelle und rufen `CreateEmitterAtEntity/AtBone/OnEntity`.
- **Mündungsfeuer**: `mohodata → lua/sim/defaultweapons.lua`, `PlayFxMuzzleSequence(muzzle)` → `for k,v in self.FxMuzzleFlash do CreateAttachedEmitter(self.unit, muzzle, army, v):ScaleEmitter(self.FxMuzzleFlashScale) end`. Analog `FxChargeMuzzleFlash`, `FxRackChargeMuzzleFlash`.
- **Explosionen/Einschläge**: `lua/defaultexplosions.lua` (`CreateDefaultHitExplosion`, `CreateScalableUnitExplosion`, `CreateFlash`, `CreateDebrisProjectiles`, …) verwendet `EffectTemplate.*` + `CreateEffects*`.
- **Collision-Beams**: `lua/defaultcollisionbeams.lua` + `mohodata → lua/sim/CollisionBeam.lua`.

## 4. AUDIO

### Ablageort & Format
**Wichtig:** es gibt **keine** `sounds.scd`. Alle Audiodaten liegen unkomprimiert im Verzeichnis
`<FA>/sounds/`:
- 78 × `*.xwb` — XACT Wave Banks (Magic `WBND`)
- 80 × `*.xsb` — XACT Sound Banks (Magic `SDBK`)
- 1 × `SupCom.xgs` — XACT Global Settings (Magic `XGSF`, 2666 B) — enthält Kategorien (Volume-Gruppen), RPC-Kurven, globale Variablen (`CameraDistance`, `ZoomPercent`, `Duck`, `DuckLength`, `Angle`, `*_LodCutoff`).
- `<FA>/sounds/Voice/{US,DE}/` — Sprachbänke.

Engine (`AudioEngine.cpp:3618 func_LoadSoundPath`): `EnumerateFiles(voicePath, "*.xwb", false, …)` dann `"*.xsb"`; `CUserSoundManager` ctor: `mVoiceEngine(AudioEngine::Create("/sounds"))`; `func_InitSound` lädt `/sounds/SupCom.xgs` über das VFS. Weitere Engines: `mAmbientEngine`, `mTutorialEngine`.

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
  0x84 u32 dwAlignment        (4 für in-memory, 2048 für Streaming-Bank)
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
**Messwerte:** ALLE Banks `tag=0` = **PCM**, `bits=1` = **16 Bit**.
- SFX/Explosions/Units: 1 Kanal, 32000 Hz, blockAlign 2 (z.B. `0x810FA004`).
- Musik: 2 Kanäle, 44100 Hz, blockAlign 4 (`0x82158888`), Streaming-Bank, alignment 2048.
- `ENTRYNAMES`-Segment ist leer ⇒ Waves haben **keine Namen**, nur Indizes; die Namen kommen aus dem `.xsb`.

⇒ **Extraktion ist trivial**: Bytes `[waveDataOffset + PlayRegion.dwOffset, +dwLength)` sind rohes PCM16-LE; nur einen 44-Byte-RIFF/WAVE-Header davorsetzen. **Kein Codec, kein XMA/ADPCM/WMA.**

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
0x2A  u32 cueNamesOffset       (null-getrennte ASCII-Liste, Länge = cueNamesLength)
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
**Gesamt 1896 Cues über alle 80 .xsb.** Die Cue→Sound→Clip→Event-Kette ist inzwischen VOLLSTÄNDIG verifiziert und implementiert (src/formats/xsb.ts, byte-genau gegen alle 100 .xsb inkl. Voice gemessen; Endposition == entryLength für alle 4446 Sounds; XACT 3.0 hat 5-Byte-Clip-Meta ohne Filterfelder, Event-Typ 4 = PlayWave + 7-Byte-Pitch/Vol-Variation — eigener Fund, weicht von den XACT-3.4-Referenzen ab). Auflösungs-Fallen: XAS_Weapons.xwb heißt intern `XAS_Weapon` (über den INNEREN Banknamen auflösen); XAA.xsb referenziert bankübergreifend UAA.

### Referenzierung aus Blueprints
Globale Lua-Funktion `Sound{}` (`cfunc_SoundL`, baut `CSndParams` aus `{Cue, Bank, LodCutoff}`); zusätzlich `RPCSound{}` (mit RPC-Loop-Variable) und `GetCueBank()`.
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
`CSndParams` (size 0x50): `mBank` (string), `mCue` (string), `mLodCutoff` (CSndVar*), `mRpcLoopVariable`, lazily aufgelöste `mBankId`/`mCueId` (u16). `LodCutoff` ist der **Name einer XACT-Variable** aus `SupCom.xgs` (z.B. `UnitMove_LodCutoff`, `Weapon_LodCutoff`), nicht ein Zahlenwert.

Bank-Namenskonvention: `U<Faction><Domain>` — `UEL/UEA/UEB/UES` (UEF Land/Air/Building/Sea), `UAL/UAA/…` (Aeon), `URL/URA/…` (Cybran), `XS*` (Seraphim), `X??` (FA-Erweiterungen); plus `…Weapon`, `…Destroy`, `…Stream`-Varianten; global: `Interface`, `Explosions`, `Impacts`, `UnitsGlobal`, `UnitRumble`, `Music`, `AmbientTest`, `Op_Briefing`, `FMV_BG`, `*Select`.

### Sound-Lua-API
User-Layer (`CUserSoundManager.cpp`):
`handle = PlaySound(sndParams, prepareOnly)`, `StartSound(handle)`, `bool = SoundIsPrepared(handle)`, `StopSound(handle, [immediate=false])`, `StopAllSounds`, `PauseSound(category, bPause)`, `PauseVoice(category, bPause)`, `SetVolume(category, volume)`, `float GetVolume(category)`, `DisableWorldSounds`, `EnableWorldSounds`, `PlayVoice(params, duck)`, `PlayTutorialVO(params)`.
Sim-Layer (`Sim.cpp`): `handle = PlayLoop(self, sndParams)`, `StopLoop(self, handle)`.
Entity-Methoden (`Entity.cpp`): `PlaySound`, `SetAmbientSound`. Weapon (`UnitWeapon.cpp`): `PlaySound`. Unit-Skripte nutzen `unit:PlayUnitSound('DeathExplosion')` etc. (Name = Key in `bp.Audio`).
`SAudioRequest` (sim→user Bridge, size 0x1C): `{ Vec3 position, ELayer layer, CSndParams* params, HSound* sound, EAudioRequestType type }` mit `type ∈ {EntitySound=0, StartLoop=1, StopLoop=2}`.

3D-Audio: `AudioEngine::Calculate3D(worldPos, engine, cue)` (X3DAudio-Emitter/Listener, Doppler, LPF, Reverb). Globale XACT-Variablen die die Engine je Frame setzt: `CameraDistance`, `ZoomPercent`, `Angle`. Ducking über `Duck`/`DuckLength`-Variablen (`mDuckMode`, `mActiveDuckingSounds`).

### Open-Source-Parser (Web-Recherche)
- **`unxwb`** (Luigi Auriemma) — der Standard-Extractor für XACT Wave Banks; deckt WBND/Version 43 ab.
- **`xnb_parse`** (fesh0r) — Python: `xnb_parse/xact/xwb.py`, `xsb.py` — sauberer, lesbarer Referenz-Parser für beide Formate. Gute Vorlage für einen JS/TS-Port.
- **MonoGame** — hat XWB-Lesecode (`WaveBank`/`SoundBank` in `MonoGame.Framework/Audio/`); ein vollwertiger `XactImporter/XactProcessor` wurde nie fertiggestellt (Issue #2661), aber die Runtime-Reader sind brauchbar.
- **`XWBTool`** (Microsoft DirectXTK) — offizielles Tool, erzeugt/liest XWB; dokumentiert die Struktur.
- **multimedia.cx MultimediaWiki: „XACT"** — die maßgebliche Format-Dokumentation für WBND und SDBK.
- `towav`/`xma_parse` sind nur für XMA (Xbox 360) nötig — **für FA irrelevant**, da alles PCM ist.

**Empfehlung Nachbau:** eigener kleiner XWB-Reader (~100 Zeilen, PCM-Slices → WAV/AudioBuffer) + XSB-Reader für die Cue-Namen-Tabelle. Da nur Cue→Wave-Zuordnung gebraucht wird, kann man alternativ einmalig offline mit `unxwb`+`xnb_parse` alle Waves als `<Bank>/<CueName>.ogg` exportieren und im Browser nur noch benannte Dateien laden — das umgeht die komplexe Complex-Cue/Variation-Logik von XACT.

## 5. Musik / Ambient
- **Musik**: `lua.scd → lua/UserMusic.lua`. Zwei Cue-Listen aus Bank `Music`: `BattleCues = { Sound{Cue='Battle', Bank='Music'} }`, `PeaceCues = { Sound{Cue='Base_Building', Bank='Music'} }`. Logik: `NotifyBattle()` zählt Kampf-Events; ≥ `BattleEventThreshold = 20` Events (Reset wenn > `BattleCounterReset = 30` Ticks Pause) ⇒ `StartBattleMusic()` (harter Cut, `StopSound(Music,true)`); nach `PeaceTimer = 200` Ticks (20 s) ohne Kampf ⇒ `StartPeaceMusic()` (Fade-out via `StopSound(Music)` + `WaitFor(Music)`, 3 s Pause, dann Peace-Cue). Cues rotieren zyklisch. `Music.xwb` = 250 MB Streaming-Bank, 12 Waves, 44,1 kHz Stereo PCM; `Music.xsb`-Cues: `Main_Menu`, `Base_Building`, `Battle`.
- **Ambient**: `AmbientTest.xsb/.xwb` (Cues: `AMB_Menu_Loop`, `Gen_Fire_Loop`, `Gen_Fire_Start`, `Gen_Tree_Crush`, `AMB_Planet_Rumble_zoom`, `AMB_SER_OP_Briefing`); `gamedata/ambience.scd` ist **leer** (nur ein Verzeichniseintrag) — Ambient-Loops laufen also über die normalen Bank/Cue-Pfade + `mAmbientEngine` im `CUserSoundManager`.
- **Unit-Ambient-Loops**: `bp.Audio.AmbientMove` etc. → `Entity:SetAmbientSound(params)` bzw. sim-seitig `PlayLoop(self, params)`; `HSound` ist das Loop-Handle mit intrusiver Liste im `CSimSoundManager`, `UpdateLoopCompletionState()` signalisiert Ende. `UnitRumble.xsb/.xwb` liefert Distanz-/Zoom-abhängige Rumble-Loops (moduliert über die XACT-Variablen `CameraDistance`/`ZoomPercent`).
- **UI**: `Interface.xsb` (119 Cues: `UI_Menu_Accept_01`, `UI_Menu_Rollover`, `UEF_Select_Tank`, …). Fraktions-Select-Bänke: `AEONSelect.xwb`, `CYBRANSelect.xwb`, `UEFSelect.xwb`, `SeraphimSelect.xwb/.xsb`.

## Refs
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\REmitterBlueprint.h:144 (REmitterBlueprint, 21 Kurven + Flags + Texturen, size 0x284)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RTrailBlueprint.h:28 (RTrailBlueprint, size 0x80)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\RBeamBlueprint.h:28 (RBeamBlueprint, size 0x84)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\resource\blueprints\REffectBlueprint.h:23 (Basis: BlueprintId + High/Med/LowFidelity)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\SEfxCurve.cpp:319 (SEfxCurve::GetValue — Interpolation + Zufalls-Spread)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\SEfxCurve.h:29
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEfxEmitter.h:52 (CEfxEmitter, size 0x6F8)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEfxTrailEmitter.h:29 (size 0x1B8)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEfxBeam.h:15 (size 0x298)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\EffectLuaStartupRegistrations.cpp:53-106 (alle Create*-Lua-Signaturen), :1940/:2253/:2273/:2293/:2313 (SetEmitterParam/ScaleEmitter/ResizeEmitterCurve/SetEmitterCurveParam/OffsetEmitter)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\effects\rendering\CEffectManagerImpl.h:47-165 (CreateEmitter/CreateAttachedEmitter/CreateEmitterAtBone/CreateTrail/CreateBeam/CreateLightParticle)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\render\EEmitterCurve.h (21 Kurven-Lanes), EEmitterParam.h (26 Skalar-Lanes), EBeamParam.h (21 Beam-Lanes)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\SWorldParticle.h:19 (Runtime-Partikel, size 0x8C)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\SWorldBeam.h:20 (size 0xCC)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\CWorldParticles.cpp:443 (BlendMode -> Technique-Suffix Mapping), :510 (time = tick + frameDelta)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\particles\BeamRenderHelpers.cpp:2024-2048 (TBeam_OneTexture/TwoTexture Technique-Auswahl)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\CSndParams.h:117 (mBank/mCue/mLodCutoff/mBankId/mCueId), :168 (cfunc_SoundL baut CSndParams aus {Cue,Bank,LodCutoff})
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\AudioEngine.cpp:3618 (func_LoadSoundPath: *.xwb + *.xsb enumerieren), :4099 (/sounds/SupCom.xgs)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\AudioEngine.h:38-205 (IXACTSoundBank/IXACTCue/IXACTEngine ABI), :493 GetBankIndex, :503 GetCueIndex, :590 Calculate3D
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\CUserSoundManager.cpp:55-67 (Lua-Hilfetexte PlaySound/StopSound/SetVolume/PlayVoice), :1239 (AudioEngine::Create("/sounds"))
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\audio\SAudioRequest.h:24 (EAudioRequestType: EntitySound/StartLoop/StopLoop)
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\sim\Sim.cpp:1143 (PlayLoop(self,sndParams) / StopLoop(self,handle))
- C:\Users\Marti\Documents\02Projekte\faf\Draiget\faf-re\src\sdk\moho\entity\Entity.cpp:237 (Entity:PlaySound / Entity:SetAmbientSound)
- ZIP: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\gamedata\effects.scd -> effects/Emitters/*.bp (2724), effects/particle.fx, effects/Entities/*, effects/Explosion|Nuke|QuantumWarhead|EMPFluxWarhead
- ZIP: gamedata/effects.scd -> effects/Emitters/adisruptor_cannon_muzzle_01_emit.bp (EmitterBlueprint-Referenzbeispiel), adjacency_uef_beam_01_emit.bp (BeamBlueprint), aeon_cannon_trail_emit.bp (TrailEmitterBlueprint)
- ZIP: gamedata/mohodata.scd -> lua/system/Blueprints.lua (EmitterBlueprint/BeamBlueprint/TrailEmitterBlueprint Registrierung, LoadBlueprints)
- ZIP: gamedata/mohodata.scd -> lua/sim/DefaultProjectiles.lua (FxTrails/PolyTrails/Beams), lua/sim/defaultweapons.lua:169 PlayFxMuzzleSequence, lua/sim/CollisionBeam.lua
- ZIP: gamedata/lua.scd -> lua/EffectTemplates.lua (180 KB, ~586 Templates), lua/EffectUtilities.lua (56 KB), lua/defaultexplosions.lua, lua/defaultcollisionbeams.lua, lua/UserMusic.lua
- ZIP: gamedata/textures.scd -> textures/particles/ (747 Dateien, inkl. ramp_*.dds)
- ZIP: gamedata/units.scd -> units/UEL0201/UEL0201_unit.bp (Audio = { ... Sound{Bank,Cue,LodCutoff} })
- Dateien: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\sounds\ (78 x .xwb, 80 x .xsb, SupCom.xgs, Voice/US, Voice/DE) — hex-geprüft: Explosions.xwb, Music.xwb, UEL.xwb, Explosions.xsb, Music.xsb, SupCom.xgs
- Web: https://wiki.multimedia.cx/index.php/XACT (WBND/SDBK Formatdoku)
- Web: https://github.com/fesh0r/xnb_parse/blob/master/xnb_parse/xact/xwb.py (Python XWB/XSB Parser)
- Web: https://github.com/microsoft/DirectXTK/wiki/XWBTool (offizielles XWB-Tool)
- Web: https://github.com/MonoGame/MonoGame/issues/2661 (MonoGame XactImporter/XactProcessor Status)
- Scratchpad-Extrakte: C:\Users\Marti\AppData\Local\Temp\claude\c--Users-Marti-Documents-02Projekte-Claude-Commander-Forged-Alliance\795d25b0-6aed-4269-81c5-1f3b66283dbf\scratchpad\{particle.fx, EffectTemplates.lua, EffectUtilities.lua, defaultexplosions.lua, defaultcollisionbeams.lua, DefaultProjectiles.lua, CollisionBeam.lua, Blueprints.lua, UserMusic.lua}
