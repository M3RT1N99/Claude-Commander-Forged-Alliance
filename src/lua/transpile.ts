/**
 * Übersetzt den FA-Lua-Dialekt (Lua 5.0 mit GPG-Erweiterungen) in Standard-
 * Lua, das ein moderner VM (5.1/5.4) laden kann.
 *
 * Vermessen über alle 369 Dateien in lua.scd:
 *   - `#` ist IMMER Zeilenkommentar (234 Dateien) — FA-Lua kennt keinen
 *     `#`-Längenoperator, alle 1149 Fundstellen sind auskommentierter Code
 *   - `!=` statt `~=` (118 Dateien)
 *   - `for k,v in TBL do` — Lua-5.0-Implizit-Iteration (154 Dateien)
 *   - `table.getn/setn/foreach`, `arg`, `math.mod` → Laufzeit-Shims
 *     (siehe compat.lua), keine Syntax-Übersetzung nötig
 *
 * Der Transpiler arbeitet zeichenweise (Lexer-Prinzip), damit Strings,
 * Long-Strings (`[[...]]`) und Kommentare unangetastet bleiben — eine
 * Regex-Lösung würde `#` und `!=` in Strings zerstören.
 */

type Mode = 'code' | 'shortString' | 'longString' | 'lineComment' | 'longComment'

export interface TranspileResult {
  code: string
  stats: {
    hashComments: number
    notEquals: number
    forInTable: number
    continues: number
    varargArg: number
  }
}

/** Gültige Escape-Sequenzen in Standard-Lua. */
const VALID_ESCAPES = new Set(['a', 'b', 'f', 'n', 'r', 't', 'v', '\\', '"', "'", '\n', 'x', 'z'])

export function transpileFaLua(source: string): TranspileResult {
  const stats = { hashComments: 0, notEquals: 0, forInTable: 0, continues: 0, varargArg: 0 }
  let out = ''
  let mode: Mode = 'code'
  let quote = ''
  let longLevel = 0
  let i = 0

  // UTF-8-BOM entfernen (3 Dateien in lua.scd)
  if (source.charCodeAt(0) === 0xfeff) i = 1
  else if (source.startsWith('ï»¿')) i = 3

  /** Öffnendes Long-Bracket `[==[` ab Position p; -1 = keines. */
  const longOpen = (p: number): number => {
    if (source[p] !== '[') return -1
    let eq = 0
    let q = p + 1
    while (source[q] === '=') {
      eq++
      q++
    }
    return source[q] === '[' ? eq : -1
  }

  while (i < source.length) {
    const c = source[i]!

    if (mode === 'code') {
      // --- Kommentare ---
      if (c === '-' && source[i + 1] === '-') {
        const lvl = longOpen(i + 2)
        if (lvl >= 0) {
          mode = 'longComment'
          longLevel = lvl
          out += source.slice(i, i + 4 + lvl)
          i += 4 + lvl
        } else {
          mode = 'lineComment'
          out += '--'
          i += 2
        }
        continue
      }
      // FA: `#` beginnt einen Zeilenkommentar
      if (c === '#') {
        stats.hashComments++
        mode = 'lineComment'
        out += '--'
        i++
        continue
      }
      // --- Strings ---
      if (c === '"' || c === "'") {
        mode = 'shortString'
        quote = c
        out += c
        i++
        continue
      }
      const lvl = longOpen(i)
      if (lvl >= 0) {
        mode = 'longString'
        longLevel = lvl
        out += source.slice(i, i + 2 + lvl)
        i += 2 + lvl
        continue
      }
      // --- Operatoren ---
      if (c === '!' && source[i + 1] === '=') {
        stats.notEquals++
        out += '~='
        i += 2
        continue
      }
      // LuaPlus-Größenhinweis im Tabellen-Konstruktor: `{&1&4}` → `{}`
      if (c === '{') {
        const hint = /^\{\s*&\d+&\d+/.exec(source.slice(i, i + 24))
        if (hint) {
          out += '{'
          i += hint[0].length
          continue
        }
      }
      out += c
      i++
      continue
    }

    if (mode === 'lineComment') {
      out += c
      if (c === '\n') mode = 'code'
      i++
      continue
    }

    if (mode === 'shortString') {
      if (c === '\\') {
        const next = source[i + 1] ?? ''
        // Lua 5.0 ließ unbekannte Escapes durch ("\m"), 5.1+ nicht
        if (!VALID_ESCAPES.has(next) && !/\d/.test(next)) {
          out += `\\\\${next}`
        } else {
          out += source.slice(i, i + 2)
        }
        i += 2
        continue
      }
      out += c
      if (c === quote || c === '\n') mode = 'code'
      i++
      continue
    }

    // longString / longComment
    if (c === ']') {
      let eq = 0
      let q = i + 1
      while (source[q] === '=') {
        eq++
        q++
      }
      if (eq === longLevel && source[q] === ']') {
        out += source.slice(i, q + 1)
        i = q + 1
        mode = 'code'
        continue
      }
    }
    out += c
    i++
  }

  return {
    code: rewriteContinue(rewriteVarargArg(rewriteForIn(out, stats), stats), stats),
    stats,
  }
}

/**
 * Lua 5.0 stellte in Vararg-Funktionen implizit eine Tabelle `arg`
 * (`{n = Anzahl, [1..n] = Werte}`) bereit; ab 5.1 gibt es nur noch `...`.
 * FA-Skripte nutzen `arg` (z. B. `class.lua` `ClassMeta:__call`). Wir
 * injizieren `local arg = table.pack(...)` direkt nach der Parameterliste
 * jeder Vararg-Funktion — verhaltensäquivalent (`table.pack` setzt `.n`).
 *
 * Nur Funktionen mit `...` in der Signatur werden angefasst; Strings und
 * Kommentare bleiben unberührt (Lexer-Skip).
 */
function rewriteVarargArg(code: string, stats: { varargArg: number }): string {
  const edits: { pos: number; text: string }[] = []
  let i = 0
  const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c)

  while (i < code.length) {
    const c = code[i]!
    if (c === '-' && code[i + 1] === '-') {
      const nl = code.indexOf('\n', i)
      i = nl < 0 ? code.length : nl
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (!isWord(c)) {
      i++
      continue
    }
    const start = i
    while (i < code.length && isWord(code[i]!)) i++
    if (code.slice(start, i) !== 'function') continue

    // Parameterliste finden: bis zur öffnenden Klammer (Name überspringen)
    let p = i
    while (p < code.length && code[p] !== '(' && code[p] !== '\n') p++
    if (code[p] !== '(') continue
    const open = p
    let close = code.indexOf(')', open)
    if (close < 0) continue
    const params = code.slice(open + 1, close)
    if (/(^|[,\s])\.\.\.\s*$/.test(params)) {
      edits.push({ pos: close + 1, text: ' local arg = table.pack(...);' })
      stats.varargArg++
    }
    i = close + 1
  }

  if (edits.length === 0) return code
  edits.sort((a, b) => b.pos - a.pos)
  let out = code
  for (const e of edits) out = out.slice(0, e.pos) + e.text + out.slice(e.pos)
  return out
}

/**
 * FA-Lua kennt ein `continue`-Statement (GPG-Erweiterung). Standard-Lua
 * nicht — aber ab 5.2 gibt es `goto`. Wir ersetzen jedes `continue` durch
 * `goto __cont_N` und hängen `::__cont_N::` ans Ende der zugehörigen
 * Schleife (Lua erlaubt ein Label als letztes Statement eines Blocks —
 * genau für dieses Idiom).
 *
 * Block-Verfolgung per Schlüsselwort-Stack; Strings/Kommentare sind zu
 * diesem Zeitpunkt bereits normalisiert, werden aber weiterhin übersprungen.
 */
function rewriteContinue(code: string, stats: { continues: number }): string {
  interface Frame {
    kind: 'loop' | 'block' | 'function'
    /** 'end' oder 'until' beendet den Rahmen */
    closer: 'end' | 'until'
    id: number
    hasContinue: boolean
    /** Position direkt nach dem öffnenden `do` (für die Rumpf-Kapselung) */
    bodyStart: number
  }

  const edits: { start: number; end: number; text: string }[] = []
  const stack: Frame[] = []
  let pendingLoop = false
  let nextId = 1
  let i = 0

  const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c)

  while (i < code.length) {
    const c = code[i]!

    // Kommentare überspringen
    if (c === '-' && code[i + 1] === '-') {
      const nl = code.indexOf('\n', i)
      i = nl < 0 ? code.length : nl
      continue
    }
    // Strings überspringen
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (c === '[' && (code[i + 1] === '[' || code[i + 1] === '=')) {
      let eq = 0
      let q = i + 1
      while (code[q] === '=') {
        eq++
        q++
      }
      if (code[q] === '[') {
        const close = `]${'='.repeat(eq)}]`
        const end = code.indexOf(close, q + 1)
        i = end < 0 ? code.length : end + close.length
        continue
      }
    }
    if (!isWord(c)) {
      i++
      continue
    }

    // Wort lesen
    const start = i
    while (i < code.length && isWord(code[i]!)) i++
    const word = code.slice(start, i)

    switch (word) {
      case 'for':
      case 'while':
        pendingLoop = true
        break
      case 'do':
        stack.push({
          kind: pendingLoop ? 'loop' : 'block',
          closer: 'end',
          id: nextId++,
          hasContinue: false,
          bodyStart: i,
        })
        pendingLoop = false
        break
      case 'repeat':
        stack.push({
          kind: 'loop',
          closer: 'until',
          id: nextId++,
          hasContinue: false,
          bodyStart: i,
        })
        break
      case 'function':
        stack.push({
          kind: 'function',
          closer: 'end',
          id: nextId++,
          hasContinue: false,
          bodyStart: i,
        })
        break
      case 'then':
        stack.push({
          kind: 'block',
          closer: 'end',
          id: nextId++,
          hasContinue: false,
          bodyStart: i,
        })
        break
      case 'elseif': {
        // Das 'then' des vorherigen Zweigs schließt hier; das folgende
        // 'then' öffnet neu — Netto-Bilanz bleibt korrekt.
        const top = stack[stack.length - 1]
        if (top?.kind === 'block' && top.closer === 'end') stack.pop()
        break
      }
      case 'end':
      case 'until': {
        const frame = stack.pop()
        if (frame?.hasContinue) {
          if (frame.closer === 'end') {
            // Rumpf kapseln: `for … do do <Rumpf> end ::__cont_N:: end`.
            // Nötig, weil ein `return` als letztes Statement kein Label
            // hinter sich duldet — im inneren do-Block ist es zulässig,
            // und das Label bleibt vom `goto` aus sichtbar.
            edits.push({ start: frame.bodyStart, end: frame.bodyStart, text: ' do' })
            edits.push({ start, end: start, text: `end ::__cont_${frame.id}:: ` })
          } else {
            // repeat…until: kein do-Block (die until-Bedingung sieht sonst
            // die Rumpf-Locals nicht mehr)
            edits.push({ start, end: start, text: `::__cont_${frame.id}:: ` })
          }
        }
        break
      }
      case 'continue': {
        // nächstliegende Schleife suchen (nicht über Funktionsgrenzen)
        for (let s = stack.length - 1; s >= 0; s--) {
          const frame = stack[s]!
          if (frame.kind === 'function') break
          if (frame.kind === 'loop') {
            frame.hasContinue = true
            edits.push({ start, end: i, text: `goto __cont_${frame.id}` })
            stats.continues++
            break
          }
        }
        break
      }
      default:
        break
    }
  }

  if (edits.length === 0) return code
  edits.sort((a, b) => b.start - a.start) // von hinten anwenden
  let out = code
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  return out
}

/**
 * Lua 5.0 erlaubte `for k,v in tbl do` (implizite Tabellen-Iteration).
 * Ab 5.1 muss dort ein Iterator stehen → `pairs(tbl)`. Nur umschreiben,
 * wenn der Ausdruck weder Funktionsaufruf noch bekannter Iterator ist.
 */
function rewriteForIn(code: string, stats: { forInTable: number }): string {
  return code.replace(
    /\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s+([^\n]+?)\s+do\b/g,
    (match, vars: string, expr: string) => {
      const e = expr.trim()
      // Funktionsaufruf (pairs(...), ipairs(...), next, eigene Iteratoren)
      if (/[)\]]\s*$/.test(e) || /\bnext\b/.test(e) || e.includes(',')) return match
      // reiner Bezeichner/Feldzugriff → Tabelle
      if (/^[A-Za-z_][\w.:]*$/.test(e) || /^self\.[\w.]+$/.test(e)) {
        stats.forInTable++
        return `for ${vars} in pairs(${e}) do`
      }
      return match
    },
  )
}

/**
 * Kompat-Schicht für Lua-5.0-Bibliotheksfunktionen, die FA nutzt.
 * Wird vor allen Spiel-Skripten in den VM geladen.
 */
export const COMPAT_LUA = `
-- Lua-5.0-Kompatibilität für FA-Skripte
table.getn = table.getn or function(t) return #t end
table.setn = table.setn or function() end
table.foreach = table.foreach or function(t, f)
  for k, v in pairs(t) do local r = f(k, v); if r ~= nil then return r end end
end
table.foreachi = table.foreachi or function(t, f)
  for i, v in ipairs(t) do local r = f(i, v); if r ~= nil then return r end end
end
math.mod = math.mod or function(a, b) return a % b end
unpack = unpack or table.unpack
loadstring = loadstring or load
if not setfenv then
  -- 5.4: über Upvalue _ENV (ausreichend für FAs Nutzung)
  function setfenv(fn, env)
    if type(fn) == 'number' then return end
    local i = 1
    while true do
      local name = debug.getupvalue(fn, i)
      if not name then break end
      if name == '_ENV' then debug.upvaluejoin(fn, i, function() return env end, 1); break end
      i = i + 1
    end
    return fn
  end
  function getfenv(fn)
    if type(fn) ~= 'function' then return _G end
    local i = 1
    while true do
      local name, val = debug.getupvalue(fn, i)
      if not name then return _G end
      if name == '_ENV' then return val end
      i = i + 1
    end
  end
end
`
