/**
 * `.SCFAReplay` — der aufgezeichnete Befehlsstrom einer Partie.
 *
 * Ein Replay ist kein Videomitschnitt. Es ist der Kopf mit den Startbedingungen
 * plus **derselbe Nachrichtenstrom**, den die Engine im Netzspiel überträgt: das
 * Spiel wird beim Abspielen wirklich neu gerechnet. Deshalb ist die Datei für
 * uns das, was kein selbstgeschriebener Test je sein kann — eine Aufzeichnung
 * dessen, was die **Originalengine** getan hat.
 *
 * Und sie enthält Prüfsummen. `MSGOP_VerifyChecksum` (Opcode 3) trägt den
 * MD5-Digest über die Sim-Totale plus die Beat-Nummer. Damit lässt sich
 * beantworten, ob unsere Sim bei Beat N denselben Zustand hat wie das Original —
 * eine Frage, die sonst niemand stellen kann.
 *
 * **Alles hier stammt aus dem Decompilat, nichts ist geraten:**
 *
 * | Was | Wo |
 * | --- | --- |
 * | Kopf-Layout (Lesereihenfolge) | `Moho::VCR_SetupReplaySession` Cfile:1303988-1304227 |
 * | Marker `"Replay v1.9\r\n"`, 13 Bytes, `strcmp` | Cfile:1304108 |
 * | Versionszeile `"Supreme Commander v%1.2f.%4i"` | Cfile:1304067 |
 * | Nachrichtenrahmen `[u8 op][u16 gesamt LE][nutzlast]` | `Moho::CDecoder::DecodeMessage` Cfile:996781-996800 |
 * | 24 Opcodes, 0x00-0x17 | dieselbe `switch`, Cfile:996812-996905 |
 * | `VerifyChecksum` = 16 B MD5 + `ReadInt` Beat | `DecodeVerifyChecksum` Cfile:996938-996946 |
 *
 * Der Rahmen im Klartext: `start[0]` ist der Opcode, `start[1..2]` die
 * GESAMTLÄNGE des Datensatzes als little-endian `u16` (Kopf eingeschlossen), die
 * Nutzlast beginnt bei `start+3` und ist `gesamt - 3` Bytes lang. Ein
 * Prüfsummen-Datensatz ist damit immer 23 Bytes: `03 17 00` + 16 + 4.
 */

/** Die 24 Opcodes des Befehlsstroms (`CDecoder::DecodeMessage`, Cfile:996812-996905). */
export const MSGOP = [
  'Advance', // 0x00
  'SetCommandSource', // 0x01
  'CommandSourceTerminated', // 0x02
  'VerifyChecksum', // 0x03
  'RequestPause', // 0x04
  'Resume', // 0x05
  'SingleStep', // 0x06
  'CreateUnit', // 0x07
  'CreateProp', // 0x08
  'DestroyEntity', // 0x09
  'WarpEntity', // 0x0A
  'ProcessInfoPair', // 0x0B
  'IssueCommand', // 0x0C
  'IssueFactoryCommand', // 0x0D
  'IncreaseCommandCount', // 0x0E
  'DecreaseCommandCount', // 0x0F
  'SetCommandTarget', // 0x10
  'SetCommandType', // 0x11
  'SetCommandCells', // 0x12
  'RemoveCommandFromQueue', // 0x13
  'DebugCommand', // 0x14
  'ExecuteLuaInSim', // 0x15
  'LuaSimCallback', // 0x16
  'EndGame', // 0x17
] as const

export const MSGOP_VERIFY_CHECKSUM = 3
/** `"Replay v1.9\r\n"` — 13 Bytes, per `strcmp` geprüft (Cfile:1304108). */
export const REPLAY_MARKER = 'Replay v1.9\r\n'

export interface ReplaySource {
  name: string
  value: number
}

export interface ReplayArmy {
  /** Der Lua-Quelltext des Armee-Startblocks (u32-Länge + Bytes). */
  info: string
  /** Die Id-Liste hinter dem Block, terminiert von 0xFF (`BVIntSet::Add`). */
  ids: number[]
}

export interface ReplayHeader {
  /** `"Supreme Commander v1.60.   6"` — die Version, die aufgezeichnet hat. */
  version: string
  /** Der Szenario-Pfad, z. B. `/maps/…/x_scenario.lua`. */
  mapPath: string
  /** `mGameMods` — Lua-Quelltext der Mod-Liste. */
  gameMods: string
  /** `mScenarioInfo` — Lua-Quelltext der Szenario-Angaben. */
  scenarioInfo: string
  sources: ReplaySource[]
  cheatsEnabled: boolean
  armies: ReplayArmy[]
  /** `mInitSeed` — der Startwert des Zufallsgenerators. */
  seed: number
  /** Erstes Byte des Nachrichtenkörpers. */
  bodyOffset: number
}

export interface ReplayMessage {
  /** Dateiposition des Opcode-Bytes. */
  offset: number
  op: number
  /** Der Name aus `MSGOP`, oder `?` bei einem Opcode über 0x17. */
  name: string
  /** Gesamtlänge inklusive der drei Rahmenbytes. */
  size: number
  payload: Uint8Array
}

export interface ReplayChecksum {
  beat: number
  /** Der 16-Byte-Digest als Hex, kleingeschrieben. */
  md5: string
}

/**
 * `gpg::BinaryReader` über einem Puffer. Bewusst minimal: der Leser soll an
 * einem kaputten Replay SCHEITERN, nicht raten. Jede Grenzüberschreitung wirft.
 */
class Reader {
  pos = 0
  private readonly dv: DataView
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }

  private need(n: number, was: string): void {
    if (this.pos + n > this.b.length) {
      throw new Error(
        `${was}: ${n} Byte ab ${this.pos} verlangt, Datei endet bei ${this.b.length}`,
      )
    }
  }

  u8(): number {
    this.need(1, 'u8')
    return this.dv.getUint8(this.pos++)
  }

  u32(): number {
    this.need(4, 'u32')
    const v = this.dv.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  /** `BinaryReader::ReadString` — bis zum NUL, das NUL wird verbraucht. */
  str(): string {
    const end = this.b.indexOf(0, this.pos)
    if (end < 0) throw new Error(`ReadString ab ${this.pos}: kein abschliessendes NUL`)
    const s = new TextDecoder('latin1').decode(this.b.subarray(this.pos, end))
    this.pos = end + 1
    return s
  }

  bytes(n: number, was: string): Uint8Array {
    this.need(n, was)
    const s = this.b.subarray(this.pos, this.pos + n)
    this.pos += n
    return s
  }

  /** u32-Länge, dann so viele Bytes — das Muster für die Lua-Blöcke im Kopf. */
  blob(was: string): string {
    const n = this.u32()
    return new TextDecoder('latin1').decode(this.bytes(n, was))
  }
}

/**
 * Der Kopf, in der Reihenfolge, in der `VCR_SetupReplaySession` ihn liest
 * (Cfile:1304067-1304227).
 */
export function parseReplayHeader(bytes: Uint8Array): ReplayHeader {
  const r = new Reader(bytes)

  const version = r.str() // Cfile:1304070 ReadString, verglichen mit der Versionszeile
  r.str() // Cfile:1304100 ReadString, verworfen — das "\r\n"

  const marker = new TextDecoder('latin1').decode(r.bytes(13, 'Replay-Marker'))
  if (marker !== REPLAY_MARKER) {
    // Cfile:1304108 `strcmp(buf, "Replay v1.9\r\n")` — stimmt es nicht, bricht
    // das Original die Sitzung ab. Wir tun dasselbe statt weiterzuraten.
    throw new Error(`kein Replay v1.9: Marker ist ${JSON.stringify(marker)}`)
  }

  const mapPath = r.str() // Cfile:1304104 ReadString -> str1 -> sesInfo->mMapName
  r.str() // Cfile:1304105 ReadString, verworfen

  const gameMods = r.blob('mGameMods') // Cfile:1304125-1304135
  const scenarioInfo = r.blob('mScenarioInfo') // Cfile:1304136-1304148

  const sources: ReplaySource[] = []
  const nSources = r.u8() // Cfile:1304156
  for (let i = 0; i < nSources; i++) {
    sources.push({ name: r.str(), value: r.u32() }) // Cfile:1304166-1304175
  }

  const cheatsEnabled = r.u8() !== 0 // Cfile:1304182-1304183
  const nArmies = r.u8() // Cfile:1304184

  const armies: ReplayArmy[] = []
  for (let i = 0; i < nArmies; i++) {
    // Cfile:1304198-1304211: u32 Länge (0 = kein Block), dann Bytes; danach
    // Ids bis 0xFF.
    const n = r.u32()
    const info = n > 0 ? new TextDecoder('latin1').decode(r.bytes(n, `Armee ${i}`)) : ''
    const ids: number[] = []
    for (let v = r.u8(); v !== 0xff; v = r.u8()) ids.push(v)
    armies.push({ info, ids })
  }

  const seed = r.u32() // Cfile:1304226 mInitSeed

  return {
    version,
    mapPath,
    gameMods,
    scenarioInfo,
    sources,
    cheatsEnabled,
    armies,
    seed,
    bodyOffset: r.pos,
  }
}

/**
 * Läuft den Nachrichtenkörper ab. Der Rahmen ist der aus `DecodeMessage`
 * (Cfile:996790-996800): Opcode, dann die GESAMTLÄNGE als `u16`.
 *
 * Ein Datensatz kürzer als 3 oder über das Dateiende hinaus ist ein Fehler, kein
 * Grund weiterzusuchen — ein Leser, der sich nach einem Fehler neu synchronisiert,
 * meldet am Ende immer Erfolg und wäre damit wertlos.
 */
export function* readMessages(bytes: Uint8Array, from: number): Generator<ReplayMessage> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = from
  while (p < bytes.length) {
    if (p + 3 > bytes.length) {
      throw new Error(`Rahmen bei ${p} abgeschnitten (nur ${bytes.length - p} Byte übrig)`)
    }
    const op = dv.getUint8(p)
    const size = dv.getUint16(p + 1, true)
    if (size < 3) throw new Error(`Rahmen bei ${p}: Länge ${size} < 3`)
    if (p + size > bytes.length) {
      throw new Error(`Rahmen bei ${p}: Länge ${size} reicht über das Dateiende`)
    }
    yield {
      offset: p,
      op,
      name: MSGOP[op] ?? '?',
      size,
      payload: bytes.subarray(p + 3, p + size),
    }
    p += size
  }
}

/**
 * Nur die Prüfsummen. `DecodeVerifyChecksum` (Cfile:996938-996946) liest 16
 * Bytes Digest und danach den Beat als `int` — Nutzlast also genau 20 Byte,
 * Datensatz 23.
 */
export function readChecksums(bytes: Uint8Array, header?: ReplayHeader): ReplayChecksum[] {
  const h = header ?? parseReplayHeader(bytes)
  const out: ReplayChecksum[] = []
  for (const m of readMessages(bytes, h.bodyOffset)) {
    if (m.op !== MSGOP_VERIFY_CHECKSUM) continue
    if (m.payload.length !== 20) {
      throw new Error(`VerifyChecksum bei ${m.offset}: Nutzlast ${m.payload.length} statt 20`)
    }
    const pv = new DataView(m.payload.buffer, m.payload.byteOffset, m.payload.byteLength)
    let md5 = ''
    for (let i = 0; i < 16; i++) md5 += pv.getUint8(i).toString(16).padStart(2, '0')
    out.push({ beat: pv.getUint32(16, true), md5 })
  }
  return out
}
