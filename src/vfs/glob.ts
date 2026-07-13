/**
 * Datei-Muster der Engine (`DiskFindFiles(dir, pattern)`).
 *
 * Die Original-Lua ruft das mit Mustern wie `*strings_db.lua`
 * (Localization.lua:29) oder `*.bp`. Nur `*` ist ein Platzhalter.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** Alle Pfade unter `dir`, deren Dateiname auf `pattern` passt (führendes `/` inklusive). */
export function findFiles(paths: Iterable<string>, dir: string, pattern: string): string[] {
  const rx = globToRegExp(pattern || '*')
  const prefix = dir.replace(/^\/+/, '').toLowerCase()
  const out: string[] = []
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue
    const name = p.split('/').pop() ?? ''
    if (rx.test(name)) out.push(`/${p}`)
  }
  return out.sort()
}
