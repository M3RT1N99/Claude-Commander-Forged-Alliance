/**
 * XACT-Audio gegen die ECHTEN Spieldateien: alle Wave Banks (.xwb) und
 * Sound Banks (.xsb) aus <FA>/sounds/ parsen und die Cue→Sound→Track-Kette
 * bis zum PCM nachweisen.
 *
 * Die Suite prüft absichtlich ALLES, nicht nur Stichproben: jeder Sound-
 * Eintrag validiert sich im Parser exakt gegen sein entryLength-Feld, jede
 * Cue muss sich zu (Bank, Wave) auflösen, jeder Wave-Index muss in die
 * referenzierte Bank passen. Eine einzige falsch verstandene Struktur
 * (z. B. die 7- statt 22-Byte-Effekt-Variation von XACT 3.0) lässt damit
 * hunderte Checks knallen statt still Unsinn zu liefern.
 *
 *   npx tsx scripts/verify-audio.ts   (kein register-lua nötig — keine src/lua-Importe)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseXwb, wavFromEntry, type XwbBank } from '../src/formats/xwb'
import { parseXsb, type XsbBank } from '../src/formats/xsb'
import { parseXgs } from '../src/formats/xgs'

// Wie scripts/gameFiles.ts (dort GAME_DIR) — hier dupliziert, damit die Suite
// ohne den Lua-Loader (--import register-lua) lauffähig bleibt.
const GAME_DIR =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'
const SOUNDS_DIR = `${GAME_DIR}/sounds`

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// ── 1. Wave Banks: alle 78 .xwb aus sounds/ ────────────────────────────────
console.log('\n== Wave Banks (sounds/*.xwb) ==')
const xwbFiles = readdirSync(SOUNDS_DIR).filter((f) => f.endsWith('.xwb')).sort()
check(xwbFiles.length === 78, `78 .xwb-Dateien gefunden (${xwbFiles.length})`)

const banksByName = new Map<string, XwbBank>()
const fileByBankName = new Map<string, string>()
let totalWaves = 0
let nonPcm = 0
const formatHisto = new Map<string, number>()
const xwbErrors: string[] = []
for (const f of xwbFiles) {
  try {
    const bank = parseXwb(readFileSync(`${SOUNDS_DIR}/${f}`))
    banksByName.set(bank.bankName, bank)
    fileByBankName.set(bank.bankName, f)
    totalWaves += bank.entries.length
    for (const e of bank.entries) {
      if (e.formatTag !== 0 || e.bitsPerSample !== 16) nonPcm++
      const key = `${e.channels}ch ${e.sampleRate}Hz`
      formatHisto.set(key, (formatHisto.get(key) ?? 0) + 1)
    }
  } catch (err) {
    xwbErrors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
check(xwbErrors.length === 0, `alle Banks parsen (${xwbErrors.length} Fehler)`)
for (const e of xwbErrors.slice(0, 5)) console.log(`      ${e}`)
// Referenzwert gemessen (explore-xwb.mjs): ein zu klein gelesenes
// dwEntryCount bliebe sonst unsichtbar grün.
check(totalWaves === 1737, `1737 Waves gesamt (${totalWaves}) in ${banksByName.size} Banks`)
for (const [k, n] of [...formatHisto].sort((a, b) => b[1] - a[1])) {
  console.log(`  ·  ${String(n).padStart(5)} × ${k}`)
}
check(nonPcm === 0, `jede Wave ist PCM16 (${nonPcm} Abweichler) — kein Codec nötig`)
// Datei- und Bankname dürfen nicht gleichgesetzt werden: die .xsb löst über
// den INNEREN Namen auf (XAS_Weapons.xwb heißt innen 'XAS_Weapon').
check(
  banksByName.has('XAS_Weapon') && !banksByName.has('XAS_Weapons'),
  `XAS_Weapons.xwb trägt den inneren Banknamen 'XAS_Weapon' (Auflösung über Bankname, nicht Dateiname)`,
)

// ── 2. Sound Banks: alle 80 .xsb, jede Cue bis (Bank, Wave) ────────────────
console.log('\n== Sound Banks (sounds/*.xsb) ==')
const xsbFiles = readdirSync(SOUNDS_DIR).filter((f) => f.endsWith('.xsb')).sort()
check(xsbFiles.length === 80, `80 .xsb-Dateien gefunden (${xsbFiles.length})`)

const soundBanks = new Map<string, XsbBank>()
let totalCues = 0
let cuesWithVariants = 0
let maxVariants = 1
let badWaveRefs = 0
let cuesWithNonZeroDbVolume = 0
let cuesWithPitch = 0
const xsbErrors: string[] = []
for (const f of xsbFiles) {
  try {
    const sb = parseXsb(readFileSync(`${SOUNDS_DIR}/${f}`))
    soundBanks.set(f, sb)
    totalCues += sb.cues.size
    for (const cue of sb.cues.values()) {
      if (cue.variantCount > 1) {
        cuesWithVariants++
        maxVariants = Math.max(maxVariants, cue.variantCount)
      }
      // The per-sound volume byte (0xB4 = 180 = 0 dB) and pitch (cents) were
      // silently dropped before; confirm they are extracted now.
      if (cue.volume !== 180) cuesWithNonZeroDbVolume++
      if (cue.pitchCents !== 0) cuesWithPitch++
      // Ende-zu-Ende: der Verweis muss in eine echte, geparste Bank zeigen
      // und der Wave-Index existieren.
      const bank = banksByName.get(sb.waveBanks[cue.waveBankIndex]!)
      if (!bank || cue.waveIndex >= bank.entries.length) badWaveRefs++
    }
  } catch (err) {
    xsbErrors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
check(xsbErrors.length === 0, `alle Sound Banks parsen (${xsbErrors.length} Fehler)`)
for (const e of xsbErrors.slice(0, 5)) console.log(`      ${e}`)
check(totalCues === 1896, `1896 Cues gesamt (${totalCues}) — Zahl aus docs/research/effects-audio.md`)
// The XACT sound header carries a volume byte @+3 and a pitch s16 @+4; both
// were skipped before. Most sounds are authored at a non-0 dB level, and a
// couple hundred carry a pitch offset — extracting them fixes near-universal
// wrong mix levels.
check(
  cuesWithNonZeroDbVolume > 1000,
  `per-sound volume is extracted: ${cuesWithNonZeroDbVolume} cues at a non-0 dB level`,
)
check(cuesWithPitch > 100, `per-sound pitch is extracted: ${cuesWithPitch} cues with a pitch offset`)
check(
  badWaveRefs === 0,
  `jede Cue zeigt in eine existierende Bank auf einen existierenden Wave-Index (${badWaveRefs} kaputt)`,
)
// Stufe-1-Entscheidung dokumentieren: FA hat KEINE Cue-Variationstabellen
// (der Parser würde werfen), aber Track-Variation-Events mit 2–6 Waves.
console.log(
  `  ·  ${cuesWithVariants} von ${totalCues} Cues haben Wave-Variationen (Playlist, max. ${maxVariants}) — Stufe 1 nimmt Eintrag 0`,
)

// ── 3. Voice-Banks: gleiche Formate, eigene Verzeichnisse ──────────────────
console.log('\n== Voice-Banks (sounds/Voice/US, /DE) ==')
let voiceWaves = 0
let voiceCues = 0
let voiceBad = 0
const voiceErrors: string[] = []
for (const lang of ['US', 'DE']) {
  const dir = `${SOUNDS_DIR}/Voice/${lang}`
  const localBanks = new Map<string, XwbBank>()
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.xwb')).sort()) {
    try {
      const bank = parseXwb(readFileSync(`${dir}/${f}`))
      localBanks.set(bank.bankName, bank)
      voiceWaves += bank.entries.length
    } catch (err) {
      voiceErrors.push(`${lang}/${f}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.xsb')).sort()) {
    try {
      const sb = parseXsb(readFileSync(`${dir}/${f}`))
      voiceCues += sb.cues.size
      for (const cue of sb.cues.values()) {
        const bank = localBanks.get(sb.waveBanks[cue.waveBankIndex]!)
        if (!bank || cue.waveIndex >= bank.entries.length) voiceBad++
      }
    } catch (err) {
      voiceErrors.push(`${lang}/${f}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
check(voiceErrors.length === 0, `alle Voice-Banks parsen (${voiceErrors.length} Fehler)`)
for (const e of voiceErrors.slice(0, 5)) console.log(`      ${e}`)
check(voiceCues === 2550, `2550 Voice-Cues gesamt (${voiceCues}) — Referenzwert gemessen`)
check(voiceBad === 0, `alle Voice-Wave-Verweise gültig (${voiceBad} kaputt)`)
console.log(`  ·  ${voiceWaves} Voice-Waves`)

// ── 4. Stichproben: Cue → WAV mit plausiblem Header ────────────────────────
console.log('\n== Stichproben bis zum PCM ==')
const samples: { xsb: string; cue: string; expectChannels: number; expectRate: number }[] = [
  // Musik: Streaming-Bank, Stereo 44,1 kHz (Cue-Liste aus lua/UserMusic.lua)
  { xsb: 'Music.xsb', cue: 'Main_Menu', expectChannels: 2, expectRate: 44100 },
  // Unit-Loop aus dem Blueprint-Beispiel UEL0201 (Audio.AmbientMove)
  { xsb: 'UEL.xsb', cue: 'UEL0201_Move_Loop', expectChannels: 1, expectRate: 32000 },
  // Explosion mit eigener Bank-Liste (Explosions + ExplosionsStream)
  { xsb: 'Explosions.xsb', cue: 'UEF_Nuke_Impact', expectChannels: 1, expectRate: 32000 },
  // UI-Sound (Interface.xsb, 119 Cues)
  { xsb: 'Interface.xsb', cue: 'UI_Menu_Rollover', expectChannels: 1, expectRate: 32000 },
]

let probeWav: Uint8Array | null = null
for (const s of samples) {
  const sb = soundBanks.get(s.xsb)
  const cue = sb?.cues.get(s.cue)
  check(cue !== undefined, `${s.xsb} kennt Cue "${s.cue}"`)
  if (!sb || !cue) continue
  // Kein `!`-Durchmarsch: schlug vorher eine Bank fehl, soll die Suite hier
  // FAIL zählen und weiterlaufen, nicht mit einem TypeError abbrechen.
  const bankName = sb.waveBanks[cue.waveBankIndex]
  const bank = bankName !== undefined ? banksByName.get(bankName) : undefined
  const entry = bank?.entries[cue.waveIndex]
  const file = bankName !== undefined ? fileByBankName.get(bankName) : undefined
  check(
    entry !== undefined && file !== undefined,
    `${s.cue}: Bank "${bankName}" geparst und Wave ${cue.waveIndex} vorhanden`,
  )
  if (!entry || !file || bankName === undefined) continue
  // Die Bank-Datei erneut lesen — der Dateiname kommt über den INNEREN
  // Banknamen (XAS_Weapon ≠ XAS_Weapons.xwb).
  const wav = wavFromEntry(readFileSync(`${SOUNDS_DIR}/${file}`), entry)
  if (!probeWav) probeWav = wav

  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const riff = String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)
  const wave = String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)
  const channels = dv.getUint16(22, true)
  const rate = dv.getUint32(24, true)
  const byteRate = dv.getUint32(28, true)
  const dataLen = dv.getUint32(40, true)
  const secondsFromBytes = dataLen / byteRate
  const secondsFromDuration = entry.duration / entry.sampleRate
  const deviation = Math.abs(secondsFromBytes - secondsFromDuration) / secondsFromDuration

  check(
    riff === 'RIFF' && wave === 'WAVE' && dataLen > 0,
    `${s.cue} → ${bankName}[${cue.waveIndex}]: RIFF/WAVE, ${dataLen} B PCM, ${secondsFromBytes.toFixed(2)} s`,
  )
  check(
    channels === s.expectChannels && rate === s.expectRate,
    `${s.cue}: ${channels} Kanal/Kanäle @ ${rate} Hz (erwartet ${s.expectChannels} @ ${s.expectRate})`,
  )
  check(
    deviation < 0.05,
    `${s.cue}: Duration-Feld (${secondsFromDuration.toFixed(3)} s) vs. Bytes/Byterate (${secondsFromBytes.toFixed(3)} s), Abweichung ${(deviation * 100).toFixed(2)} %`,
  )
}

// ── 5. Probe-WAV auf Platte ────────────────────────────────────────────────
console.log('\n== Probe-WAV ==')
// Vorrangig der Session-Scratchpad (Auftrag); auf fremden Rechnern fällt der
// Pfad sichtbar auf os.tmpdir() zurück — die Suite bleibt damit portabel.
const PROBE_DIRS = [
  process.env.CFA_AUDIO_PROBE_DIR,
  'C:/Users/Marti/AppData/Local/Temp/claude/c--Users-Marti-Documents-02Projekte-Claude-Commander-Forged-Alliance/795d25b0-6aed-4269-81c5-1f3b66283dbf/scratchpad',
  `${tmpdir()}/cfa-audio`,
].filter((d): d is string => d !== undefined)
if (probeWav) {
  let probePath: string | null = null
  for (const dir of PROBE_DIRS) {
    try {
      mkdirSync(dir, { recursive: true })
      probePath = `${dir}/probe.wav`
      break
    } catch {
      /* nächster Kandidat */
    }
  }
  check(probePath !== null, `Probe-Verzeichnis anlegbar (${probePath ?? PROBE_DIRS.join(' | ')})`)
  if (probePath !== null) {
    writeFileSync(probePath, probeWav)
    const back = readFileSync(probePath)
    check(
      back.length === probeWav.length &&
        back.toString('ascii', 0, 4) === 'RIFF' &&
        back.toString('ascii', 8, 12) === 'WAVE',
      `probe.wav geschrieben und RIFF-Magic verifiziert (${back.length} B): ${probePath}`,
    )
  }
} else {
  check(false, 'kein Stichproben-WAV erzeugt')
}

// --- XACT global settings (SupCom.xgs): categories for the volume path ----
console.log('\n== SupCom.xgs: Kategorien, Hierarchie, Volumes ==')
{
  const xgs = parseXgs(readFileSync(`${SOUNDS_DIR}/SupCom.xgs`))
  check(xgs.categories.length === 39, `${xgs.categories.length} Kategorien (Header 0x13 = 39)`)
  const byName = new Map(xgs.categories.map((c, i) => [c.name, { c, i }]))
  const music = byName.get('Music')
  check(
    music !== undefined && music.c.instanceLimit === 1 && music.c.fadeOutMs === 200,
    `Music: instanceLimit 1, fadeOut 200 ms (${music?.c.instanceLimit}/${music?.c.fadeOutMs})`,
  )
  // Hierarchy: Units -> World -> Global (root -1).
  const units = byName.get('Units')
  const world = byName.get('World')
  const global = byName.get('Global')
  check(
    units !== undefined && world !== undefined && global !== undefined &&
      units.c.parent === world.i && world.c.parent === global.i && global.c.parent === -1,
    'Hierarchie: Units → World → Global (Wurzel -1)',
  )
  // Volume byte decoding: 0xB4 = 0 dB (Units), Interface -5 dB, Global +6 dB.
  const iface = byName.get('Interface')
  check(
    Math.abs(units!.c.volumeDb) < 0.1 &&
      Math.abs(iface!.c.volumeDb + 5) < 0.1 &&
      Math.abs(global!.c.volumeDb - 6) < 0.1,
    `dB-Dekodierung: Units ${units!.c.volumeDb.toFixed(1)}, Interface ${iface!.c.volumeDb.toFixed(1)}, Global ${global!.c.volumeDb.toFixed(1)}`,
  )
  check(
    xgs.variables.some((v) => v.name === 'SpeedOfSound' && Math.abs(v.initial - 343.5) < 0.01),
    'Variable SpeedOfSound: init 343.5 m/s',
  )

  // xsb -> xgs: the sound header's u16 category indexes this table
  // (verified pairs from the format research).
  const musicBank = parseXsb(readFileSync(`${SOUNDS_DIR}/Music.xsb`))
  const anyMusicCue = [...musicBank.cues.values()][0]
  check(anyMusicCue?.category === music!.i, `Music.xsb-Cues → Kategorie ${music!.i} (Music)`)
  const ifaceBank = parseXsb(readFileSync(`${SOUNDS_DIR}/Interface.xsb`))
  const menuCue = ifaceBank.cues.get('X_Main_Menu_On')
  check(menuCue?.category === iface!.i, `Interface.xsb 'X_Main_Menu_On' → Kategorie ${iface!.i} (Interface)`)
}

// === XACT playback semantics: loops, variations, limits (measured facts) ===
{
  console.log('\n== Loops, Variationen, Instanz-Limits (alle 100 Banks) ==')
  let loopInf = 0
  let loopFinite: string[] = []
  let newVarOnLoop: string[] = []
  let trackVarCues = 0
  let playlistSizesOk = true
  for (const f of xsbFiles) {
    let sb: XsbBank
    try {
      sb = parseXsb(readFileSync(`${SOUNDS_DIR}/${f}`))
    } catch {
      continue
    }
    for (const [name, cue] of sb.cues) {
      if (cue.loopCount === 255) loopInf++
      else if (cue.loopCount > 0) loopFinite.push(`${sb.soundBankName}:${name}=${cue.loopCount}`)
      if (cue.playlist && cue.newVariationOnLoop) newVarOnLoop.push(`${sb.soundBankName}:${name}`)
      if (cue.playlist) {
        trackVarCues++
        if (cue.playlist.length < 2 || cue.playlist.length > 6) playlistSizesOk = false
        if (cue.playlist.length !== cue.variantCount) playlistSizesOk = false
      }
    }
  }
  // 384 infinite loop events measured; several sounds are shared by more
  // than one cue name, so the CUE count may exceed the event count — but
  // every looper must be infinite except the two known finite outliers.
  check(loopInf >= 384, `${loopInf} cues with loopCount 255 (>= 384 measured loop events)`)
  // The measurement counted EVENTS: the second finite looper
  // (XRL_Stream:Op5_Megalith_Fire loop=4) sits in a LATER event of a
  // multi-event sound — the stage-1 parser resolves the FIRST play event
  // (documented decision), so at cue level exactly one finite looper
  // remains.
  check(
    loopFinite.length === 1 && loopFinite[0]!.includes('UEL0203_Move_Water_Lp=1'),
    `the finite looper at cue level is the measured outlier (${loopFinite.join(', ')})`,
  )
  check(
    newVarOnLoop.length === 2 &&
      newVarOnLoop.some((s) => s.endsWith(':Base_Building')) &&
      newVarOnLoop.some((s) => s.endsWith(':Battle')),
    `new-variation-on-loop is exactly Music Base_Building+Battle (${newVarOnLoop.join(', ')})`,
  )
  check(trackVarCues >= 123, `${trackVarCues} cues carry a playlist (>= 123 measured events)`)
  check(playlistSizesOk, 'every playlist has 2-6 entries and matches variantCount')

  // Category instance limits (SupCom.xgs measured): Music 1/ReplaceOldest/
  // 200 ms fadeOut is the music crossfade; World 200/FailToPlay/100 ms.
  const xgs = parseXgs(readFileSync(`${SOUNDS_DIR}/SupCom.xgs`))
  const cat = (n: string) => xgs.categories.find((c) => c.name === n)
  const music = cat('Music')
  const world = cat('World')
  check(
    music !== undefined &&
      music.instanceLimit === 1 &&
      music.instanceFlags >> 3 === 2 &&
      music.fadeOutMs === 200,
    `Music category: limit 1, ReplaceOldest, 200 ms fade-out (${music?.instanceLimit}/${(music?.instanceFlags ?? 0) >> 3}/${music?.fadeOutMs})`,
  )
  check(
    world !== undefined && world.instanceLimit === 200 && world.instanceFlags >> 3 === 0,
    `World category: limit 200, FailToPlay (${world?.instanceLimit}/${(world?.instanceFlags ?? 0) >> 3})`,
  )

  // Cue-level limits: the Interface UI cues use replace behaviors.
  const iface2 = parseXsb(readFileSync(`${SOUNDS_DIR}/Interface.xsb`))
  const accept = iface2.cues.get('UI_Menu_Accept_01')
  const mapSel = iface2.cues.get('UI_Skirmish_Map_Select')
  check(
    accept !== undefined && accept.instanceLimit === 2 && accept.limitBehavior === 2,
    `UI_Menu_Accept_01: limit 2, ReplaceOldest (${accept?.instanceLimit}/${accept?.limitBehavior})`,
  )
  check(
    mapSel !== undefined && mapSel.instanceLimit === 1 && mapSel.limitBehavior === 4,
    `UI_Skirmish_Map_Select: limit 1, ReplaceLowestPriority (${mapSel?.instanceLimit}/${mapSel?.limitBehavior})`,
  )
}

console.log(failures === 0 ? '\nAUDIO BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
