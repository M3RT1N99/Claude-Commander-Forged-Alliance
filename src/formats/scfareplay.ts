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
  /**
   * Der Armee-Startblock, ROH (u32-Länge + Bytes).
   *
   * Es ist kein Lua-Quelltext, sondern ein `SCR_ToByteStream`-Baum — direkt
   * nachsehbar: der Block beginnt mit `04` (Tag „Tabelle"), dann `01` (Tag
   * „String") `PlayerColor<NUL>`, dann `00 00 00 80 3F` (Tag „Zahl", Float 1.0).
   * `readLuaValue()` macht daraus einen Wert.
   */
  info: Uint8Array
  /** Die Id-Liste hinter dem Block, terminiert von 0xFF (`BVIntSet::Add`). */
  ids: number[]
}

export interface ReplayHeader {
  /** `"Supreme Commander v1.60.   6"` — die Version, die aufgezeichnet hat. */
  version: string
  /** Der Szenario-Pfad, z. B. `/maps/…/x_scenario.lua`. */
  mapPath: string
  /**
   * `mGameMods` — die Mod-Liste, ROH.
   *
   * NICHT als Text lesen. Diese drei Blöcke sind `SCR_ToByteStream`-Bäume, und
   * `new TextDecoder('latin1')` ist in Node **windows-1252** (nachgemessen:
   * `.encoding === 'windows-1252'`, Byte `0x80` → U+20AC). Ein Text-Dekodieren
   * zerstört damit jedes Byte 0x80-0x9F — und 0x80 ist das dritte Byte des
   * Floats 1.0. Die erste Fassung dieser Datei tat genau das.
   */
  gameMods: Uint8Array
  /** `mScenarioInfo` — die Szenario-Angaben, ROH (siehe `gameMods`). */
  scenarioInfo: Uint8Array
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
export class Reader {
  pos = 0
  private readonly dv: DataView
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }

  get rest(): number {
    return this.b.length - this.pos
  }

  f32(): number {
    this.need(4, 'f32')
    const v = this.dv.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  /** Dieselben vier Bytes als rohes u32 — für den `0xFFFFFFFF`-Sentinel. */
  raw32(): number {
    this.need(4, 'raw32')
    const v = this.dv.getUint32(this.pos, true)
    this.pos += 4
    return v
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

  /** `gpg::Stream::CheckByte` — schauen, ohne zu verbrauchen. */
  peek(): number {
    this.need(1, 'peek')
    return this.dv.getUint8(this.pos)
  }

  bytes(n: number, was: string): Uint8Array {
    this.need(n, was)
    const s = this.b.subarray(this.pos, this.pos + n)
    this.pos += n
    return s
  }

  /** u32-Länge, dann so viele Bytes — das Muster für die Blöcke im Kopf. */
  blob(was: string): Uint8Array {
    const n = this.u32()
    return this.bytes(n, was)
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
    const info = n > 0 ? r.bytes(n, `Armee ${i}`) : new Uint8Array(0)
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

// ─────────────────────────────────────────────────────────────────────────────
// DIE NUTZLASTEN
//
// Bis hierher kennt die Datei nur den Rahmen. Ab hier werden die Datensätze
// gelesen, die etwas über das Spiel sagen.
//
// Jedes Feld unten ist am Decompilat belegt — LESESEITE und SCHREIBSEITE, weil
// die beiden sich gegenseitig kontrollieren:
//
// | Was | Leseseite | Schreibseite |
// | --- | --- | --- |
// | Advance | Cfile:996910-996919 | `CMarshaller::AdvanceBeat` Cfile:999139-999177 |
// | SetCommandSource | Cfile:996923-996927 | — |
// | EntIdSet | `DecodeEntIdSet` Cfile:997440-997444 | — |
// | Ziel | — | `CMarshaller::WriteTarget` Cfile:999433-999493 |
// | Befehlsblock | `DecodeCommandData` Cfile:997521-997590 | `WriteCommandData` Cfile:999299-999428 |
// | Zellen | — | `CMarshaller::WriteCells` Cfile:999496-999541 |
// | Lua-Wert | `SCR_FromByteStream` Cfile:598588-598636 | `SCR_ToByteStream` Cfile:598647 |
// | IssueCommand | Cfile:997095-997115 | `CMarshaller::IssueCommand` Cfile:998554-998604 |
// | LuaSimCallback | `DecodeLuaSimCallback` Cfile:997312-997318 | — |
// ─────────────────────────────────────────────────────────────────────────────

/** Ein Lua-Wert, wie `SCR_FromByteStream` ihn aufbaut. */
export type LuaValue = number | string | boolean | null | LuaTable
export interface LuaTable {
  [k: string]: LuaValue
}

/**
 * `Moho::SCR_FromByteStream` (Cfile:598588-598636), Tag für Tag:
 *
 *   0  Zahl    `Read(&v7, 4)` in ein **float** — 4 Byte, nicht 8
 *   1  String  `ReadString` (NUL-terminiert)
 *   2  nil     ohne Nutzlast
 *   3  bool    `Read(&v5, 1)`
 *   4  Tabelle Schlüssel/Wert-Paare, bis `CheckByte == 5`; dann wird die 5
 *              mit `ReadChar` verbraucht. Ein nil als Schlüssel ODER als Wert
 *              ist im Original `gpg::Die` — hier ein `throw`.
 *   5  fehlplatziert: das Original warnt und liefert nil
 *   sonst: das Original warnt und liefert nil
 *
 * Die beiden Warn-Fälle liefern hier ebenfalls `null`, aber sie WERFEN nicht:
 * das Original liest an der Stelle weiter, und ein Leser, der strenger ist als
 * die Engine, würde gültige Dateien ablehnen.
 */
export function readLuaValue(r: Reader): LuaValue {
  const tag = r.u8()
  switch (tag) {
    case 0:
      return r.f32()
    case 1:
      return r.str()
    case 2:
      return null
    case 3:
      return r.u8() !== 0
    case 4: {
      const t: LuaTable = {}
      // `CheckByte` schaut, ohne zu verbrauchen.
      while (r.peek() !== 5) {
        const k = readLuaValue(r)
        if (k === null) throw new Error('Deserialized nil table key.')
        const v = readLuaValue(r)
        if (v === null) throw new Error('Deserialized nil table value.')
        t[String(k)] = v
      }
      r.u8() // die 5 verbrauchen (ReadChar, Cfile:598628)
      return t
    }
    default:
      // Cfile:598630/598636: warnen und nil zuweisen, NICHT abbrechen.
      return null
  }
}

/** Bequemer Einstieg für die Kopf-Blöcke: ganzer Puffer, muss aufgehen. */
export function readLuaBlob(bytes: Uint8Array, was: string): LuaValue {
  const r = new Reader(bytes)
  const v = readLuaValue(r)
  if (r.rest !== 0) throw new Error(`${was}: ${r.rest} Byte übrig nach dem Lua-Wert`)
  return v
}

/**
 * `Moho::SSTITarget`. Die STRUKTUR ist bewiesen (`WriteTarget`,
 * Cfile:999433-999493): ein Typ-Byte, dann je nach Typ 4 Byte Entity-Id
 * (`AITARGET_Entity`), 12 Byte Position (`AITARGET_Ground`) oder gar nichts.
 *
 * **Die ZAHLEN sind es nicht.** IDA zeigt `Moho::ESTITargetType` nur symbolisch;
 * die numerischen Werte stehen nirgends im Decompilat. `0/1/2` ist aus dem
 * Bestand erschlossen: nur mit dieser Zuordnung gehen die Datensätze byteweise
 * auf. Deshalb WIRFT der Leser bei jedem anderen Wert, statt zu raten — ein
 * unbekannter Typ soll sich melden, nicht durchrutschen.
 */
export const AITARGET_NONE = 0
export const AITARGET_ENTITY = 1
export const AITARGET_GROUND = 2

export interface ReplayTarget {
  type: number
  ent: number | null
  pos: [number, number, number] | null
}

export function readTarget(r: Reader): ReplayTarget {
  const type = r.u8()
  if (type === AITARGET_ENTITY) return { type, ent: r.u32(), pos: null }
  if (type === AITARGET_GROUND) return { type, ent: null, pos: [r.f32(), r.f32(), r.f32()] }
  if (type === AITARGET_NONE) return { type, ent: null, pos: null }
  throw new Error(
    `unbekannter Zieltyp ${type}: ESTITargetType steht im Decompilat nur symbolisch, ` +
      'nur 0/1/2 sind aus dem Bestand belegt',
  )
}

/** `DecodeEntIdSet` (Cfile:997440-997444): `u32` Anzahl, dann Anzahl × `u32`. */
export function readEntIdSet(r: Reader): number[] {
  const n = r.u32()
  const out: number[] = new Array<number>(n)
  for (let i = 0; i < n; i++) out[i] = r.u32()
  return out
}

/**
 * Der Befehlsblock, in der Reihenfolge, in der `WriteCommandData` ihn schreibt
 * (Cfile:999299-999428) und `DecodeCommandData` ihn liest (Cfile:997521-997590).
 *
 * Die Feldnamen sind die des Decompilats — auch die hässlichen. `unk1`, `unk3`,
 * `unk4` und `index` heissen so, weil ihre BEDEUTUNG unbekannt ist; ihre Bytes
 * sind es nicht. Sie hier `speed` oder `priority` zu nennen wäre eine Erfindung.
 */
export interface ReplayCommandData {
  /** `mNextCmdId` — die Befehls-Id des Senders. */
  cmdId: number
  /** 4 Byte, Bedeutung UNBEKANNT (`a4->unk1`, Cfile:999319). */
  unk1: number
  /** `mCommandType`, < 0x28 (Cfile:997525-997537, sonst wirft die Engine). */
  commandType: number
  /** `mIndex` — als Float geschrieben (Cfile:999344), Bedeutung UNBEKANNT. */
  index: number
  target: ReplayTarget
  /** `unk2` — ein ZWEITES Ziel (Cfile:999358-999359). Bedeutung UNBEKANNT. */
  target2: ReplayTarget
  /**
   * `mMaybeOriArgs`/`mOri`: SECHS Floats, oder gar keine.
   *
   * Der erste Wert ist ein Sentinel: ist er roh `0xFFFFFFFF`, entfallen die
   * folgenden 20 Byte (Cfile:999369-999393). Sonst folgen 16 Byte
   * (`mMaybeOriArgs.y`, `.z`, `mOri.x`, `mOri.y`, Cfile:999378-999383) UND
   * noch einmal 4 (`mOri.z`, Cfile:999385-999393) — zusammen mit dem Sentinel
   * also 24 Byte.
   *
   * Hier stand zuerst 5 statt 6. Der fehlende Vierbyter verschob alles danach,
   * und der Fehler tauchte drei Felder später auf: die Zellen-Anzahl las sich
   * als 4 161 536, weil sie in Wahrheit die halbe Bitfolge des Floats 1.0 war.
   */
  ori: [number, number, number, number, number, number] | null
  /** Der Blueprint-Name; leer, wenn keiner (Cfile:999400-999404). */
  blueprint: string
  /** `mCells`: `u32` Anzahl + Anzahl × 4 Byte (Cfile:999512-999541), ROH. */
  cells: Uint8Array
  /** 4 Byte, Bedeutung UNBEKANNT (Cfile:999406-999416). */
  unk3: number
  /** 4 Byte, Bedeutung UNBEKANNT (Cfile:999417-999427). */
  unk4: number
  /** `mLObj` — ein `SCR_ToByteStream`-Wert (Cfile:999428). */
  lua: LuaValue
}

export function readCommandData(r: Reader): ReplayCommandData {
  const cmdId = r.u32()
  const unk1 = r.f32()
  const commandType = r.u8()
  if (commandType >= 0x28) {
    // Cfile:997525-997537: die Engine wirft hier ebenfalls.
    throw new Error(`ungültiger Befehlstyp ${commandType} (>= 0x28)`)
  }
  const index = r.f32()
  const target = readTarget(r)
  const target2 = readTarget(r)

  const oriHead = r.raw32()
  let ori: [number, number, number, number, number, number] | null = null
  if (oriHead !== 0xffffffff) {
    const dv = new DataView(new ArrayBuffer(4))
    dv.setUint32(0, oriHead, true)
    // 16 Byte (Cfile:999378-999383) plus 4 (Cfile:999385-999393).
    ori = [dv.getFloat32(0, true), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]
  }

  const blueprint = r.str()
  const nCells = r.u32()
  const cells = r.bytes(nCells * 4, 'mCells')
  const unk3 = r.u32()
  const unk4 = r.u32()
  const lua = readLuaValue(r)
  return { cmdId, unk1, commandType, index, target, target2, ori, blueprint, cells, unk3, unk4, lua }
}

export interface ReplayIssue {
  /** Die Einheiten, an die der Befehl geht (EntIdSet). */
  units: number[]
  data: ReplayCommandData
  clearQueue: boolean
}

/**
 * `IssueCommand` (0x0C) und `IssueFactoryCommand` (0x0D) — gleicher Aufbau
 * (Cfile:997095-997115 bzw. 997143-997171): EntIdSet, Befehlsblock, ein Byte.
 *
 * Das letzte Byte muss 0 oder 1 sein; die Engine wirft bei allem darüber
 * („Invalid value for ClearQueue flag", Cfile:997107-997112).
 *
 * Der Datensatz muss AUF DAS BYTE aufgehen. Bleibt etwas übrig, stimmt das
 * Layout nicht — und ein Leser, der Reste stillschweigend verwirft, würde
 * genau das verdecken.
 */
export function readIssue(payload: Uint8Array): ReplayIssue {
  const r = new Reader(payload)
  const units = readEntIdSet(r)
  const data = readCommandData(r)
  const clear = r.u8()
  if (clear >= 2) throw new Error(`Invalid value for ClearQueue flag: ${clear}`)
  if (r.rest !== 0) throw new Error(`Issue-Datensatz: ${r.rest} Byte übrig`)
  return { units, data, clearQueue: clear === 1 }
}

/**
 * `Advance` (0x00) — vier Byte, und das ist die einzige Uhr im Strom
 * (Cfile:996910-996919; geschrieben Cfile:999175-999177).
 *
 * Der Wert ist ein DELTA, keine absolute Beat-Nummer: die Empfängerseite
 * addiert ihn auf den zuletzt bestätigten Beat (Cfile:680549-680568).
 */
export function readAdvance(payload: Uint8Array): number {
  const r = new Reader(payload)
  const n = r.u32()
  if (r.rest !== 0) throw new Error(`Advance-Datensatz: ${r.rest} Byte übrig`)
  return n
}

/** `SetCommandSource` (0x01) — ein Byte (Cfile:996923-996927). */
export function readSetCommandSource(payload: Uint8Array): number {
  const r = new Reader(payload)
  const v = r.u8()
  if (r.rest !== 0) throw new Error(`SetCommandSource: ${r.rest} Byte übrig`)
  return v
}

export interface ReplayLuaCallback {
  name: string
  value: LuaValue
  units: number[]
}

/**
 * `LuaSimCallback` (0x16) — DREI Teile, nicht zwei
 * (`DecodeLuaSimCallback`, Cfile:997312-997318): Name, Lua-Wert, EntIdSet.
 *
 * Das ist kein Debug-Verkehr: `GiveOrders` läuft hier durch.
 */
export function readLuaSimCallback(payload: Uint8Array): ReplayLuaCallback {
  const r = new Reader(payload)
  const name = r.str()
  const value = readLuaValue(r)
  const units = readEntIdSet(r)
  if (r.rest !== 0) throw new Error(`LuaSimCallback ${name}: ${r.rest} Byte übrig`)
  return { name, value, units }
}
