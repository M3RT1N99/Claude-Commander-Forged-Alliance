import { parseTtf, type FontMetrics } from '../formats/ttf'

/**
 * Die Schriften des Spiels — dieselben Dateien, die die Engine benutzt.
 *
 * `lua/skins/skins.lua:22-26` nennt genau zwei Familien: "Arial" (bodyFont,
 * fixedFont) und "Zeroes Three" (buttonFont, titleFont, factionFont). Beide
 * liegen als TTF unter `<GameDir>/fonts` — die Engine lädt sie von dort, also
 * tun wir es auch. Geschätzt wird nichts: Text-Controls bemessen sich nach
 * FontAscent/FontDescent und TextAdvance (text.lua:39/47), und wer die Zahlen
 * rät, verschiebt die halbe UI.
 *
 * Kennt das Buch eine Familie nicht, KNALLT es. Ein stiller Rückfall auf
 * irgendeine Systemschrift wäre genau die Sorte Lüge, die niemand bemerkt.
 */
export class FontBook {
  private readonly byFamily = new Map<string, FontMetrics>()

  /** Record a TTF file. The family name comes from the file itself. */
  add(bytes: Uint8Array): string {
    const m = parseTtf(bytes)
    this.byFamily.set(m.family.toLowerCase(), m)
    return m.family
  }

  get size(): number {
    return this.byFamily.size
  }

  has(family: string): boolean {
    return this.byFamily.has(family.toLowerCase())
  }

  private font(family: string): FontMetrics {
    const m = this.byFamily.get(String(family).toLowerCase())
    if (!m) {
      throw new Error(
        `Font '${family}' not loaded (known: ${[...this.byFamily.keys()].join(', ')})`,
      )
    }
    return m
  }

  /** [ascender, descender] in pixels — text.lua:39 turns this into the height. */
  metrics(family: string, size: number): [number, number] {
    const f = this.font(family)
    const scale = size / f.unitsPerEm
    return [f.ascent * scale, Math.abs(f.descent) * scale]
  }

  /** Width of a string in pixels (CMauiText::GetStringAdvance, Cfile:1146720). */
  advance(text: string, family: string, size: number): number {
    return this.font(family).advance(text, size)
  }
}

/** The game's font files: `<GameDir>/fonts/*.ttf` (loose directory, not an archive). */
export const FONT_FILES = [
  'ARIAL.TTF',
  'ARIALBD.TTF',
  'zeroes_3.ttf',
  'BUTTERBE.TTF',
  'vdub.ttf',
  'wintermu.ttf',
]
