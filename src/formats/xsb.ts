/**
 * Parser für XACT Sound Banks (.xsb, Magic 'SDBK') von SupCom:FA — löst jede
 * Cue bis zu (WaveBank-Name, Wave-Index) auf.
 *
 * Kopfstruktur hex-verifiziert (docs/research/effects-audio.md §4); die
 * Cue→Sound→Track-Kette wurde aus MonoGame (SoundBank/XactSound/XactClip.cs)
 * und FAudio (FACT_internal.c, FACT_CONTENT_VERSION_3_0 = 43) übernommen und
 * byte-genau gegen die echten Dateien gemessen: ALLE 100 .xsb der Installation
 * (80 in sounds/ + 20 in sounds/Voice/*, zusammen 4446 Cues) parsen ohne einen
 * einzigen entryLength-Mismatch, jeder Event-Separator ist 0xFF, jede Cue
 * löst sich zu einer Wave auf.
 *
 *   Header (verifiziert an Music.xsb, UnitRumble.xsb, URLWeapon.xsb u. a.):
 *     0x00  char[4] 'SDBK'
 *     0x04  u16 = 43, 0x06 u16 = 43   (Tool-/Formatversion, XACT 3.0)
 *     0x13  u16 numSimpleCues          0x15  u16 numComplexCues
 *     0x19  u16 Hash-Bucket-Zahl (16 bei Music/UnitRumble — KEINE Cue-Zahl)
 *     0x1B  u8  numWaveBanks           0x1C  u16 numSounds
 *     0x1E  u32 cueNamesLength
 *     0x22  i32 simpleCuesOffset (-1 wenn keine)   0x26  i32 complexCuesOffset
 *     0x2A  i32 cueNamesOffset (null-getrennt: erst Simple-, dann Complex-Cues)
 *     0x32  i32 variationTablesOffset  0x36  i32 transitionTablesOffset
 *     0x3A  i32 waveBankNameTableOffset (64 B je Name)
 *     0x3E/0x42 Cue-Namen-Hashtabelle (für die Auflösung unnötig)
 *     0x46  i32 soundsOffset           0x4A  char[64] soundBankName
 *
 *   Simple Cue (5 B):   u8 flags, u32 soundOffset
 *   Complex Cue (15 B): u8 flags, u32 code, u32 transitionOffset,
 *                       u8 instanceLimit, u16 fadeInMs, u16 fadeOutMs, u8 instanceFlags
 *     flags & 0x04 → code = Sound-Offset. Sonst Variationstabelle — kommt in
 *     FA NIE vor (0 von 1896 Cues, gemessen) und wirft deshalb.
 *
 *   Sound (Header 9 B): u8 flags, u16 category, u8 volume, s16 pitch,
 *                       u8 priority, u16 entryLength (Gesamtlänge — der
 *                       Parser prüft sie nach dem Event-Parse exakt nach)
 *     flags&0x01: complex → u8 numClips; sonst direkt {u16 wave, u8 bank}
 *     flags&0x0E: RPC-Block  {u16 len inkl. Längenfeld, …} → überspringen
 *     flags&0x10: DSP-Block — in FA nie gesetzt (gemessen), wirft
 *     Clip-Metadaten (XACT 3.0 = 5 B, OHNE die Filterfelder von 3.4!):
 *                       u8 volume, u32 eventListOffset
 *
 *   Event-Liste: u8 numEvents, je Event
 *     u32 info (Typ[4:0], Timestamp[20:5]), u16 randomOffset, u8 Separator 0xFF
 *     Typ 1  PlayWave:           u8 flags, u16 wave, u8 bank, u8 loopCount,
 *                                u16 position, u16 angle
 *     Typ 4  + Effekt-Variation: Typ 1 + 7 B {s16 minPitch, s16 maxPitch,
 *                                u8 minVol, u8 maxVol, u8 varFlags}
 *                                (XACT 3.0! In 3.4 sind es 22 B mit Filter-
 *                                Floats — gemessen an URLWeapon.xsb @0x10a:
 *                                ±200 Promille Pitch, Ende exakt entryLength)
 *     Typ 3  + Track-Variation:  u8 flags, u8 loopCount, u16 position,
 *                                u16 angle, u32 (count | varFlags<<16),
 *                                4 B unbekannt, count × {u16 wave, u8 bank,
 *                                u8 weightMin, u8 weightMax}
 *     Typ 6  = Typ 3 mit den 7 Effekt-Bytes vor der Playlist
 *     Gemessene Event-Typen in FA: nur 1 (170×), 3 (5×), 4 (1557×), 6 (118×) —
 *     alles andere wirft.
 *
 * Stufe-1-Entscheidungen (dokumentiert, von der Suite gemeldet):
 *   – Bei mehreren Clips zählt der erste Clip mit Play-Event (81 Sounds haben
 *     mehr als einen Clip; Reihenfolge = Dateireihenfolge).
 *   – Bei Track-Variation (Typ 3/6) wird der ERSTE Playlist-Eintrag genommen;
 *     `variantCount` trägt die echte Zahl (2–6), damit später die
 *     Zufallsauswahl nachgerüstet werden kann.
 */

export interface XsbCueTarget {
  /** Index in `waveBanks` (names of .xwb banks — their INNER names). */
  waveBankIndex: number
  /** Wave index within the bank. */
  waveIndex: number
  /** Number of wave alternatives (1 = no variation; level 1 takes entry 0). */
  variantCount: number
  /**
   * XACT category index (u16 in the sound header) — 0-based into the xgs
   * category table (verified: Music.xsb cues -> 2 Music, UAAWeapon -> 6
   * Weapons, Interface.xsb menu cues -> 9 Interface / selects -> 19).
   */
  category: number
}

export interface XsbBank {
  soundBankName: string
  /** WaveBank names in reference order (XAA.xsb → 'UAA': across banks!). */
  waveBanks: string[]
  cues: Map<string, XsbCueTarget>
}

function readCString64(bytes: Uint8Array, offset: number): string {
  let end = offset
  while (end < offset + 64 && bytes[end] !== 0) end++
  return new TextDecoder('ascii').decode(bytes.subarray(offset, end))
}

export function parseXsb(bytes: Uint8Array): XsbBank {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u8 = (o: number): number => view.getUint8(o)
  const u16 = (o: number): number => view.getUint16(o, true)
  const u32 = (o: number): number => view.getUint32(o, true)

  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4))
  if (magic !== 'SDBK') throw new Error(`XSB: falsches Magic "${magic}" (erwartet SDBK)`)
  if (u16(4) !== 43 || u16(6) !== 43) {
    throw new Error(`XSB: Version ${u16(4)}/${u16(6)} (expected 43/43, XACT 3.0)`)
  }

  const numSimpleCues = u16(0x13)
  const numComplexCues = u16(0x15)
  const numWaveBanks = u8(0x1b)
  // u16 as in MonoGame/FAudio; the u16 @0x20 behind it is unknown and in
  // all 100 FA files 0 (measured) — the documentation reads the 4 bytes as u32.
  const cueNamesLength = u16(0x1e)
  const simpleCuesOffset = view.getInt32(0x22, true)
  const complexCuesOffset = view.getInt32(0x26, true)
  const cueNamesOffset = view.getInt32(0x2a, true)
  const waveBankNamesOffset = view.getInt32(0x3a, true)
  const soundBankName = readCString64(bytes, 0x4a)

  const waveBanks: string[] = []
  for (let i = 0; i < numWaveBanks; i++) {
    waveBanks.push(readCString64(bytes, waveBankNamesOffset + i * 64))
  }

  // Cue names: zero-separated list, order = simple, then complex cues
  // (MonoGame SoundBank.cs:108/130; measured: number of names == cue number in
  // all 100 files).
  const cueNames: string[] = []
  if (cueNamesLength > 0) {
    const raw = new TextDecoder('ascii').decode(
      bytes.subarray(cueNamesOffset, cueNamesOffset + cueNamesLength),
    )
    for (const name of raw.split('\0')) if (name.length > 0) cueNames.push(name)
  }
  if (cueNames.length !== numSimpleCues + numComplexCues) {
    throw new Error(
      `XSB ${soundBankName}: ${cueNames.length} cue names for ${numSimpleCues}+${numComplexCues} cues`,
    )
  }

  /**
   * Einen Sound-Eintrag parsen und zur ersten Wave auflösen. Läuft durch ALLE
   * Clips und Events und prüft am Ende exakt gegen entryLength — damit ist
   * jede Struktur-Abweichung ein harter Fehler statt stiller Unsinn.
   */
  function resolveSound(off: number): XsbCueTarget {
    const flags = u8(off)
    const category = u16(off + 1) // 0-based xgs category index (header, s. o.)
    const entryLength = u16(off + 7)
    let p = off + 9
    const complex = (flags & 0x01) !== 0

    let direct: XsbCueTarget | null = null
    let numClips = 0
    if (complex) {
      numClips = u8(p)
      p += 1
    } else {
      direct = { waveIndex: u16(p), waveBankIndex: u8(p + 2), variantCount: 1, category }
      p += 3
    }
    if ((flags & 0x0e) !== 0) p += u16(p) // RPC-Block; Länge inkl. Längenfeld
    if ((flags & 0x10) !== 0) {
      // DSP does not appear in any FA bank (0 of 4446 sounds) — block size would be
      // cannot be checked against real data here, so guess instead of guessing.
      throw new Error(`XSB ${soundBankName}: Sound @${off} hat DSP-Flag — in FA nie beobachtet`)
    }

    if (!complex) {
      if (p - off !== entryLength) {
        throw new Error(`XSB ${soundBankName}: Sound @${off} misst ${p - off} B, entryLength sagt ${entryLength}`)
      }
      return direct as XsbCueTarget
    }

    // Clip metadata, then the event lists (located behind the metadata).
    const clipOffsets: number[] = []
    for (let c = 0; c < numClips; c++) {
      clipOffsets.push(u32(p + 1)) // +0 wäre u8 volume
      p += 5
    }
    let target: XsbCueTarget | null = null
    let end = p
    for (const clipOffset of clipOffsets) {
      p = clipOffset
      const numEvents = u8(p)
      p += 1
      for (let e = 0; e < numEvents; e++) {
        const type = u32(p) & 0x1f
        p += 6 // u32 info + u16 randomOffset
        const separator = u8(p)
        p += 1
        if (separator !== 0xff) {
          throw new Error(`XSB ${soundBankName}: Event-Separator 0x${separator.toString(16)} @${p - 1} (erwartet 0xFF)`)
        }
        if (type === 1 || type === 4) {
          const waveIndex = u16(p + 1)
          const waveBankIndex = u8(p + 3)
          p += 9 // flags, wave, bank, loopCount, position, angle
          if (type === 4) p += 7 // Effekt-Variation (XACT 3.0: 7 B, s. o.)
          if (!target) target = { waveBankIndex, waveIndex, variantCount: 1, category }
        } else if (type === 3 || type === 6) {
          p += 6 // flags, loopCount, position, angle
          if (type === 6) p += 7
          const count = u16(p) // u32 = count | varFlags<<16
          p += 8 // + 4 B unbekannt (FAudio FACT_internal.c:2312)
          for (let j = 0; j < count; j++) {
            if (j === 0 && !target) {
              target = { waveIndex: u16(p), waveBankIndex: u8(p + 2), variantCount: count, category }
            }
            p += 5 // u16 wave, u8 bank, u8 weightMin, u8 weightMax
          }
        } else {
          throw new Error(`XSB ${soundBankName}: Event-Typ ${type} @${p - 7} — in FA nie beobachtet`)
        }
      }
      end = Math.max(end, p)
    }
    if (end - off !== entryLength) {
      throw new Error(`XSB ${soundBankName}: Sound @${off} misst ${end - off} B, entryLength sagt ${entryLength}`)
    }
    if (!target) {
      throw new Error(`XSB ${soundBankName}: Sound @${off} does not have a PlayWave event`)
    }
    return target
  }

  const cues = new Map<string, XsbCueTarget>()
  const setCue = (name: string, target: XsbCueTarget): void => {
    // Duplicate names would be silently swallowed in the map - none appear in FA
    // (measured across all 100 banks), everything else is a structural error.
    if (cues.has(name)) throw new Error(`XSB ${soundBankName}: Cue name "${name}" duplicated`)
    cues.set(name, target)
  }
  for (let i = 0; i < numSimpleCues; i++) {
    const o = simpleCuesOffset + i * 5
    setCue(cueNames[i]!, resolveSound(u32(o + 1)))
  }
  for (let i = 0; i < numComplexCues; i++) {
    const o = complexCuesOffset + i * 15
    const flags = u8(o)
    if ((flags & 0x04) === 0) {
      // Cue variation table: 0 of 1896 FA cues — the layout would just be off
      // Taken from external sources and cannot be checked against a real file.
      throw new Error(`XSB ${soundBankName}: Cue "${cueNames[numSimpleCues + i]}" uses a variation table — never observed in FA`)
    }
    setCue(cueNames[numSimpleCues + i]!, resolveSound(u32(o + 1)))
  }

  const targets: XsbCueTarget[] = [...cues.values()]
  for (const t of targets) {
    if (t.waveBankIndex >= waveBanks.length) {
      throw new Error(`XSB ${soundBankName}: WaveBank-Index ${t.waveBankIndex} ≥ ${waveBanks.length}`)
    }
  }

  return { soundBankName, waveBanks, cues }
}
