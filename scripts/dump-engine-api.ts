/**
 * Erzeugt docs/research/engine-api.md aus der IDA-Decompilation.
 *
 * Jede Lua-Bindung der Engine ist ein globales `Moho::CScrLuaInitForm luadef_*`
 * mit `mMethodName`, `mClassName` und `mPrevDef`. Das `mPrevDef` verrät, in
 * WELCHE Lua-VM die Bindung geht:
 *
 *   scr_CoreInits  — beide VMs (Sim und UI)
 *   scr_UserInits  — NUR die UI-VM
 *   sim_SimInits   — NUR die Sim-VM
 *
 * Genau diese Dreiteilung ist der Grund, warum die UI eine eigene Lua-VM
 * braucht: `_c_CreateCursor` gibt es in der Sim nicht, `CreateUnit` nicht in
 * der UI. Wer beides in eine VM wirft, baut etwas, das es nie gab.
 *
 *   npx tsx scripts/dump-engine-api.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const CFILE = 'Cfile/ForgedAlliance.exe.c'
const OUT = 'docs/research/engine-api.md'

const src = await readFile(CFILE, 'utf8')

const re =
  /luadef_(\w+)\.mPrevDef = Moho::(scr_\w+|sim_\w+)\.mForms;[\s\S]*?luadef_\1\.mMethodName = "([^"]+)";\s*luadef_\1\.mClassName = "([^"]+)";/g

type Bucket = Map<string, Set<string>> // className -> methods
const inits = new Map<string, Bucket>()

let m: RegExpExecArray | null
while ((m = re.exec(src)) !== null) {
  const [, , init, method, cls] = m
  const bucket = inits.get(init!) ?? new Map<string, Set<string>>()
  inits.set(init!, bucket)
  const set = bucket.get(cls!) ?? new Set<string>()
  bucket.set(cls!, set)
  set.add(method!)
}

const sortedList = (s: Set<string> | undefined): string[] => [...(s ?? [])].sort()

const section = (init: string, title: string, note: string): string => {
  const bucket = inits.get(init)
  if (!bucket) return ''
  const globals = sortedList(bucket.get('<global>'))
  const classes = [...bucket.keys()].filter((c) => c !== '<global>').sort()
  const total = [...bucket.values()].reduce((n, s) => n + s.size, 0)

  let out = `## ${title}\n\n${note}\n\n`
  out += `**${total} bindings** — ${globals.length} globals, ${classes.length} classes.\n\n`
  out += `### Globals (${globals.length})\n\n`
  out += globals.map((g) => `\`${g}\``).join(', ') + '\n\n'
  if (classes.length > 0) {
    out += `### Classes (${classes.length})\n\n`
    for (const c of classes) {
      const methods = sortedList(bucket.get(c))
      out += `**${c}** (${methods.length}): ${methods.map((x) => `\`${x}\``).join(', ')}\n\n`
    }
  }
  return out
}

const body = `# Engine-Lua-API — welche Bindung in welche VM geht

**Generiert von [scripts/dump-engine-api.ts](../../scripts/dump-engine-api.ts) aus der
IDA-Decompilation. Nicht von Hand pflegen.**

Jede Lua-Bindung der Engine ist ein \`Moho::CScrLuaInitForm luadef_*\`. Das Feld
\`mPrevDef\` verrät, in welche Lua-VM sie registriert wird — und damit, dass die
Engine **zwei getrennte Lua-States** hat:

| Init-Liste | Ziel-VM |
|---|---|
| \`scr_CoreInits\` | beide (Sim **und** UI) |
| \`scr_UserInits\` | nur die **UI**-VM |
| \`sim_SimInits\` | nur die **Sim**-VM |

Darum kennt die Sim kein \`_c_CreateCursor\` und die UI kein \`CreateUnit\`. Who
Throwing both into a VM builds something that never existed in the original.

${section('scr_CoreInits', 'Core — in beiden VMs', 'Vektor-Mathematik, Kategorien, Threads, Blueprint-Registrierung, Dateizugriff.')}
${section('scr_UserInits', 'User — nur die UI-VM', 'maui-Controls, Kommandos, Selektion, Kamera, Session, Preferences.')}
${section('sim_SimInits', 'Sim — nur die Sim-VM', 'Units, weapons, brains, platoons, effects, economy.')}`

await mkdir('docs/research', { recursive: true })
await writeFile(OUT, body, 'utf8')

const counts = [...inits.entries()].map(
  ([k, v]) => `${k}: ${[...v.values()].reduce((n, s) => n + s.size, 0)}`,
)
console.log(`${OUT} geschrieben — ${counts.join(', ')}`)
