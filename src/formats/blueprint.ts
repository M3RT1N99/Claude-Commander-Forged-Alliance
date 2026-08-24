/**
 * Parser for Blueprint files (.bp) — declarative Lua such as
 * `UnitBlueprint { ... }` with nested constructors (`Sound { ... }`),
 * strings, numbers, booleans, and simple arithmetic expressions.
 * Not full Lua: exactly the subset used by FA blueprints.
 */

export type BpValue = string | number | boolean | null | BpValue[] | BpObject
export interface BpObject {
  [key: string]: BpValue
}

export class BlueprintParseError extends Error {
  constructor(message: string, src: string, pos: number) {
    const line = src.slice(0, pos).split('\n').length
    super(`Blueprint line ${line}: ${message}`)
  }
}

class Parser {
  private pos = 0

  constructor(private readonly src: string) {}

  // --- Low-level -----------------------------------------------------------

  private error(msg: string): never {
    throw new BlueprintParseError(msg, this.src, this.pos)
  }

  private skipWs(): void {
    const s = this.src
    while (this.pos < s.length) {
      const c = s[this.pos]!
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.pos++
      } else if (c === '-' && s[this.pos + 1] === '-') {
        if (s.startsWith('--[[', this.pos)) {
          const end = s.indexOf(']]', this.pos + 4)
          this.pos = end < 0 ? s.length : end + 2
        } else {
          const end = s.indexOf('\n', this.pos)
          this.pos = end < 0 ? s.length : end + 1
        }
      } else if (c === '#') {
        // Some FA blueprints use '#' as a line comment.
        const end = s.indexOf('\n', this.pos)
        this.pos = end < 0 ? s.length : end + 1
      } else {
        break
      }
    }
  }

  private peek(): string {
    this.skipWs()
    return this.src[this.pos] ?? ''
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.error(`expected "${ch}", found "${this.peek() || 'EOF'}"`)
    this.pos++
  }

  private tryConsume(ch: string): boolean {
    if (this.peek() === ch) {
      this.pos++
      return true
    }
    return false
  }

  atEnd(): boolean {
    this.skipWs()
    return this.pos >= this.src.length
  }

  // --- Tokens ----------------------------------------------------------------

  private readIdent(): string {
    this.skipWs()
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos))
    if (!m) this.error('expected identifier')
    this.pos += m[0].length
    return m[0]
  }

  private readString(): string {
    this.skipWs()
    const quote = this.src[this.pos]
    if (quote !== "'" && quote !== '"') this.error('expected string')
    this.pos++
    let out = ''
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!
      if (c === '\\') {
        const n = this.src[this.pos + 1]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '')
        this.pos += 2
      } else if (c === quote) {
        this.pos++
        return out
      } else {
        out += c
        this.pos++
      }
    }
    this.error('unterminated string')
  }

  /** The level of a Lua long bracket `[==[` at the cursor (0 for `[[`), or -1
   *  if there is no long bracket. */
  private longBracketLevel(): number {
    if (this.src[this.pos] !== '[') return -1
    let eq = 0
    let q = this.pos + 1
    while (this.src[q] === '=') {
      eq++
      q++
    }
    return this.src[q] === '[' ? eq : -1
  }

  /**
   * A Lua long string `[[...]]` / `[==[...]==]` read VERBATIM (no escapes). The
   * real effect/emitter blueprints use it for texture paths, e.g.
   * `Texture = [[/textures/particles/glow_03.dds]]` (a3_end_nis_01_emit.bp:26) —
   * without this the whole blueprint failed to parse. Lua drops a single leading
   * newline right after the opening bracket.
   */
  private readLongString(): string {
    const level = this.longBracketLevel()
    this.pos += 2 + level // skip [==[
    if (this.src[this.pos] === '\r') this.pos++
    if (this.src[this.pos] === '\n') this.pos++
    const close = `]${'='.repeat(level)}]`
    const end = this.src.indexOf(close, this.pos)
    if (end < 0) this.error('unterminated long string')
    const s = this.src.slice(this.pos, end)
    this.pos = end + close.length
    return s
  }

  // --- Expressions (numbers with + - * / and parentheses) -------------------

  private readNumberLiteral(): number {
    this.skipWs()
    const rest = this.src.slice(this.pos)
    const hex = /^0[xX][0-9a-fA-F]+/.exec(rest)
    if (hex) {
      this.pos += hex[0].length
      return parseInt(hex[0], 16)
    }
    const m = /^\d+\.?\d*(?:[eE][+-]?\d+)?|^\.\d+(?:[eE][+-]?\d+)?/.exec(rest)
    if (!m) this.error('expected number')
    this.pos += m[0].length
    return parseFloat(m[0])
  }

  private parseFactor(): number {
    const c = this.peek()
    if (c === '-') {
      this.pos++
      return -this.parseFactor()
    }
    if (c === '(') {
      this.pos++
      const v = this.parseExpression()
      this.expect(')')
      return v
    }
    return this.readNumberLiteral()
  }

  private parseTerm(): number {
    let v = this.parseFactor()
    for (;;) {
      const c = this.peek()
      if (c === '*') {
        this.pos++
        v *= this.parseFactor()
      } else if (c === '/') {
        this.pos++
        v /= this.parseFactor()
      } else {
        return v
      }
    }
  }

  private parseExpression(): number {
    let v = this.parseTerm()
    for (;;) {
      const c = this.peek()
      if (c === '+') {
        this.pos++
        v += this.parseTerm()
      } else if (c === '-') {
        this.pos++
        v -= this.parseTerm()
      } else {
        return v
      }
    }
  }

  // --- Values & tables -------------------------------------------------------

  parseValue(): BpValue {
    const c = this.peek()
    if (c === "'" || c === '"') return this.readString()
    if (c === '[' && this.longBracketLevel() >= 0) return this.readLongString()
    if (c === '{') return this.parseTable()
    if (c === '-' || c === '(' || c === '.' || (c >= '0' && c <= '9')) {
      return this.parseExpression()
    }
    if (/[A-Za-z_]/.test(c)) {
      const ident = this.readIdent()
      if (ident === 'true') return true
      if (ident === 'false') return false
      if (ident === 'nil') return null
      if (this.peek() === '{') {
        // Constructor such as Sound { ... } → table with __type.
        const table = this.parseTable()
        if (Array.isArray(table)) return { __type: ident, values: table }
        return { __type: ident, ...(table as BpObject) }
      }
      if (this.peek() === '(') {
        // Function call such as STRING('x') or Vector(x, y, z):
        // one argument → the value itself, multiple arguments → array.
        this.pos++
        const args: BpValue[] = []
        while (this.peek() !== ')') {
          if (this.peek() === '') this.error('expected ")"')
          args.push(this.parseValue())
          if (this.peek() === ',') this.pos++
        }
        this.pos++
        return args.length === 1 ? args[0]! : args
      }
      // Bare identifier (rare) → treat as a string.
      return ident
    }
    this.error(`unexpected character "${c}"`)
  }

  parseTable(): BpValue[] | BpObject {
    this.expect('{')
    const array: BpValue[] = []
    const object: BpObject = {}
    let hasNamed = false

    for (;;) {
      const c = this.peek()
      if (c === '') this.error('expected "}"')
      if (c === '}') {
        this.pos++
        break
      }

      if (c === '[') {
        this.pos++
        const key = this.parseValue()
        this.expect(']')
        this.expect('=')
        object[String(key)] = this.parseValue()
        hasNamed = true
      } else if (/[A-Za-z_]/.test(c)) {
        const save = this.pos
        const ident = this.readIdent()
        if (this.peek() === '=' && this.src[this.pos + 1] !== '=') {
          this.pos++
          object[ident] = this.parseValue()
          hasNamed = true
        } else {
          this.pos = save
          array.push(this.parseValue())
        }
      } else {
        array.push(this.parseValue())
      }

      const sep = this.peek()
      if (sep === ',' || sep === ';') this.pos++
    }

    if (!hasNamed) return array
    if (array.length > 0) {
      array.forEach((v, i) => {
        object[String(i + 1)] = v
      })
    }
    return object
  }

  /** Top level: sequence of `Ident { ... }` declarations. */
  parseFile(): BpObject[] {
    const out: BpObject[] = []
    while (!this.atEnd()) {
      const ident = this.readIdent()
      const table = this.parseTable()
      if (Array.isArray(table)) {
        out.push({ __type: ident, values: table })
      } else {
        out.push({ __type: ident, ...(table as BpObject) })
      }
    }
    return out
  }

  /** Top level: sequence of `name = value` assignments (e.g. _scenario.lua). */
  parseAssignments(): BpObject {
    const out: BpObject = {}
    while (!this.atEnd()) {
      const ident = this.readIdent()
      this.expect('=')
      out[ident] = this.parseValue()
    }
    return out
  }
}

/** Parses a .bp file and returns all top-level blueprints. */
export function parseBlueprints(source: string): BpObject[] {
  return new Parser(source).parseFile()
}

/** Parses Lua files containing top-level assignments (e.g. `version = 3` + `ScenarioInfo = {...}`). */
export function parseLuaAssignments(source: string): BpObject {
  return new Parser(source).parseAssignments()
}

/** Convenient access: the first blueprint in the file. */
export function parseBlueprint(source: string): BpObject {
  const all = parseBlueprints(source)
  const first = all[0]
  if (!first) throw new Error('Blueprint: file contains no declaration')
  return first
}

/** Path access such as bpGet(bp, 'Defense.Health'), with type checking by the caller. */
export function bpGet(bp: BpValue | undefined, path: string): BpValue | undefined {
  let cur: BpValue | undefined = bp
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) {
      // A positional table is a JS array; Lua indexes it 1-based, so
      // Display.Mesh.LODs.1 -> cur[0] (matches how the game indexes it).
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg) - 1]
    } else if (cur === null || typeof cur !== 'object') {
      return undefined
    } else {
      cur = (cur as BpObject)[seg]
    }
  }
  return cur
}

/** Removes localization tags such as "<LOC uel0001_name>Armored Command Unit". */
export function stripLoc(value: BpValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/^<[^>]*>/, '')
}
