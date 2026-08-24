/**
 * TrueType metrics — only as much as the UI needs.
 *
 * The engine measures text with the real font: `CMauiText::GetStringAdvance`
 * (Cfile:1146720) asks the font renderer for width, and the four LazyVars
 * FontAscent/FontDescent/FontExternalLeading/TextAdvance (Cfile:1145928) hold
 * exactly those values. `text.lua:39` derives height from Ascent+Descent and
 * `text.lua:47` derives width from TextAdvance — without real metrics, no text
 * control has a size.
 *
 * The fonts are TTF files in the game directory (`<GameDir>/fonts`, including
 * ARIAL.TTF and zeroes_3.ttf); `lua/skins/skins.lua:24-26` names them ("Arial",
 * "Zeroes Three"). This reads the game file rather than estimating it.
 *
 * Only the tables needed for width and height are read:
 *   head  → unitsPerEm (the scale of all values)
 *   hhea  → ascender/descender/lineGap, numberOfHMetrics
 *   hmtx  → advanceWidth per glyph
 *   cmap  → character → glyph index (formats 4 and 12; everything the UI uses)
 *   name  → family name (so the file identifies itself)
 * Kerning is omitted: the engine renders the UI font without kerning pairs
 * (no `kern` access in the text path), and Arial/Zeroes would not have any here.
 */
export interface FontMetrics {
  family: string
  unitsPerEm: number
  ascent: number
  descent: number
  lineGap: number
  /** Width of a string in pixels at the given point size. */
  advance(text: string, size: number): number
}

export function parseTtf(bytes: Uint8Array): FontMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u8 = (o: number): number => view.getUint8(o)
  const u16 = (o: number): number => view.getUint16(o)
  const i16 = (o: number): number => view.getInt16(o)
  const u32 = (o: number): number => view.getUint32(o)

  // sfnt header: 'true'/0x00010000 (TTF) or 'OTTO' (CFF — then glyf is absent,
  // but hmtx/cmap are the same, and we need nothing else).
  const numTables = u16(4)
  const tables = new Map<string, number>()
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = String.fromCharCode(u8(rec), u8(rec + 1), u8(rec + 2), u8(rec + 3))
    tables.set(tag, u32(rec + 8))
  }
  const need = (tag: string): number => {
    const off = tables.get(tag)
    if (off === undefined) throw new Error(`TTF: table '${tag}' is missing`)
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
    // hmtx: numberOfHMetrics pairs (advance, lsb); only lsb follows —
    // all following glyphs inherit the final width (OpenType specification).
    const i = Math.min(glyph, numberOfHMetrics - 1)
    return u16(hmtx + i * 4)
  }

  const cmap = need('cmap')
  const lookup = buildCmap(view, cmap)

  // The FULL name (nameID 4): "Arial", "Arial Bold", "Zeroes Three". This is
  // exactly how the UI addresses its fonts — `UIUtil.bodyFont` is "Arial", but
  // `unitviewDetail.lua` requires "Arial Bold". ARIAL.TTF and ARIALBD.TTF both
  // have the FAMILY "Arial" (nameID 1); keying by it overwrites the base-font
  // metrics with the bold font and measures all subsequent text incorrectly.
  const nameTable = tables.get('name')
  const family = readName(view, nameTable, 4) || readName(view, nameTable, 1)

  return {
    family,
    unitsPerEm,
    ascent,
    descent,
    lineGap,
    advance(text: string, size: number): number {
      // The engine (CD3DFont::GetAdvance, Cfile:460774) sums a per-glyph
      // INTEGER pixel advance and has NO kerning: each glyph's mAdvance is
      // rc.right-rc.left from DrawTextW(DT_CALCRECT|DT_SINGLELINE|DT_NOPREFIX),
      // measured one character at a time (GetCharInfo, Cfile:460471/460509) —
      // a GDI text extent cast from a LONG, so an integer. Round EACH glyph to
      // an integer pixel at the point size before summing, not once at the end.
      // (Round-to-nearest approximates GDI's scaled advance; exact GDI hinting /
      // grid-fitting is a Windows internal we cannot reproduce, so this can
      // differ by ~1px on hinted glyphs — documented, not invented.)
      let px = 0
      for (const ch of text) px += Math.round((advanceOf(lookup(ch.codePointAt(0)!)) * size) / unitsPerEm)
      return px
    },
  }
}

/** cmap → codepoint-to-glyph-index function. Prefer (3,10), then (3,1), then (0,*). */
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
  if (best < 0) throw new Error('TTF: no cmap subtable')

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
  throw new Error(`TTF: cmap format ${format} was not read`)
}

/**
 * An entry in the name table (nameID 1 = family, 2 = style, 4 = full name).
 *
 * Two reliable pitfalls:
 *   - Encoding depends on the platform: Windows (3) and Unicode (0) store
 *     UTF-16BE, while Macintosh (1) stores a byte string. Reading everything
 *     except 3 as bytes produces " A r i a l " from a Unicode entry.
 *   - The same nameID appears multiple times, once per LANGUAGE. ARIALBD.TTF
 *     lists the style as "negreta" (Catalan), among others. Therefore English
 *     (langID 0x0409) is required; otherwise an arbitrary translation is used.
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
    // Windows/en-US outranks other Windows, which outranks Unicode, which outranks Mac.
    const english = language === 0x0409 || (platform !== 3 && language === 0)
    const score = (platform === 3 ? 4 : platform === 0 ? 2 : 0) + (english ? 1 : 0)
    if (s && score > bestScore) {
      best = s
      bestScore = score
    }
  }
  return best
}
