/**
 * Parser for XACT Sound Banks (.xsb, magic 'SDBK') from SupCom:FA — resolves
 * each cue to (wave-bank name, wave index).
 *
 * Header structure hex-verified (docs/research/effects-audio.md §4); the
 * cue→sound→track chain was taken from MonoGame (SoundBank/XactSound/XactClip.cs)
 * and FAudio (FACT_internal.c, FACT_CONTENT_VERSION_3_0 = 43), then measured
 * byte-for-byte against the real files: ALL 100 .xsb files in the installation
 * (80 in sounds/ + 20 in sounds/Voice/*, 4,446 cues total) parse without a
 * single entryLength mismatch, every event separator is 0xFF, and every cue
 * resolves to a wave.
 *
 *   Header (verified against Music.xsb, UnitRumble.xsb, URLWeapon.xsb, etc.):
 *     0x00  char[4] 'SDBK'
 *     0x04  u16 = 43, 0x06 u16 = 43   (Tool-/Formatversion, XACT 3.0)
 *     0x13  u16 numSimpleCues          0x15  u16 numComplexCues
 *     0x19  u16 hash-bucket count (16 for Music/UnitRumble — NOT a cue count)
 *     0x1B  u8  numWaveBanks           0x1C  u16 numSounds
 *     0x1E  u32 cueNamesLength
 *     0x22  i32 simpleCuesOffset (-1 if none)      0x26  i32 complexCuesOffset
 *     0x2A  i32 cueNamesOffset (null-separated: simple cues first, then complex)
 *     0x32  i32 variationTablesOffset  0x36  i32 transitionTablesOffset
 *     0x3A  i32 waveBankNameTableOffset (64 B per name)
 *     0x3E/0x42 cue-name hash table (unneeded for resolution)
 *     0x46  i32 soundsOffset           0x4A  char[64] soundBankName
 *
 *   Simple Cue (5 B):   u8 flags, u32 soundOffset
 *   Complex Cue (15 B): u8 flags, u32 code, u32 transitionOffset,
 *                       u8 instanceLimit, u16 fadeInMs, u16 fadeOutMs, u8 instanceFlags
 *     flags & 0x04 → code = Sound-Offset. Sonst Variationstabelle — kommt in
 *     never occurs in FA (0 of 1,896 measured cues), so it throws.
 *
 *   Sound (Header 9 B): u8 flags, u16 category, u8 volume, s16 pitch,
 *                       u8 priority, u16 entryLength (total length — the
 *                       parser verifies it exactly after parsing events)
 *     flags&0x01: complex → u8 numClips; sonst direkt {u16 wave, u8 bank}
 *     flags&0x0E: RPC block  {u16 len including length field, …} → skip
 *     flags&0x10: DSP block — never set in FA (measured), throws
 *     Clip metadata (XACT 3.0 = 5 B, WITHOUT the filter fields from 3.4!):
 *                       u8 volume, u32 eventListOffset
 *
 *   Event list: u8 numEvents, per event
 *     u32 info (type[4:0], timestamp[20:5]), u16 randomOffset, u8 separator 0xFF
 *     Type 1  PlayWave:          u8 flags, u16 wave, u8 bank, u8 loopCount,
 *                                u16 position, u16 angle
 *     Type 4  + effect variation: Type 1 + 7 B {s16 minPitch, s16 maxPitch,
 *                                u8 minVol, u8 maxVol, u8 varFlags}
 *                                (XACT 3.0! In 3.4 it is 22 B with filter
 *                                floats — measured at URLWeapon.xsb @0x10a:
 *                                ±200 permille pitch, end exactly at entryLength)
 *     Type 3  + track variation: u8 flags, u8 loopCount, u16 position,
 *                                u16 angle, u32 (count | varFlags<<16),
 *                                4 B unknown, count × {u16 wave, u8 bank,
 *                                u8 weightMin, u8 weightMax}
 *     Type 6  = Type 3 with the 7 effect bytes before the playlist
 *     Measured event types in FA: only 1 (170×), 3 (5×), 4 (1,557×), 6 (118×) —
 *     everything else throws.
 *
 * Stage-1 decisions (documented and reported by the suite):
 *   – With multiple clips, the first clip with a Play event is used (81 sounds
 *     have more than one clip; order = file order).
 *   – For track variation (types 3/6), the FIRST playlist entry is used;
 *     `variantCount` carries the real count (2–6) so random selection can be
 *     added later.
 */

export interface XsbCueTarget {
  /** Index in `waveBanks` (names of .xwb banks — their INTERNAL names). */
  waveBankIndex: number
  /** Wave index within the bank. */
  waveIndex: number
  /** Number of wave alternatives (1 = no variation; stage 1 uses entry 0). */
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
  /** Wave-bank names in reference order (XAA.xsb → 'UAA': cross-bank!). */
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
  if (magic !== 'SDBK') throw new Error(`XSB: invalid magic "${magic}" (expected SDBK)`)
  if (u16(4) !== 43 || u16(6) !== 43) {
    throw new Error(`XSB: version ${u16(4)}/${u16(6)} (expected 43/43, XACT 3.0)`)
  }

  const numSimpleCues = u16(0x13)
  const numComplexCues = u16(0x15)
  const numWaveBanks = u8(0x1b)
  // u16 as in MonoGame/FAudio; the following u16 @0x20 is unknown and is 0 in
  // all 100 FA files (measured) — the documentation reads the 4 bytes as u32.
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

  // Cue names: null-separated list, simple cues first, then complex cues
  // (MonoGame SoundBank.cs:108/130; measured: number of names == cue count in
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
   * Parse a sound entry and resolve it to the first wave. Processes ALL clips
   * and events, then verifies exactly against entryLength — every structural
   * deviation is therefore a hard error rather than silent nonsense.
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
    if ((flags & 0x0e) !== 0) p += u16(p) // RPC block; length includes the length field
    if ((flags & 0x10) !== 0) {
      // DSP occurs in no FA bank (0 of 4,446 sounds) — the block size could not
      // be verified against real data, so throw rather than guess.
      throw new Error(`XSB ${soundBankName}: sound @${off} has DSP flag — never observed in FA`)
    }

    if (!complex) {
      if (p - off !== entryLength) {
        throw new Error(`XSB ${soundBankName}: sound @${off} measures ${p - off} B, entryLength reports ${entryLength}`)
      }
      return direct as XsbCueTarget
    }

    // Clip metadata, then event lists (located after the metadata).
    const clipOffsets: number[] = []
    for (let c = 0; c < numClips; c++) {
      clipOffsets.push(u32(p + 1)) // +0 would be u8 volume
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
          throw new Error(`XSB ${soundBankName}: event separator 0x${separator.toString(16)} @${p - 1} (expected 0xFF)`)
        }
        if (type === 1 || type === 4) {
          const waveIndex = u16(p + 1)
          const waveBankIndex = u8(p + 3)
          p += 9 // flags, wave, bank, loopCount, position, angle
          if (type === 4) p += 7 // effect variation (XACT 3.0: 7 B, see above)
          if (!target) target = { waveBankIndex, waveIndex, variantCount: 1, category }
        } else if (type === 3 || type === 6) {
          p += 6 // flags, loopCount, position, angle
          if (type === 6) p += 7
          const count = u16(p) // u32 = count | varFlags<<16
          p += 8 // + 4 B unknown (FAudio FACT_internal.c:2312)
          for (let j = 0; j < count; j++) {
            if (j === 0 && !target) {
              target = { waveIndex: u16(p), waveBankIndex: u8(p + 2), variantCount: count, category }
            }
            p += 5 // u16 wave, u8 bank, u8 weightMin, u8 weightMax
          }
        } else {
          throw new Error(`XSB ${soundBankName}: event type ${type} @${p - 7} — never observed in FA`)
        }
      }
      end = Math.max(end, p)
    }
    if (end - off !== entryLength) {
      throw new Error(`XSB ${soundBankName}: sound @${off} measures ${end - off} B, entryLength reports ${entryLength}`)
    }
    if (!target) {
      throw new Error(`XSB ${soundBankName}: sound @${off} has no PlayWave event`)
    }
    return target
  }

  const cues = new Map<string, XsbCueTarget>()
  const setCue = (name: string, target: XsbCueTarget): void => {
    // Duplicate names would be silently swallowed in the map — none occur in FA
    // (measured across all 100 banks), so anything else is a structural error.
    if (cues.has(name)) throw new Error(`XSB ${soundBankName}: cue name "${name}" is duplicated`)
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
      // Cue variation table: 0 of 1,896 FA cues — its layout would come only
      // from external sources and could not be verified against a real file.
      throw new Error(`XSB ${soundBankName}: cue "${cueNames[numSimpleCues + i]}" uses a variation table — never observed in FA`)
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
