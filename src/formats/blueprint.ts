/**
 * Parser für Blueprint-Dateien (.bp) — deklaratives Lua wie
 * `UnitBlueprint { ... }` mit verschachtelten Konstruktoren (`Sound { ... }`),
 * Strings, Zahlen, Booleans und einfachen arithmetischen Ausdrücken.
 * Kein vollständiges Lua: genau der Subset, den die FA-Blueprints nutzen.
 */

export type BpValue = string | number | boolean | null | BpValue[] | BpObject
export interface BpObject {
  [key: string]: BpValue
}

export class BlueprintParseError extends Error {
  constructor(message: string, src: string, pos: number) {
    const line = src.slice(0, pos).split('\n').length
    super(`Blueprint Zeile ${line}: ${message}`)
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
        // FA blueprints sometimes use '#' as a line comment
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
    if (this.peek() !== ch) this.error(`"${ch}" expected, found "${this.peek() || 'EOF'}"`)
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
    if (!m) this.error('Bezeichner erwartet')
    this.pos += m[0].length
    return m[0]
  }

  private readString(): string {
    this.skipWs()
    const quote = this.src[this.pos]
    if (quote !== "'" && quote !== '"') this.error('String erwartet')
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
    this.error('String not closed')
  }

  // --- Expressions (numbers with + - * / and parentheses) --------------------------

  private readNumberLiteral(): number {
    this.skipWs()
    const rest = this.src.slice(this.pos)
    const hex = /^0[xX][0-9a-fA-F]+/.exec(rest)
    if (hex) {
      this.pos += hex[0].length
      return parseInt(hex[0], 16)
    }
    const m = /^\d+\.?\d*(?:[eE][+-]?\d+)?|^\.\d+(?:[eE][+-]?\d+)?/.exec(rest)
    if (!m) this.error('Zahl erwartet')
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

  // --- Values ​​& Tables -------------------------------------------------------

  parseValue(): BpValue {
    const c = this.peek()
    if (c === "'" || c === '"') return this.readString()
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
        // Constructor like Sound { ... } → table with __type
        const table = this.parseTable()
        if (Array.isArray(table)) return { __type: ident, values: table }
        return { __type: ident, ...(table as BpObject) }
      }
      if (this.peek() === '(') {
        // Function call like STRING('x') or Vector(x, y, z):
        // one argument → the value itself, several → array
        this.pos++
        const args: BpValue[] = []
        while (this.peek() !== ')') {
          if (this.peek() === '') this.error('")" erwartet')
          args.push(this.parseValue())
          if (this.peek() === ',') this.pos++
        }
        this.pos++
        return args.length === 1 ? args[0]! : args
      }
      // naked identifier (rare) → treat as string
      return ident
    }
    this.error(`Unerwartetes Zeichen "${c}"`)
  }

  parseTable(): BpValue[] | BpObject {
    this.expect('{')
    const array: BpValue[] = []
    const object: BpObject = {}
    let hasNamed = false

    for (;;) {
      const c = this.peek()
      if (c === '') this.error('"}" erwartet')
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

  /** Top level: Sequence of `name = value` assignments (e.g. _scenario.lua). */
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

/** Parses a .bp file; provides all top level blueprints. */
export function parseBlueprints(source: string): BpObject[] {
  return new Parser(source).parseFile()
}

/** Parses Lua files from top level allocations (e.g. `version = 3` + `ScenarioInfo = {...}`). */
export function parseLuaAssignments(source: string): BpObject {
  return new Parser(source).parseAssignments()
}

/** Convenient access: first blueprint of the file. */
export function parseBlueprint(source: string): BpObject {
  const all = parseBlueprints(source)
  const first = all[0]
  if (!first) throw new Error('Blueprint: File contains no declaration')
  return first
}

/** Path access like bpGet(bp, 'Defense.Health') with type checking per caller. */
export function bpGet(bp: BpValue | undefined, path: string): BpValue | undefined {
  let cur: BpValue | undefined = bp
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as BpObject)[seg]
  }
  return cur
}

/** Removes localization tags such as "<LOC uel0001_name>Armored Command Unit". */
export function stripLoc(value: BpValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/^<[^>]*>/, '')
}
