/**
 * Engine file pattern (`DiskFindFiles(dir, pattern)`).
 *
 * The original Lua calls this with patterns such as `*strings_db.lua`
 * (Localization.lua:29) or `*.bp`. Only `*` is a wildcard.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** All paths below `dir` whose filenames match `pattern` (including the leading `/`). */
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
