/**
 * M8 — DER KAMPF, über die Original-Lua.
 *
 * Zwei T1-Panzer (UEL0201), Armee 1 gegen Armee 2, 15 Weltmeter auseinander.
 * Danach nur noch `beat()`. Alles andere macht das Spiel selbst:
 *
 *   __weaponTick()            Zielerfassung (CAcquireTargetTask, Cfile:792838)
 *     → Weapon:OnGotTarget()  defaultweapons.lua:413 → RackSalvoFireReadyState
 *   __weaponTick()            Feuertakt (CFireWeaponTask, Cfile:983912)
 *     → Weapon:OnFire()       → RackSalvoFiringState (defaultweapons.lua:510)
 *       → CreateProjectileAtMuzzle → weapon:CreateProjectile(bone)  [ENGINE]
 *         → PassDamageData(GetDamageTable())    (weapon.lua:325)
 *   __projectileTick()        Flug (Projectile::MotionTick, Trapez-Integration)
 *     → OnImpact('Unit', ziel) → Projectile:DoDamage → Damage(...)   [ENGINE]
 *       → ziel:OnDamage → DoTakeDamage → AdjustHealth → Kill
 *         → OnKilled → DeathThread → CreateWreckage → CreateProp    [ENGINE]
 *
 * Die Zahlen stehen im Blueprint (uel0201: Damage 24, RateOfFire 1,
 * MaxRadius 18, MuzzleVelocity 25, ProjectileId TDFGauss01), die Reihenfolge in
 * der Decomp. Keine davon steht in TypeScript.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-combat.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20)

console.log('\n== Blueprints: Projektile und Wracks ==')
const nProj = game.loadProjectiles(host)
const nProps = game.loadProps(host)
check(nProj > 250, `${nProj} Projektil-Blueprints über die echte Pipeline`)
check(nProps >= 1, `${nProps} Prop-Blueprint(s) (DefaultWreckage)`)

// Die BlueprintId ist der volle kleingeschriebene PFAD mit .bp
// (SetBackwardsCompatId, Blueprints.lua:104-107) — genau der String, der in
// Weapon.ProjectileId steht.
const gauss = '/projectiles/tdfgauss01/tdfgauss01_proj.bp'
check(
  host.eval(`return __registered.Projectile['${gauss}'] ~= nil`) === true,
  'TDFGauss01 ist registriert (BlueprintId = kleingeschriebener Pfad)',
)
check(
  Number(host.eval(`return __registered.Projectile['${gauss}'].Physics.InitialSpeed`)) === 12,
  'InitialSpeed = 12 (aus der .bp, nicht geraten)',
)
// Struct-Defaults der Engine (RProjectileBlueprintPhysics-Ctor, Cfile:653667):
// die .bp von TDFGauss01 hat kein UseGravity und kein Lifetime.
check(
  host.eval(`return __registered.Projectile['${gauss}'].Physics.UseGravity`) === true,
  'UseGravity = true kommt aus dem Struct-Default (die .bp sagt nichts dazu)',
)
check(
  Number(host.eval(`return __registered.Projectile['${gauss}'].Physics.Lifetime`)) === 15,
  'Lifetime = 15 (Struct-Default)',
)

console.log('\n== Zwei Panzer, zwei Armeen ==')
for (const id of ['uel0201']) await game.giveUnit(host, id)
const a = spawnLuaUnit(host, 'uel0201', { x: 100, y: 20, z: 100 }, 1)
const b = spawnLuaUnit(host, 'uel0201', { x: 100, y: 20, z: 115 }, 2)
check(a > 0 && b > 0, `Panzer ${a} (Armee 1) und ${b} (Armee 2), 15 Meter auseinander`)

// Das Skelett ist da — und die Mündung sitzt NICHT im Ursprung der Unit.
const muzzle = host.eval(`
  local u = __units[${a}]
  local p = u:GetPosition('Turret_Muzzle')
  return string.format('%.2f %.2f %.2f', p[1], p[2], p[3])
`) as string
check(
  muzzle !== '100.00 20.00 100.00',
  `Mündungsknochen 'Turret_Muzzle' hat eine eigene Weltpose: ${muzzle}`,
)

console.log('\n== Die Waffe findet ihr Ziel (CAcquireTargetTask) ==')
// TargetCheckInterval 0.5 -> alle 5 Ticks; MaxRadius 18 > 15 Meter Abstand.
let gotTarget = -1
for (let t = 0; t < 10 && gotTarget < 0; t++) {
  beat(engine)
  if (host.eval(`return __units[${a}]:GetWeapon(1):GetCurrentTarget() ~= nil`) === true) {
    gotTarget = t
  }
}
check(gotTarget >= 0, `Die Waffe hat nach ${gotTarget + 1} Beats ein Ziel (TargetCheckInterval 0.5)`)
check(
  host.eval(`return __units[${a}]:GetWeapon(1):GetCurrentTarget():GetEntityId() == ${b}`) === true,
  'und zwar den Panzer der FEIND-Armee',
)

console.log('\n== Der Schuss (OnFire → RackSalvoFiringState → CreateProjectile) ==')
let projSeen = 0
for (let t = 0; t < 12 && projSeen === 0; t++) {
  beat(engine)
  projSeen = Number(host.eval('local n = 0 for _ in pairs(__projectiles) do n = n + 1 end return n'))
}
check(projSeen > 0, `${projSeen} Projektil(e) in der Luft`)
const projClass = host.eval(`
  for _, p in pairs(__projectiles) do
    return tostring(p.__bp.BlueprintId)
  end
  return 'keins'
`) as string
check(projClass === gauss, `Es ist ein TDFGauss01 — der Blueprint der Waffe (${projClass})`)
check(
  Number(host.eval(`
    for _, p in pairs(__projectiles) do return p.DamageData.DamageAmount end
    return -1
  `)) === 24,
  'Es trägt DamageAmount 24 (weapon.lua:325 PassDamageData → uel0201_unit.bp:211)',
)

console.log('\n== Der Treffer: 24 Schaden pro Kugel ==')
const maxHp = Number(host.eval(`return __units[${b}]:GetMaxHealth()`))
let hp = maxHp
for (let t = 0; t < 20 && hp === maxHp; t++) {
  beat(engine)
  hp = Number(host.eval(`return __units[${b}] and __units[${b}]:GetHealth() or 0`))
}
check(hp === maxHp - 24, `Das Ziel verliert genau 24 HP (${maxHp} → ${hp})`)

console.log('\n== Bis zum Tod: OnKilled, DeathThread, Wrack ==')
// MaxHealth 260 / 24 = 11 Treffer. Bei RateOfFire 1 (alle 10 Ticks) plus
// Flugzeit reichen 150 Beats mit Reserve.
let killed = false
let killedAt = -1
for (let t = 0; t < 200 && !killed; t++) {
  beat(engine)
  if (host.eval(`return __units[${b}] == nil or __units[${b}].__dead == true`) === true) {
    killed = true
    killedAt = t
  }
}
check(killed, `Der Panzer stirbt (nach ${killedAt + 1} weiteren Beats, ${maxHp} HP / 24 Schaden)`)

// Der Todes-Thread laeuft als Coroutine weiter: Explosion, Wrack, Destroy.
for (let t = 0; t < 60; t++) beat(engine)
const props = Number(host.eval('local n = 0 for _ in pairs(__props) do n = n + 1 end return n'))
check(props >= 1, `${props} Wrack-Prop auf dem Feld (Unit:CreateWreckage → CreateProp)`)
const wreck = host.eval(`
  for _, p in pairs(__props) do return tostring(p.__bp.BlueprintId) end
  return 'keins'
`) as string
check(
  wreck.indexOf('wreckage') >= 0,
  `Es ist das DefaultWreckage-Prop aus dem Blueprint der Unit (${wreck})`,
)

// Der SICHTWEG des Wracks (H8): __readAllPropsJson liefert dem Renderer alles,
// was er zum Zeichnen braucht — das Wrack-Mesh aus ExtractWreckageBlueprint
// (lua/system/blueprints.lua:187, laeuft in unserer echten LoadBlueprints-
// Kette), die Unit dahinter (SCM + Texturen), Massstab und Erstellungs-Tick.
{
  const snap = JSON.parse(String(host.eval('return __readAllPropsJson()'))) as {
    meshBp?: string
    assoc?: string
    scale?: number
    spawn?: number
  }[]
  const w = snap[0]
  check(
    w?.meshBp === '/units/uel0201/uel0201_mesh_wreck',
    `Snapshot meshBp = ${w?.meshBp} (SetMesh mit Display.MeshBlueprintWrecked, unit.lua:1129)`,
  )
  check(w?.assoc === 'uel0201', `Snapshot assoc = ${w?.assoc} (prop.AssociatedBP, unit.lua:1137)`)
  const uniScale = Number(host.eval(`return __registered.Unit['uel0201'].Display.UniformScale`))
  check(
    typeof w?.scale === 'number' && Math.abs(w.scale - uniScale) < 1e-9,
    `Snapshot scale = ${w?.scale} = UniformScale des Panzers (${uniScale}, unit.lua:1111)`,
  )
  check(typeof w?.spawn === 'number' && w.spawn > 0, `Snapshot spawn = ${w?.spawn} (Erstellungs-Tick)`)
  const meshBp = JSON.parse(String(host.eval(`return __meshBpJson('/units/uel0201/uel0201_mesh_wreck')`))) as {
    LODs?: { ShaderName?: string; SpecularName?: string }[]
  }
  check(
    meshBp?.LODs?.[0]?.ShaderName === 'Wreckage' &&
      meshBp?.LODs?.[0]?.SpecularName === '/env/common/props/wreckage_noise.dds',
    `Wrack-Mesh-BP: Shader ${meshBp?.LODs?.[0]?.ShaderName}, Noise ${meshBp?.LODs?.[0]?.SpecularName} (blueprints.lua:200-201)`,
  )
}

console.log('\n== SimCallback: der Sim-Empfänger dispatcht über simcallbacks.lua ==')
// Moho::Sim::LuaSimCallback (Cfile:1076180-1076287): DoCallback(name, args,
// units) — unbekannte Namen enden im error('No callback named …',
// simcallbacks.lua:18), den der Empfänger als WARN loggt (gpg::Warnf-Weg).
{
  const before = warnings.length
  host.eval(`__simCallback('GibtEsNicht', { probe = true }, {})`)
  const warned = warnings.slice(before).some((w) => w.includes('No callback named'))
  check(warned, 'unbekannter Callback → WARN "No callback named" (simcallbacks.lua:18)')
  check(
    host.eval(`return type(import('/lua/simcallbacks.lua').DoCallback) == 'function'`) === true,
    'DoCallback existiert im echten simcallbacks.lua-Modul',
  )
}

console.log('\n== Gelenkte Munition: die Zealot-Rakete dreht auf ein seitliches Ziel ==')
// AAAZealotMissile01: TrackTarget=true, TurnRate=180, MaxSpeed=50, Accel=6
// (das Blueprint aus projectiles.scd). UpdateTracking (@944367) dreht die
// Nase pro Tick höchstens TurnRate·0.1° Richtung Ziel; ohne Tracking flöge
// die Rakete geradeaus am Ziel vorbei.
{
  // DIFFERENZ-BEWEIS: die Rakete startet nach +Z, das Ziel steht 18° seitlich
  // (10 m in +X, 30 m voraus). Geradeaus (Tracking aus) verfehlt sie um 10 m —
  // mit UpdateTracking dreht die Nase ein und trifft. Der Abschusswinkel ist
  // realistisch: im Spiel zielt die WAFFE vor dem Abschuss grob aufs Ziel.
  const schuetzeId = spawnLuaUnit(host, 'uel0201', { x: 200, y: 20, z: 90 }, 1)
  const zielId = spawnLuaUnit(host, 'uel0201', { x: 210, y: 20, z: 130 }, 2)
  const fliege = (tracking: boolean): string =>
    host.eval(`
      local schuetze = __units[${schuetzeId}]
      local ziel = __units[${zielId}]
      local p = __projCreate(
        schuetze, '/projectiles/aaazealotmissile01/aaazealotmissile01_proj.bp',
        { 200, 22, 100 }, __orientFromDir({ 0, 0, 1 }), 30, 100, 0, 'Normal', ziel, true
      )
      p.__leadTarget = true
      p.__trackTarget = ${tracking}
      local ergebnis = 'kein Einschlag'
      for _ = 1, 100 do
        __projectileTick()
        if p.__impactType then ergebnis = tostring(p.__impactType) end
        __flushDeletions()
        if p.__destroyed then break end
      end
      return ergebnis
    `) as string
  const mit = fliege(true)
  const ohne = fliege(false)
  check(mit === 'Unit', `MIT Tracking trifft die Rakete (Einschlag: ${mit})`)
  check(ohne !== 'Unit', `OHNE Tracking fliegt sie vorbei (Einschlag: ${ohne}) — der Unterschied IST UpdateTracking`)
}

console.log('\n== CollisionBeam: der Dauerstrahl des Cybran-T2-Turms ==')
// urb2301 führt eine CDFParticleCannonWeapon (DefaultBeamWeapon,
// defaultweapons.lua:785): statt eines Projektils wird pro Mündung eine
// CollisionBeam-Entity erzeugt (OnCreate :802-816) und beim Feuern Enable()t.
// Der Sim-Tick castet den Strahl (MotionTick @911386) und OnImpact macht den
// Schaden (CollisionBeam.lua:186-215).
{
  await game.giveUnit(host, 'urb2301')
  const turm = spawnLuaUnit(host, 'urb2301', { x: 300, y: 20, z: 100 }, 1)
  // The victim stands SIDEWAYS (+X): the turret must slew ~90 degrees
  // before the fire gate (weapon->mCanFire) lets the beam start.
  const opfer = spawnLuaUnit(host, 'uel0201', { x: 312, y: 20, z: 100 }, 2)
  check(turm > 0 && opfer > 0, `Turm ${turm} (Cybran T2 PD) und Opfer ${opfer}, 12 m seitlich`)
  const beams = Number(host.eval('return #__collisionBeams'))
  check(beams >= 1, `${beams} CollisionBeam-Entity(s) beim Waffen-OnCreate erzeugt`)
  let beamAn = false
  let schaden = false
  let hpStart = 0
  for (let t = 0; t < 120; t++) {
    beat(engine)
    if (!beamAn) {
      beamAn = host.eval('for _, b in ipairs(__collisionBeams) do if b:IsEnabled() then return true end end return false') === true
    }
    const hp = Number(host.eval(`local u = __units[${opfer}] return (u and u.__health) or 0`))
    if (t === 0) hpStart = hp
    if (hp < hpStart && hp >= 0) {
      schaden = true
      break
    }
  }
  check(beamAn, 'Der Beam wurde beim Feuern Enable()t (PlayFxBeamStart)')
  check(schaden, 'Der Dauerstrahl macht Schaden (OnImpact → DoDamage)')
  // Turret aiming (CAimManipulator): the yaw must be ~90° toward +X and
  // on-target — without the slew the fire gate would never have opened.
  const aim = host.pull<{ yaw: number; on: boolean } | null>(`(function()
    for _, w in ipairs(__units[${turm}].__weapons or {}) do
      if w.__aim then
        return string.format('{"yaw":%.4f,"on":%s}', w.__aim.__yaw or 0, tostring(w.__aim.__onTarget == true))
      end
    end
    return 'null'
  end)()`)
  check(
    aim !== null && aim.on && Math.abs(aim.yaw - Math.PI / 2) < 0.15,
    `Der Turm hat auf das Ziel gedreht (yaw ${aim ? aim.yaw.toFixed(3) : '—'} ≈ π/2, onTarget=${aim?.on})`,
  )
  // Der SICHTBARE Strahl: CreateBeamEmitter + AttachBeamToEntity hängen den
  // Beam-Emitter an die CollisionBeam-Entity — die Meldung trägt beide Enden.
  const fx = host.pull<{ bp: string; x2?: number }[]>('__readAllEmittersJson()')
  const beamFx = fx.filter((e) => e.x2 !== undefined)
  check(beamFx.length >= 1, `${beamFx.length} Beam-Effekt(e) mit beiden Enden in der Emitter-Meldung`)
}

console.log('\n== Befehls-Dispatch: Stop, Move-bricht-Bau, Attack ==')
// Die Dispatch-Tabelle (IAiCommandDispatchImpl::DispatchTask @0x608EF0): ein
// neuer Befehl ERSETZT die Arbeit; der Bau-Abbruch faehrt die Kette aus
// CBuildTaskHelper::OnStopBuild(completed=0) (Cfile:814989-815022).
{
  // Ein Ingenieur (ACU) beginnt einen Bau und wird WEGGESCHICKT.
  await game.giveUnit(host, 'uel0001')
  await game.giveUnit(host, 'ueb0101')
  const acu = spawnLuaUnit(host, 'uel0001', { x: 300, y: 20, z: 300 }, 1)
  const site = Number(
    host.eval(
      `local id = __spawnBuildSite('/units/ueb0101/ueb0101_script.lua', 'ueb0101', 303, 20, 303, 1) return id`,
    ),
  )
  host.eval(`__issueBuildTask(${acu}, ${site}, 'MobileBuild')`)
  host.eval(`SetArmyEconomy(1, 4000, 100000)`)
  for (let t = 0; t < 40; t++) beat(engine)
  const frBeforeMove = Number(host.eval(`return __units[${site}].__fraction`))
  check(frBeforeMove > 0, `Der Bau läuft (fraction ${frBeforeMove.toFixed(3)})`)

  host.eval(`__dispatchMove(${acu}, 260, 300)`)
  check(
    host.eval(`return __builderBusy(${acu})`) === false,
    'Move bricht den Bau-Task ab (Abbruch-Kette Cfile:814989)',
  )
  const frAfterMove = Number(host.eval(`return __units[${site}].__fraction`))
  check(
    frAfterMove >= frBeforeMove && frAfterMove < 1,
    `Die Baustelle bleibt mit ihrem Fortschritt stehen (${frAfterMove.toFixed(3)})`,
  )
  for (let t = 0; t < 30; t++) beat(engine)
  const nachher = host.eval(`local p = __units[${acu}].__pos return p[1]`) as number
  check(nachher < 299, `Der Bauer fährt wirklich weg (x ${Number(nachher).toFixed(1)} < 300)`)

  // STOP haelt die Fahrt an.
  host.eval(`__dispatchStop(${acu})`)
  check(
    host.eval(`return __units[${acu}].__goal == false and __builderBusy(${acu}) == false`) === true,
    'Stop killt Fahrziel und Bau-Tasks (Dispatch 0x01)',
  )

  // SITE DECAY (Unit::OnTick, Cfile:952824-952840): the abandoned site
  // loses 0.1/max(BuildCostEnergy, BuildCostMass, BuildTime) per tick.
  const fVerlassen = Number(host.eval(`return __units[${site}].__fraction`))
  for (let t = 0; t < 100; t++) beat(engine)
  const fDecayed = Number(host.eval(`return __units[${site}].__fraction`))
  check(
    fDecayed < fVerlassen,
    `Die verlassene Baustelle zerfällt (${fVerlassen.toFixed(4)} → ${fDecayed.toFixed(4)})`,
  )

  // REPAIR (dispatch 0x14): the right-click default on an own unfinished
  // structure resumes construction through the same build task.
  host.eval(`__dispatchRepair(${acu}, ${site})`)
  for (let t = 0; t < 250; t++) beat(engine)
  const fRepariert = Number(host.eval(`return __units[${site}].__fraction`))
  check(
    fRepariert > fDecayed,
    `Repair nimmt den Bau wieder auf (${fDecayed.toFixed(4)} → ${fRepariert.toFixed(4)})`,
  )

  // ALLIANCES (CArmyImpl): self-ally from birth (Cfile:1017297), skirmish
  // default Enemy between distinct armies (scenarioutilities.lua:495),
  // SetAlliance is symmetric and exclusive (Cfile:1016642-1016680).
  check(host.eval(`return IsAlly(1, 1)`) === true, 'IsAlly(1,1): every army allies itself')
  check(host.eval(`return IsEnemy(1, 2)`) === true, 'IsEnemy(1,2): skirmish default')
  check(host.eval(`return IsAlly(1, 2)`) === false, 'IsAlly(1,2) is false by default')
  host.eval(`SetAlliance(1, 2, 'Ally')`)
  check(
    host.eval(`return IsAlly(1, 2) and IsAlly(2, 1) and not IsEnemy(1, 2)`) === true,
    'SetAlliance(Ally) flips both directions and clears Enemy',
  )
  host.eval(`SetAlliance(1, 2, 'Enemy')`)
  check(host.eval(`return IsEnemy(1, 2)`) === true, 'SetAlliance(Enemy) restores hostility')

  // HP REPAIR of a FINISHED unit: the same CBuildTaskHelper — Materialize
  // only raises health (AdjustHealth, Cfile:953468) at BuildRate/BuildTime
  // per second; FractionComplete stays 1 (Cfile:953455-953466).
  host.eval(
    `__units[${site}].__fraction = 1 __units[${site}].__beingBuilt = false ` +
      `__units[${site}].__health = __units[${site}]:GetMaxHealth() * 0.5`,
  )
  host.eval(`__dispatchRepair(${acu}, ${site})`)
  for (let t = 0; t < 60; t++) beat(engine)
  const hpMid = Number(
    host.eval(`return __units[${site}].__health / __units[${site}]:GetMaxHealth()`),
  )
  const frMid = Number(host.eval(`return __units[${site}].__fraction`))
  check(hpMid > 0.5, `HP repair heals a finished unit (50% -> ${(hpMid * 100).toFixed(1)}%)`)
  check(frMid === 1, 'FractionComplete stays 1 during HP repair (Cfile:953455-953466)')
  for (let t = 0; t < 400; t++) beat(engine)
  const hpFull = Number(
    host.eval(`return __units[${site}].__health / __units[${site}]:GetMaxHealth()`),
  )
  check(hpFull >= 1, `HP repair completes to full health (${(hpFull * 100).toFixed(1)}%)`)
  check(
    host.eval(`return __builderBusy(${acu})`) === false,
    'the repair task ends at full health (TaskTick -1, Cfile:817856)',
  )
  host.eval(`__dispatchRepair(${acu}, ${site})`)
  check(
    host.eval(`return __builderBusy(${acu})`) === false,
    'repair on a full-HP finished unit is a no-op (Cfile:817856-817875)',
  )

  // A STARTED site aborted at ~0% stays (no instant delete) and dies through
  // OnDecayed → Destroy (unit.lua:551) once its health falls to 0.
  const acu2 = spawnLuaUnit(host, 'uel0001', { x: 500, y: 20, z: 500 }, 1)
  const site2 = Number(
    host.eval(
      `local id = __spawnBuildSite('/units/ueb0101/ueb0101_script.lua', 'ueb0101', 503, 20, 503, 1) return id`,
    ),
  )
  host.eval(`__issueBuildTask(${acu2}, ${site2}, 'MobileBuild')`)
  beat(engine) // startTask runs (builder already in range)
  host.eval(`__dispatchStop(${acu2})`)
  check(
    host.eval(`return __units[${site2}] ~= nil`) === true,
    'Die BEGONNENE 0%-Baustelle bleibt beim Abbruch stehen',
  )
  // One paid build step (~0.33%) decays at 0.1/max(2100, …) per tick —
  // about 70 ticks until health reaches 0.
  for (let t = 0; t < 120; t++) beat(engine)
  check(
    host.eval(`return __units[${site2}] == nil or __units[${site2}].__dead == true`) === true,
    'Sie stirbt über den Decay-Weg (OnDecayed → Destroy, unit.lua:551)',
  )

  // ATTACK: ein Panzer ausserhalb seiner MaxRadius (18) faehrt heran, die
  // Waffe nimmt das BEFEHLSZIEL, und das Ziel stirbt.
  const jaeger = spawnLuaUnit(host, 'uel0201', { x: 400, y: 20, z: 300 }, 1)
  const beute = spawnLuaUnit(host, 'uel0201', { x: 440, y: 20, z: 300 }, 2)
  host.eval(`__dispatchAttack(${jaeger}, ${beute})`)
  let zielGesetzt = false
  let gestorben = false
  for (let t = 0; t < 400 && !gestorben; t++) {
    beat(engine)
    if (!zielGesetzt) {
      zielGesetzt =
        host.eval(
          `local u = __units[${jaeger}] if not u then return false end
           for _, w in ipairs(u.__weapons or {}) do if w.__target and w.__target.__id == ${beute} then return true end end
           return false`,
        ) === true
    }
    gestorben = host.eval(`local b = __units[${beute}] return b == nil or b.__dead == true`) === true
  }
  check(zielGesetzt, 'Die Waffe nimmt das BEFEHLSZIEL (CAttackTargetTask → Zielerfassung)')
  // The command graph feed: the snapshot carries the active order (type +
  // target position) so the renderer can draw the order line + waypoint
  // (UICommandGraph, params from commandgraphparams.lua).
  {
    const rows = host.pull<{ id: number; order?: { t: string; x: number; z: number } }[]>(
      '__readAllUnitsJson()',
    )
    const j = rows.find((r) => r.id === jaeger)
    check(
      j?.order?.t === 'Attack' && typeof j.order.x === 'number',
      `Snapshot trägt die Attack-Order für den Befehls-Graphen (${JSON.stringify(j?.order)})`,
    )
  }
  const lage = host.pull<{ jx: number; jhp: number; bhp: number; goal: boolean }>(`(function()
    local j = __units[${jaeger}]
    local b = __units[${beute}]
    return string.format('{"jx":%.6g,"jhp":%.6g,"bhp":%.6g,"goal":%s}',
      (j and j.__pos[1]) or -1, (j and j.__health) or -1, (b and b.__health) or -1,
      tostring((j and j.__goal) ~= false and (j and j.__goal) ~= nil))
  end)()`)
  check(
    gestorben,
    `Attack über die Distanz: in Feuerreichweite (MaxRadius) fahren und töten` +
      (gestorben ? '' : ` — Lage: Jäger x=${lage.jx} HP=${lage.jhp}, Beute HP=${lage.bhp}, fährt=${lage.goal}`),
  )
}

console.log('\n== Was die Sim dabei gemeldet hat ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 110)))]
for (const w of uniq.slice(0, 12)) console.log(`  · ${w}`)

console.log(failures === 0 ? '\nKAMPF BESTANDEN' : `\nKAMPF: ${failures} FEHLER`)
await game.close()
process.exit(failures === 0 ? 0 : 1)
