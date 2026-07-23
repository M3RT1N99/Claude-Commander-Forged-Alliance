/**
 * TrueType-Metrik — so viel davon, wie die UI braucht.
 *
 * Die Engine misst Text mit der echten Schrift: `CMauiText::GetStringAdvance`
 * (Cfile:1146720) fragt den Font-Renderer nach der Breite, und die vier LazyVars
 * FontAscent/FontDescent/FontExternalLeading/TextAdvance (Cfile:1145928) sind
 * genau diese Zahlen. `text.lua:39` macht aus Ascent+Descent die Höhe, `text.lua:47`
 * aus TextAdvance die Breite — ohne echte Metrik hat kein Text-Control eine Größe.
 *
 * Die Schriften liegen als TTF im Spielordner (`<GameDir>/fonts`, u. a. ARIAL.TTF
 * und zeroes_3.ttf); `lua/skins/skins.lua:24-26` nennt sie beim Namen ("Arial",
 * "Zeroes Three"). Also wird hier die Datei des Spiels gelesen — nicht geschätzt.
 *
 * Gelesen werden nur die Tabellen, die für Breite und Höhe nötig sind:
 *   head  → unitsPerEm (die Skala aller Zahlen)
 *   hhea  → ascender/descender/lineGap, numberOfHMetrics
 *   hmtx  → advanceWidth je Glyph
 *   cmap  → Zeichen → Glyph-Index (Format 4 und 12; alles, was die UI trifft)
 *   name  → Familienname (damit die Datei sich selbst zuordnet)
 * Kerning bleibt außen vor: die Engine rendert die UI-Schrift ohne Kerning-Paare
 * (kein `kern`-Zugriff im Text-Pfad), und Arial/Zeroes hätten hier ohnehin keins.
 */
export interface FontMetrics {
  family: string
  unitsPerEm: number
  ascent: number
  descent: number
  lineGap: number
  /** Width of a string in pixels, given the point size. */
  advance(text: string, size: number): number
}

export function parseTtf(bytes: Uint8Array): FontMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u8 = (o: number): number => view.getUint8(o)
  const u16 = (o: number): number => view.getUint16(o)
  const i16 = (o: number): number => view.getInt16(o)
  const u32 = (o: number): number => view.getUint32(o)

  // sfnt header: 'true'/0x00010000 (TTF) or 'OTTO' (CFF — then glyf is missing,
  // but hmtx/cmap are the same and we don't need anything more).
  const numTables = u16(4)
  const tables = new Map<string, number>()
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = String.fromCharCode(u8(rec), u8(rec + 1), u8(rec + 2), u8(rec + 3))
    tables.set(tag, u32(rec + 8))
  }
  const need = (tag: string): number => {
    const off = tables.get(tag)
    if (off === undefined) throw new Error(`TTF: Tabelle '${tag}' fehlt`)
    return off
  }

  const head = need('head')
  const unitsPerEm = u16(head + 18)
  const indexToLocFormat = i16(head + 50)
  void indexToLocFormat

  const hhea = need('hhea')
  const ascent = i16(hhea + 4)
  const descent = i16(hhea + 6)
  const lineGap = i16(hhea + 8)
  const numberOfHMetrics = u16(hhea + 34)

  const hmtx = need('hmtx')
  const advanceOf = (glyph: number): number => {
    // hmtx: numberOfHMetrics pairs(advance, lsb); after that only lsb —
    // all subsequent glyphs inherit the final width (OpenType specification).
    const i = Math.min(glyph, numberOfHMetrics - 1)
    return u16(hmtx + i * 4)
  }

  const cmap = need('cmap')
  const lookup = buildCmap(view, cmap)

  // The FULL name (nameID 4): "Arial", "Arial Bold", "Zeroes Three". Just as
  // the UI addresses its fonts — `UIUtil.bodyFont` is "Arial", but
  // `unitviewDetail.lua` requires "Arial Bold". ARIAL.TTF and ARIALBD.TTF have
  // both the FAMILY "Arial" (nameID 1); whoever encrypts it overwrites it
  // Metric of the basic font with that of the bold one and from then on it measures every text incorrectly.
  const nameTable = tables.get('name')
  const family = readName(view, nameTable, 4) || readName(view, nameTable, 1)

  return {
    family,
    unitsPerEm,
    ascent,
    descent,
    lineGap,
    advance(text: string, size: number): number {
      let units = 0
      for (const ch of text) units += advanceOf(lookup(ch.codePointAt(0)!))
      return (units * size) / unitsPerEm
    },
  }
}

/** cmap → function codepoint → glyph index. Preferably (3,10), then (3,1), then (0,*). */
function buildCmap(view: DataView, cmap: number): (cp: number) => number {
  const numSubtables = view.getUint16(cmap + 2)
  let best = -1
  let bestScore = -1
  for (let i = 0; i < numSubtables; i++) {
    const rec = cmap + 4 + i * 8
    const platform = view.getUint16(rec)
    const encoding = view.getUint16(rec + 2)
    const offset = view.getUint32(rec + 4)
    const score =
      platform === 3 && encoding === 10 ? 4 : platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2 : 1
    if (score > bestScore) {
      bestScore = score
      best = cmap + offset
    }
  }
  if (best < 0) throw new Error('TTF: keine cmap-Subtabelle')

  const format = view.getUint16(best)
  if (format === 4) {
    const segCountX2 = view.getUint16(best + 6)
    const segCount = segCountX2 / 2
    const endCodes = best + 14
    const startCodes = endCodes + segCountX2 + 2
    const idDeltas = startCodes + segCountX2
    const idRangeOffsets = idDeltas + segCountX2
    return (cp: number): number => {
      if (cp > 0xffff) return 0
      for (let s = 0; s < segCount; s++) {
        if (view.getUint16(endCodes + s * 2) < cp) continue
        const start = view.getUint16(startCodes + s * 2)
        if (cp < start) return 0
        const rangeOffset = view.getUint16(idRangeOffsets + s * 2)
        const delta = view.getInt16(idDeltas + s * 2)
        if (rangeOffset === 0) return (cp + delta) & 0xffff
        const gi = view.getUint16(idRangeOffsets + s * 2 + rangeOffset + (cp - start) * 2)
        return gi === 0 ? 0 : (gi + delta) & 0xffff
      }
      return 0
    }
  }
  if (format === 12) {
    const nGroups = view.getUint32(best + 12)
    const groups = best + 16
    return (cp: number): number => {
      for (let g = 0; g < nGroups; g++) {
        const rec = groups + g * 12
        const start = view.getUint32(rec)
        const end = view.getUint32(rec + 4)
        if (cp >= start && cp <= end) return view.getUint32(rec + 8) + (cp - start)
      }
      return 0
    }
  }
  throw new Error(`TTF: cmap-Format ${format} nicht gelesen`)
}

/**
 * Ein Eintrag der name-Tabelle (nameID 1 = Familie, 2 = Schnitt, 4 = voller Name).
 *
 * Zwei Fallen, in die man garantiert tritt:
 *   - Die Kodierung hängt an der Plattform: Windows (3) und Unicode (0) speichern
 *     UTF-16BE, Macintosh (1) einen Byte-String. Wer alles außer 3 als Bytes
 *     liest, bekommt aus einem Unicode-Eintrag " A r i a l ".
 *   - Dieselbe nameID steht mehrfach drin, einmal je SPRACHE. ARIALBD.TTF führt
 *     den Schnitt u. a. als "negreta" (katalanisch). Also wird auf Englisch
 *     (langID 0x0409) bestanden, sonst nimmt man irgendeine Übersetzung.
 */
function readName(view: DataView, name: number | undefined, nameId: number): string {
  if (name === undefined) return ''
  const count = view.getUint16(name + 2)
  const storage = name + view.getUint16(name + 4)
  let best = ''
  let bestScore = -1
  for (let i = 0; i < count; i++) {
    const rec = name + 6 + i * 12
    if (view.getUint16(rec + 6) !== nameId) continue
    const platform = view.getUint16(rec)
    const language = view.getUint16(rec + 4)
    const length = view.getUint16(rec + 8)
    const offset = storage + view.getUint16(rec + 10)
    let s = ''
    if (platform === 3 || platform === 0) {
      for (let o = 0; o + 1 < length; o += 2) s += String.fromCharCode(view.getUint16(offset + o))
    } else {
      for (let o = 0; o < length; o++) s += String.fromCharCode(view.getUint8(offset + o))
    }
    // Windows/en-US beats Windows/others beats Unicode beats Mac.
    const english = language === 0x0409 || (platform !== 3 && language === 0)
    const score = (platform === 3 ? 4 : platform === 0 ? 2 : 0) + (english ? 1 : 0)
    if (s && score > bestScore) {
      best = s
      bestScore = score
    }
  }
  return best
}
