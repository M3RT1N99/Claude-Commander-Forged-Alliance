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

// Like scripts/gameFiles.ts (there GAME_DIR) — duplicated here so that the suite
// remains executable without the Lua loader (--import register-lua).
const GAME_DIR =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'
const SOUNDS_DIR = `${GAME_DIR}/sounds`

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// ── 1. Wave Banks: all 78 .xwb from sounds/ ────────────────────────────────
console.log('\n== Wave Banks (sounds/*.xwb) ==')
const xwbFiles = readdirSync(SOUNDS_DIR).filter((f) => f.endsWith('.xwb')).sort()
check(xwbFiles.length === 78, `78 .xwb files found (${xwbFiles.length})`)

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
check(xwbErrors.length === 0, `parse all banks (${xwbErrors.length} error)`)
for (const e of xwbErrors.slice(0, 5)) console.log(`      ${e}`)
// Reference value measured (explore-xwb.mjs): a reading that is too small
// Otherwise, dwEntryCount would remain invisible green.
check(totalWaves === 1737, `1737 waves total (${totalWaves}) in ${banksByName.size} banks`)
for (const [k, n] of [...formatHisto].sort((a, b) => b[1] - a[1])) {
  console.log(`  ·  ${String(n).padStart(5)} × ${k}`)
}
check(nonPcm === 0, `every wave is PCM16 (${nonPcm} deviant) — no codec necessary`)
// File and bank names must not be equated: the .xsb replaces
// the INNER name (XAS_Weapons.xwb is called 'XAS_Weapon' inside).
check(
  banksByName.has('XAS_Weapon') && !banksByName.has('XAS_Weapons'),
  `XAS_Weapons.xwb has the inner bank name 'XAS_Weapon' (resolution via bank name, not file name)`,
)

// ── 2. Sound Banks: all 80 .xsb, each cue up to (bank, wave) ────────────────
console.log('\n== Sound Banks (sounds/*.xsb) ==')
const xsbFiles = readdirSync(SOUNDS_DIR).filter((f) => f.endsWith('.xsb')).sort()
check(xsbFiles.length === 80, `80 .xsb files found (${xsbFiles.length})`)

const soundBanks = new Map<string, XsbBank>()
let totalCues = 0
let cuesWithVariants = 0
let maxVariants = 1
let badWaveRefs = 0
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
      // End-to-end: the reference must point to a real, parsed bank
      // and the wave index exist.
      const bank = banksByName.get(sb.waveBanks[cue.waveBankIndex]!)
      if (!bank || cue.waveIndex >= bank.entries.length) badWaveRefs++
    }
  } catch (err) {
    xsbErrors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
check(xsbErrors.length === 0, `parse all sound banks (${xsbErrors.length} error)`)
for (const e of xsbErrors.slice(0, 5)) console.log(`      ${e}`)
check(totalCues === 1896, `1896 total cues (${totalCues}) — number from docs/research/effects-audio.md`)
check(
  badWaveRefs === 0,
  `each cue points to an existing wave index in an existing bank (${badWaveRefs} broken)`,
)
// Document Stage 1 Decision: FA has NO cue variation tables
// (the parser would throw) but track variation events with 2-6 waves.
console.log(
  `  · ${cuesWithVariants} of ${totalCues} Cues have wave variations (playlist, max. ${maxVariants}) — level 1 takes entry 0`,
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
check(voiceErrors.length === 0, `parse all voice banks (${voiceErrors.length} error)`)
for (const e of voiceErrors.slice(0, 5)) console.log(`      ${e}`)
check(voiceCues === 2550, `2550 voice cues total (${voiceCues}) — reference value measured`)
check(voiceBad === 0, `all voice wave references valid (${voiceBad} broken)`)
console.log(`  ·  ${voiceWaves} Voice-Waves`)

// ── 4. Stichproben: Cue → WAV mit plausiblem Header ────────────────────────
console.log('\n== Samples up to PCM ==')
const samples: { xsb: string; cue: string; expectChannels: number; expectRate: number }[] = [
  // Music: Streaming bank, stereo 44.1 kHz (cue list from lua/UserMusic.lua)
  { xsb: 'Music.xsb', cue: 'Main_Menu', expectChannels: 2, expectRate: 44100 },
  // Unit loop from blueprint example UEL0201 (Audio.AmbientMove)
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
  // No `!` walkthrough: if a bank failed before, the suite should be here
  // Count FAIL and continue running, do not abort with a TypeError.
  const bankName = sb.waveBanks[cue.waveBankIndex]
  const bank = bankName !== undefined ? banksByName.get(bankName) : undefined
  const entry = bank?.entries[cue.waveIndex]
  const file = bankName !== undefined ? fileByBankName.get(bankName) : undefined
  check(
    entry !== undefined && file !== undefined,
    `${s.cue}: Bank "${bankName}" parsed and wave ${cue.waveIndex} present`,
  )
  if (!entry || !file || bankName === undefined) continue
  // Read the bank file again — the file name comes above the INSIDE
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
    `${s.cue}: Duration field (${secondsFromDuration.toFixed(3)} s) vs. bytes/byte rate (${secondsFromBytes.toFixed(3)} s), deviation ${(deviation * 100).toFixed(2)} %`,
  )
}

// ── 5. Sample WAV on record ──────────────────────── ────────────────────────
console.log('\n== Probe-WAV ==')
// Primarily the session scratchpad (job); it falls on other computers
// Path visible on os.tmpdir() - the suite remains portable.
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
  check(probePath !== null, `Probe directory can be created (${probePath ?? PROBE_DIRS.join(' | ')})`)
  if (probePath !== null) {
    writeFileSync(probePath, probeWav)
    const back = readFileSync(probePath)
    check(
      back.length === probeWav.length &&
        back.toString('ascii', 0, 4) === 'RIFF' &&
        back.toString('ascii', 8, 12) === 'WAVE',
      `probe.wav written and RIFF-Magic verified (${back.length} B): ${probePath}`,
    )
  }
} else {
  check(false, 'no sample WAV is generated')
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
    'Hierarchy: Units → World → Global (root -1)',
  )
  // Volume byte decoding: 0xB4 = 0 dB (Units), Interface -5 dB, Global +6 dB.
  const iface = byName.get('Interface')
  check(
    Math.abs(units!.c.volumeDb) < 0.1 &&
      Math.abs(iface!.c.volumeDb + 5) < 0.1 &&
      Math.abs(global!.c.volumeDb - 6) < 0.1,
    `dB decoding: Units ${units!.c.volumeDb.toFixed(1)}, Interface ${iface!.c.volumeDb.toFixed(1)}, Global ${global!.c.volumeDb.toFixed(1)}`,
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
  check(menuCue?.category === iface!.i, `Interface.xsb 'X_Main_Menu_On' → Category ${iface!.i} (Interface)`)
}

console.log(failures === 0 ? '\nAUDIO BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
