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

/**
 * One entry of the sim->user audio queue: type, bank, cue and loop handle —
 * every request carries all four (weapons.lua:88, __drainAudioRequestsJson).
 */
type AudioRequest = { t: number; bank: string; cue: string; h: number }

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
  const gunnerId = spawnLuaUnit(host, 'uel0201', { x: 200, y: 20, z: 90 }, 1)
  const zielId = spawnLuaUnit(host, 'uel0201', { x: 210, y: 20, z: 130 }, 2)
  const fliege = (tracking: boolean): string =>
    host.eval(`
      local gunner = __units[${gunnerId}]
      local ziel = __units[${zielId}]
      local p = __projCreate(
        gunner, '/projectiles/aaazealotmissile01/aaazealotmissile01_proj.bp',
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
  const victim = spawnLuaUnit(host, 'uel0201', { x: 312, y: 20, z: 100 }, 2)
  check(turm > 0 && victim > 0, `Turm ${turm} (Cybran T2 PD) und Opfer ${victim}, 12 m seitlich`)
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
    const hp = Number(host.eval(`local u = __units[${victim}] return (u and u.__health) or 0`))
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

  // COMMAND QUEUE (CUnitCommandQueue): Shift appends (clear = NOT shift,
  // Cfile:1240965); an append does NOT interrupt the running order
  // (UCQS_CommandInserted, sim-core.md:255-258); head completion starts
  // the next queued command (TaskTick pops, sim-core.md:211-252); a
  // non-shift order wipes the queue first (ClearCommandQueue then
  // AddCommandToQueue, Cfile:1007575-1007589).
  const runner = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
  host.eval(`__dispatchMove(${runner}, 108, 100)`)
  host.eval(`__dispatchMove(${runner}, 108, 108, false)`) // Shift append
  check(
    host.eval(`return __orderActive[${runner}].type`) === 'Move',
    'the head move starts immediately',
  )
  check(
    Number(host.eval(`return #(__orders[${runner}] or {})`)) === 1,
    'the shift-queued move waits behind the head',
  )
  const snapOrders = host.eval(
    `local u = __units[${runner}] return __readAllUnitsJson()`,
  ) as string
  check(
    String(snapOrders).includes('"orders":[{"t":"Move"'),
    'the snapshot carries the full order queue for the command graph',
  )
  for (let t = 0; t < 300; t++) beat(engine)
  const rp = host.eval(`local p = __units[${runner}].__pos return p[1] .. ',' .. p[3]`) as string
  const [rx, rz] = String(rp).split(',').map(Number)
  check(
    Math.abs(rx! - 108) < 3 && Math.abs(rz! - 108) < 3,
    `after the head completes the unit continues to the queued waypoint (${rx!.toFixed(1)}, ${rz!.toFixed(1)})`,
  )
  host.eval(`__dispatchMove(${runner}, 120, 100)`)
  host.eval(`__dispatchMove(${runner}, 130, 100, false)`)
  host.eval(`__dispatchMove(${runner}, 100, 100)`) // no shift -> wipe
  check(
    Number(host.eval(`return #(__orders[${runner}] or {})`)) === 0,
    'a non-shift order wipes the queue (ClearCommandQueue, Cfile:1007575)',
  )

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

  // GROUND ATTACK (dispatch 0x0A with an AITARGET_Ground target,
  // Cfile:812553-812563): the tank closes to weapon range, the weapon takes
  // the POSITION as its target and fires; the order never self-completes
  // (HasTarget stays true for Ground, Cfile:800284).
  const gunner = spawnLuaUnit(host, 'uel0201', { x: 400, y: 20, z: 340 }, 1)
  host.eval(`__dispatchAttackGround(${gunner}, 440, 340)`)
  let groundTarget = false
  let fired = false
  for (let t = 0; t < 300 && !(groundTarget && fired); t++) {
    beat(engine)
    if (!groundTarget) {
      groundTarget =
        host.eval(
          `local u = __units[${gunner}] if not u then return false end
           for _, w in ipairs(u.__weapons or {}) do
             if w.__targetGround and w.__targetGround[1] == 440 then return true end
           end
           return false`,
        ) === true
    }
    if (groundTarget && !fired) {
      fired =
        host.eval(
          `local u = __units[${gunner}] if not u then return false end
           for _, w in ipairs(u.__weapons or {}) do
             if (w.__fireClock or 0) > 0 then return true end
           end
           return false`,
        ) === true
    }
  }
  check(groundTarget, 'Ground attack: the weapon takes the position target (AITARGET_Ground)')
  check(fired, 'Ground attack: the weapon fires at the ground (fire clock running)')
  check(
    host.eval(`return __attackOrders[${gunner}] ~= nil`) === true,
    'Ground attack never self-completes (HasTarget true for Ground, Cfile:800284)',
  )
  {
    const rows = host.pull<{ id: number; order?: { t: string; x: number; z: number } }[]>(
      '__readAllUnitsJson()',
    )
    const s = rows.find((r) => r.id === gunner)
    check(
      s?.order?.t === 'Attack' && s.order.x === 440,
      `Snapshot carries the ground-attack order for the command graph (${JSON.stringify(s?.order)})`,
    )
  }
  host.eval(`__dispatchStop(${gunner})`)
  check(
    host.eval(`return __attackOrders[${gunner}] == nil`) === true,
    'Stop ends the ground attack (queue + order wiped)',
  )

  // GUARD (dispatch 0x0F, CUnitGuardTask): engineer assist joins the
  // guarded builder's construction (guard chain, sub_612BB0 -> sub_613970);
  // a guarded factory shares its build queue (sub_6127F0); the order ends
  // when the guarded unit dies (Cfile:839365-839385).
  {
    const builderAcu = spawnLuaUnit(host, 'uel0001', { x: 600, y: 20, z: 300 }, 1)
    const helperAcu = spawnLuaUnit(host, 'uel0001', { x: 606, y: 20, z: 300 }, 1)
    const buildSite = Number(
      host.eval(
        `local id = __spawnBuildSite('/units/ueb0101/ueb0101_script.lua', 'ueb0101', 603, 20, 303, 1) return id`,
      ),
    )
    host.eval(`__issueBuildTask(${builderAcu}, ${buildSite}, 'MobileBuild')`)
    host.eval(`__dispatchGuard(${helperAcu}, ${builderAcu})`)
    let joined = false
    for (let t = 0; t < 40 && !joined; t++) {
      beat(engine)
      joined =
        host.eval(
          `for _, task in pairs(__buildTasks) do
             if task.builder == ${helperAcu} and task.target == ${buildSite} then return true end
           end
           return false`,
        ) === true
    }
    check(joined, 'Guard on a builder joins its build (guard chain -> repair task, sub_612BB0)')
    check(
      host.eval(`return __units[${helperAcu}]:IsUnitState('Guarding')`) === true,
      "IsUnitState('Guarding') answers from the real guard order (ctor bit 0x10, Cfile:836995)",
    )
    check(
      host.eval(
        `local g = __units[${helperAcu}]:GetGuardedUnit() return g ~= nil and g.__id == ${builderAcu}`,
      ) === true,
      'GetGuardedUnit returns the guarded unit (mGuardedUnit, Cfile:839316-839333)',
    )
    check(
      host.eval(
        `local gs = __units[${builderAcu}]:GetGuards() return table.getn(gs) == 1 and gs[1].__id == ${helperAcu}`,
      ) === true,
      'GetGuards lists the assisting unit (reverse of the guard orders)',
    )
    host.eval(`__units[${builderAcu}].__dead = true`)
    beat(engine)
    check(
      host.eval(`return __guardOrders[${helperAcu}] == nil`) === true,
      'Guard ends when the guarded unit dies (TaskTick -1, Cfile:839365-839385)',
    )
    host.eval(`__dispatchStop(${helperAcu})`)
  }
  {
    // Factory queue sharing: the guarding idle factory pulls ONE item off
    // the guarded factory's queue (count>1 head or later entries) and
    // builds it locally (sub_6127F0, Cfile:837988-838049).
    const f1 = spawnLuaUnit(host, 'ueb0101', { x: 620, y: 20, z: 340 }, 1)
    const f2 = spawnLuaUnit(host, 'ueb0101', { x: 632, y: 20, z: 340 }, 1)
    host.eval(`__queueFactoryBuild(${f1}, 'uel0201', 3)`)
    host.eval(`__dispatchGuard(${f2}, ${f1})`)
    let pulled = false
    for (let t = 0; t < 40 && !pulled; t++) {
      beat(engine)
      pulled =
        host.eval(
          `local q = __units[${f2}] and __units[${f2}].__buildQueue
           return q ~= nil and q[1] ~= nil and q[1].id == 'uel0201'`,
        ) === true
    }
    check(pulled, 'Factory guard pulls ONE queue item and builds it locally (sub_6127F0)')
    check(
      host.eval(
        `local q = __units[${f2}].__buildQueue local n = 0
         for _, e in ipairs(q or {}) do n = n + (e.count or 1) end
         return n == 1`,
      ) === true,
      'Exactly one item is pulled per idle re-check (count decrement, Cfile:838030-838049)',
    )
  }
  {
    // PATROL (dispatch 0x10, CUnitPatrolTask): one leg per command; the
    // LOOP is the queue's ring rotation (sim-core.md:243-252); shift-adds
    // after rotation insert before the smallest serial (CUnitCommandQueue
    // .cpp:446); enemies within AI.GuardScanRadius are engaged on the way
    // (FindTarget, Cfile:845090-845235).
    const patroller = spawnLuaUnit(host, 'uel0201', { x: 700, y: 20, z: 300 }, 1)
    host.eval(`__dispatchPatrol(${patroller}, 708, 300)`)
    host.eval(`__dispatchPatrol(${patroller}, 716, 300, false)`)
    host.eval(`__dispatchPatrol(${patroller}, 708, 308, false)`)
    let rotated = false
    for (let t = 0; t < 200 && !rotated; t++) {
      beat(engine)
      rotated =
        host.eval(
          `local a = __orderActive[${patroller}]
           local q = __orders[${patroller}] or {}
           if not a or a.x ~= 716 then return false end
           return q[#q] ~= nil and q[#q].x == 708 and q[#q].z == 300`,
        ) === true
    }
    check(rotated, 'Patrol ring: the finished leg rotates to the back of the queue (sim-core.md:250)')
    check(
      host.eval(
        `local n = __orderActive[${patroller}] and 1 or 0
         return n + #(__orders[${patroller}] or {}) == 3`,
      ) === true,
      'Patrol loop never shrinks (3 points stay 3 commands)',
    )
    // Shift-add after rotation: the new point goes BEFORE the oldest
    // element (smallest serial) — between the last point and the loop seam.
    host.eval(`__dispatchPatrol(${patroller}, 716, 308, false)`)
    check(
      host.eval(
        `local q = __orders[${patroller}] or {}
         for i, e in ipairs(q) do
           if e.x == 716 and e.z == 308 then
             local nxt = q[i + 1]
             return nxt ~= nil and nxt.x == 708 and nxt.z == 300
           end
         end
         return false`,
      ) === true,
      'Shift-added patrol point inserts before the smallest serial (CUnitCommandQueue.cpp:446)',
    )
    host.eval(`__dispatchStop(${patroller})`)
    check(
      host.eval(
        `return __orderActive[${patroller}] == nil and (__orders[${patroller}] == nil or __orders[${patroller}][1] == nil)`,
      ) === true,
      'Stop wipes the patrol loop',
    )

    // Single patrol point: completes and empties the queue (no self-loop,
    // RemoveFirstCommandFromQueue, sim-core.md:251).
    const solo = spawnLuaUnit(host, 'uel0201', { x: 700, y: 20, z: 330 }, 1)
    host.eval(`__dispatchPatrol(${solo}, 706, 330)`)
    let soloDone = false
    for (let t = 0; t < 200 && !soloDone; t++) {
      beat(engine)
      soloDone = host.eval(`return __orderActive[${solo}] == nil`) === true
    }
    check(soloDone, 'A single patrol point completes instead of looping (sim-core.md:251)')

    // Engage on the way: an enemy inside AI.GuardScanRadius becomes an
    // attack subtask; after the kill the leg re-issues its goal.
    const sentry = spawnLuaUnit(host, 'uel0201', { x: 740, y: 20, z: 300 }, 1)
    const victim = spawnLuaUnit(host, 'uel0201', { x: 752, y: 20, z: 306 }, 2)
    host.eval(`__dispatchPatrol(${sentry}, 780, 300)`)
    let engaged = false
    let resumed = false
    for (let t = 0; t < 400 && !resumed; t++) {
      beat(engine)
      if (!engaged) {
        engaged = host.eval(`return __attackOrders[${sentry}] == ${victim}`) === true
      } else {
        resumed =
          host.eval(
            `local o = __units[${victim}]
             local a = __orderActive[${sentry}]
             return (o == nil or o.__dead == true) and a ~= nil and a.type == 'Patrol'`,
          ) === true
      }
    }
    check(engaged, 'Patrol engages the enemy inside AI.GuardScanRadius (FindTarget, Cfile:845090)')
    check(resumed, 'After the kill the patrol leg continues (idle re-issue, Cfile:845598-845601)')
  }
  {
    // RECLAIM (dispatch 0x13, CUnitReclaimTask): costs come from the
    // TARGET's own Lua (GetReclaimCosts, Cfile:848452-848455 ->
    // prop.lua:153/wreckage.lua), the grant is total * |fraction delta|
    // straight into the army storage (Cfile:848612-848638), at fraction 0
    // the prop runs OnReclaimed and dies (Materialize, Cfile:1013985).
    // Target: the wreck the combat test left on the field.
    const wreckId = Number(
      host.eval(`for id, p in pairs(__props) do if p.AssociatedBP then return id end end return -1`),
    )
    check(wreckId > 0, `A wreck prop exists to reclaim (id ${wreckId})`)
    const reclaimer = spawnLuaUnit(host, 'uel0001', { x: 820, y: 20, z: 300 }, 1)
    host.eval(`__units[${reclaimer}].__pos = (function()
      local p = __props[${wreckId}].__pos return { p[1] + 3, p[2], p[3] } end)()`)
    const massBefore = Number(host.eval(`return __getBrain(1):GetEconomyStored('MASS')`))
    host.eval(`__dispatchReclaim(${reclaimer}, ${wreckId})`)
    let reclaimed = false
    for (let t = 0; t < 300 && !reclaimed; t++) {
      beat(engine)
      reclaimed =
        host.eval(
          `local p = __props[${wreckId}] return p == nil or p.__destroyed == true or p.__destroyQueued == true`,
        ) === true
    }
    check(reclaimed, 'Reclaim drains the wreck to zero and destroys it (Materialize)')
    const massAfter = Number(host.eval(`return __getBrain(1):GetEconomyStored('MASS')`))
    check(
      massAfter > massBefore,
      `The mass grant lands in the army storage (${massBefore} -> ${massAfter})`,
    )
    beat(engine) // the queue pops the finished command on the next tick
    check(
      host.eval(`return __reclaimTasks[${reclaimer}] == nil and __orderActive[${reclaimer}] == nil`) === true,
      'The reclaim task and its queue entry complete',
    )
  }
  {
    // SIM->USER AUDIO BRIDGE (SAudioRequest analog: EntitySound=0,
    // StartLoop=1, StopLoop=2 — effects-audio.md "Sound-Lua-API"). The
    // combat above fired weapons — their Weapon:PlaySound calls must have
    // landed as one-shot requests; ambient loops run over the entity's
    // SINGLE ambient slot (Cfile:932577-932591) and stop with the unit.
    const backlog = host.pull<AudioRequest[]>('__drainAudioRequestsJson()')
    check(
      backlog.some((r) => r.t === 0 && r.cue.length > 0),
      `weapon fire lands as EntitySound requests (${backlog.filter((r) => r.t === 0).length} one-shots queued)`,
    )
    const hummer = spawnLuaUnit(host, 'uel0201', { x: 860, y: 20, z: 300 }, 1)
    const ambient = host.pull<{ Bank?: string; Cue?: string }>(
      `(function() local a = __units[${hummer}].__bp.Audio.AmbientMove
        return string.format('{"Bank":%q,"Cue":%q}', tostring(a.Bank), tostring(a.Cue)) end)()`,
    )
    check(
      typeof ambient.Bank === 'string' && ambient.Bank.length > 0,
      `uel0201 has bp.Audio.AmbientMove (${ambient.Bank}:${ambient.Cue})`,
    )
    host.eval(`__units[${hummer}]:PlayUnitAmbientSound('AmbientMove')`)
    let evs = host.pull<AudioRequest[]>('__drainAudioRequestsJson()')
    check(
      evs.length === 1 && evs[0]!.t === 1 && evs[0]!.cue === ambient.Cue && evs[0]!.h > 0,
      `PlayUnitAmbientSound starts the loop (${JSON.stringify(evs)})`,
    )
    const loopHandle = evs[0]!.h
    host.eval(`__units[${hummer}]:PlayUnitAmbientSound('AmbientMove')`)
    evs = host.pull<AudioRequest[]>('__drainAudioRequestsJson()')
    check(
      evs.length === 2 && evs[0]!.t === 2 && evs[0]!.h === loopHandle && evs[1]!.t === 1,
      'replacing the ambient stops the previous loop first (single slot, Cfile:932577)',
    )
    host.eval(`__units[${hummer}]:StopUnitAmbientSound('AmbientMove')`)
    evs = host.pull<AudioRequest[]>('__drainAudioRequestsJson()')
    check(evs.length === 1 && evs[0]!.t === 2, 'StopUnitAmbientSound stops the loop')
    host.eval(`__units[${hummer}]:PlayUnitAmbientSound('AmbientMove')`)
    host.pull('__drainAudioRequestsJson()')
    host.eval(`__units[${hummer}]:Destroy()`)
    // Two beats: the unit's OnDestroy empties its TrashBag, which queues
    // the AmbientSounds helper entity (unit.lua:2786-2788) for the NEXT
    // deletion flush — its stop request lands one beat later.
    beat(engine)
    beat(engine)
    evs = host.pull<AudioRequest[]>('__drainAudioRequestsJson()')
    check(
      evs.some((r) => r.t === 2),
      'a dying unit stops its ambient loop (TrashBag -> helper entity flush)',
    )
  }
  {
    // MAP PROPS (Sim::Setup step 7, Cfile:1072041-1072105): spawned before
    // units, NOT serialized per beat (the instanced renderer draws them);
    // dying map props report their index once for instance hiding.
    host.eval(`__spawnMapProp(42, '/props/defaultwreckage/defaultwreckage_prop.bp', 850, 20, 300, 0)`)
    const mapPropId = Number(
      host.eval(`for id, p in pairs(__props) do if p.__mapIndex == 42 then return id end end return -1`),
    )
    check(mapPropId > 0, 'A map prop spawns through __spawnMapProp (PROP_Create)')
    check(
      String(host.eval('return __readAllPropsJson()')).indexOf(`"id":${mapPropId}`) < 0,
      'Map props are NOT serialized per beat (the instanced renderer draws them)',
    )
    host.eval(`__props[${mapPropId}]:Destroy()`)
    beat(engine)
    const removed = host.pull<number[]>('__drainRemovedMapPropsJson()')
    check(
      removed.includes(42),
      `A dying map prop reports its instance index once (${JSON.stringify(removed)})`,
    )
    check(
      host.pull<number[]>('__drainRemovedMapPropsJson()').length === 0,
      'The removal report drains (second read is empty)',
    )

    // RECLAIM BY MAP INDEX (the UI picks instanced map props by their scmap
    // index, not by sim id — __dispatchReclaimMapProp resolves the index
    // through __mapPropIds and runs the same CUnitReclaimTask).
    host.eval(`__spawnMapProp(43, '/props/defaultwreckage/defaultwreckage_prop.bp', 860, 20, 320, 0)`)
    const digger = spawnLuaUnit(host, 'uel0001', { x: 862, y: 20, z: 320 }, 1)
    // defaultwreckage_prop.bp writes ReclaimEnergyMax = '' (a string!) — the
    // engine's float struct field turns that into 0 (RPropBlueprint ctor
    // @0x51D250 + AddField_float, Cfile:655099-655102). GetReclaimCosts must
    // therefore return numbers, with mass = ReclaimMassMax = 1.
    const costMass = Number(
      host.eval(
        `local p = __props[__mapPropIds[43]]
         local ok, time, energy, mass = pcall(function() return p:GetReclaimCosts(__units[${digger}]) end)
         if not ok or type(time) ~= 'number' or type(mass) ~= 'number' then return -1 end
         return mass`,
      ),
    )
    check(
      costMass === 1,
      `Prop blueprint floats survive string .bp values (GetReclaimCosts mass ${costMass})`,
    )
    host.eval(`__dispatchReclaimMapProp(${digger}, 43)`)
    let drained = false
    for (let t = 0; t < 300 && !drained; t++) {
      beat(engine)
      drained =
        host.eval(
          `local id = __mapPropIds and __mapPropIds[43]
           local p = id and __props[id]
           return p == nil or p.__destroyed == true or p.__destroyQueued == true`,
        ) === true
    }
    check(drained, 'Reclaim by map index drains the instanced prop (__dispatchReclaimMapProp)')
    beat(engine)
    check(
      host.pull<number[]>('__drainRemovedMapPropsJson()').includes(43),
      'The reclaimed map prop reports index 43 for instance hiding',
    )
    // An unknown index must not crash and must not queue an order.
    host.eval(`__dispatchReclaimMapProp(${digger}, 99999)`)
    beat(engine)
    check(
      host.eval(`return __orderActive[${digger}] == nil`) === true,
      'Reclaim on an unknown map index warns and issues nothing',
    )
  }
  {
    // GUARD-ASSIST-RECLAIM (sub_612E80, Cfile:838256-838314): a guard whose
    // unit has category RECLAIM joins the guarded unit's RUNNING reclaim on
    // the SAME target (the guarded unit's focus entity, set by the reclaim
    // task at unit+1232, Cfile:848750; sub_613A10 issues the task).
    host.eval(`__spawnMapProp(44, '/props/defaultwreckage/defaultwreckage_prop.bp', 880, 20, 340, 0)`)
    const worker = spawnLuaUnit(host, 'uel0001', { x: 882, y: 20, z: 340 }, 1)
    const buddy = spawnLuaUnit(host, 'uel0001', { x: 884, y: 20, z: 340 }, 1)
    // Stretch the drain over several ticks so the guard has beats to join —
    // SetReclaimValues is the original prop API (Prop.lua:116; wreckage.lua
    // uses it the same way on damage).
    host.eval(`local p = __props[__mapPropIds[44]] p:SetReclaimValues(1, 1, 50, 0)`)
    host.eval(`__dispatchGuard(${buddy}, ${worker})`)
    host.eval(`__dispatchReclaimMapProp(${worker}, 44)`)
    let joined = false
    let stateSeen = false
    for (let t = 0; t < 60 && !joined; t++) {
      beat(engine)
      stateSeen =
        stateSeen || host.eval(`return __units[${worker}]:IsUnitState('Reclaiming')`) === true
      joined =
        host.eval(
          `local a = __reclaimTasks[${buddy}]
           local b = __reclaimTasks[${worker}]
           return a ~= nil and b ~= nil and a.target == b.target`,
        ) === true
    }
    check(stateSeen, "IsUnitState('Reclaiming') mirrors the running reclaim task (enum 28)")
    check(joined, 'A guard with category RECLAIM joins the reclaim on the same target (sub_612E80)')

    // Negative probe: a tank has no RECLAIM category — guarding a reclaiming
    // unit must NOT make it reclaim (sub_612E80's IsInCategory gate).
    host.eval(`__spawnMapProp(45, '/props/defaultwreckage/defaultwreckage_prop.bp', 890, 20, 350, 0)`)
    const worker2 = spawnLuaUnit(host, 'uel0001', { x: 892, y: 20, z: 350 }, 1)
    const tank = spawnLuaUnit(host, 'uel0201', { x: 894, y: 20, z: 350 }, 1)
    host.eval(`local p = __props[__mapPropIds[45]] p:SetReclaimValues(1, 1, 50, 0)`)
    host.eval(`__dispatchGuard(${tank}, ${worker2})`)
    host.eval(`__dispatchReclaimMapProp(${worker2}, 45)`)
    let tankJoined = false
    for (let t = 0; t < 8; t++) {
      beat(engine)
      tankJoined = tankJoined || host.eval(`return __reclaimTasks[${tank}] ~= nil`) === true
    }
    check(!tankJoined, 'A guard WITHOUT category RECLAIM never joins the reclaim')
  }
  {
    // Browser finding: an ENGINEER guarding a FINISHED factory must join
    // the factory's own FactoryBuild once it starts (the guard chain ends
    // at the factory; its running build task IS the site to assist).
    const fab = spawnLuaUnit(host, 'ueb0101', { x: 650, y: 20, z: 380 }, 1)
    const eng = spawnLuaUnit(host, 'uel0001', { x: 656, y: 20, z: 380 }, 1)
    host.eval(`__dispatchGuard(${eng}, ${fab})`)
    beat(engine)
    host.eval(`__queueFactoryBuild(${fab}, 'uel0201', 1)`)
    let assisted = false
    for (let t = 0; t < 40 && !assisted; t++) {
      beat(engine)
      assisted =
        host.eval(
          `for _, task in pairs(__buildTasks) do
             if task.builder == ${eng} and task.order == 'Repair' then return true end
           end
           return false`,
        ) === true
    }
    check(assisted, "Engineer guarding a factory joins the factory's FactoryBuild (assist)")
  }
}

console.log('\n== A projectile hitting water reports Water, not Terrain ==')
// CheckCollision tests the water PLANE (CColHitResult::PlaneIntersection,
// Cfile:722370) separately from the heightfield (CHeightField::Intersection);
// see combat-projectiles.md §3c. The terrain test must use the RAW elevation:
// GetSurfaceHeight is already max(elevation, water) (Cfile:1089855-1089876), so
// testing terrain first made every water impact report 'Terrain'
// (IMPACT_Terrain=1 vs IMPACT_Water=2, Cfile:640489-640525; the string comes
// from ENT_GetImpactTypeString, Cfile:917362-917405).
{
  const shooter = spawnLuaUnit(host, 'uel0201', { x: 1100, y: 20, z: 300 }, 1)
  const flyDown = (): string =>
    host.eval(`
      local p = __projCreate(
        __units[${shooter}], '/projectiles/tdfgauss01/tdfgauss01_proj.bp',
        { 1100, 40, 300 }, __orientFromDir({ 0, -1, 0 }), 20, 10, 0, 'Normal', nil, true
      )
      local result = 'no impact'
      for _ = 1, 200 do
        __projectileTick()
        if p.__impactType then result = tostring(p.__impactType) end
        __flushDeletions()
        if p.__destroyed then break end
      end
      return result
    `) as string

  // Terrain is at 20 here (setTerrainSource in this suite); put water at 30 so
  // the shot from y=40 crosses the water plane on the way down.
  host.eval(`__setWaterLevel(30)`)
  const overWater = flyDown()
  check(overWater === 'Water', `over water the impact is Water (${overWater})`)

  // Without water the very same shot must report Terrain — proving the water
  // branch is the thing that changed, not the geometry.
  host.eval(`__setWaterLevel(nil)`)
  const dryLand = flyDown()
  check(dryLand === 'Terrain', `on dry land the same shot is Terrain (${dryLand})`)

  // Coast/island: the map HAS water, but the ground where the shot lands is
  // ABOVE the water level. On a descending path the higher surface is reached
  // first, so this is a Terrain hit — the engine takes the nearer of the two
  // intersections, it does not let the water plane win unconditionally.
  host.eval(`__setWaterLevel(10)`)
  const island = flyDown()
  check(island === 'Terrain', `water below the ground (island/coast) still reports Terrain (${island})`)
  host.eval(`__setWaterLevel(nil)`)
}

console.log('\n== Target priorities beat distance (FindBestEnemy) ==')
// FindBestEnemy (Cfile:791970-792233) ranks by the LOWEST matching entry in the
// weapon's mTargetPriorities (HasBlueprint gate at Cfile:792183, better category
// wins outright at Cfile:792190-792191); distance only breaks ties inside a
// category (Cfile:792203). uel0201_unit.bp:245-253 lists
// SPECIALHIGHPRI, TECH1 MOBILE, TECH2 MOBILE, TECH3 MOBILE, STRUCTURE DEFENSE,
// SPECIALLOWPRI, ALLUNITS — so a T1 tank (entry 2) outranks a power generator,
// which only matches the ALLUNITS catch-all (entry 7), even from further away.
{
  for (const id of ['uel0101', 'ueb1101']) await game.giveUnit(host, id)
  const gunner = spawnLuaUnit(host, 'uel0201', { x: 1000, y: 20, z: 300 }, 1)
  const nearGen = spawnLuaUnit(host, 'ueb1101', { x: 1004, y: 20, z: 300 }, 2) // 4 m
  const farTank = spawnLuaUnit(host, 'uel0101', { x: 1014, y: 20, z: 300 }, 2) // 14 m
  check(gunner > 0 && nearGen > 0 && farTank > 0, `gunner ${gunner}, near generator ${nearGen} (4 m), far tank ${farTank} (14 m)`)

  const currentTarget = (): number =>
    Number(
      host.eval(`
        local t = __units[${gunner}]:GetWeapon(1):GetCurrentTarget()
        return (t and t.__id) or 0
      `),
    )
  // The weapon really did receive its blueprint list (weapon.lua:364-385 ->
  // SetTargetingPriorities). Without this the next check could pass by accident.
  check(
    Number(host.eval(`return #(__units[${gunner}]:GetWeapon(1).__targetPriorities or {})`)) === 7,
    `the weapon carries its 7 blueprint priorities (${host.eval(`return #(__units[${gunner}]:GetWeapon(1).__targetPriorities or {})`)})`,
  )

  let picked = 0
  for (let t = 0; t < 12 && picked === 0; t++) {
    beat(engine)
    picked = currentTarget()
  }
  check(picked === farTank, `it takes the FAR tank over the near generator (picked ${picked}, tank ${farTank}, generator ${nearGen})`)

  // Control: with the priority list emptied, the nearest wins again — proving
  // the choice above came from the ranking, not from geometry.
  const gunner2 = spawnLuaUnit(host, 'uel0201', { x: 1000, y: 20, z: 360 }, 1)
  spawnLuaUnit(host, 'ueb1101', { x: 1004, y: 20, z: 360 }, 2)
  const farTank2 = spawnLuaUnit(host, 'uel0101', { x: 1014, y: 20, z: 360 }, 2)
  host.eval(`__units[${gunner2}]:GetWeapon(1).__targetPriorities = {}`)
  let picked2 = 0
  for (let t = 0; t < 12 && picked2 === 0; t++) {
    beat(engine)
    picked2 = Number(
      host.eval(`
        local t = __units[${gunner2}]:GetWeapon(1):GetCurrentTarget()
        return (t and t.__id) or 0
      `),
    )
  }
  check(picked2 !== 0 && picked2 !== farTank2, `without priorities the nearest wins again (picked ${picked2}, far tank ${farTank2})`)
}

console.log('\n== Was die Sim dabei gemeldet hat ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 110)))]
for (const w of uniq.slice(0, 12)) console.log(`  · ${w}`)

console.log(failures === 0 ? '\nKAMPF BESTANDEN' : `\nKAMPF: ${failures} FEHLER`)
await game.close()
process.exit(failures === 0 ? 0 : 1)
