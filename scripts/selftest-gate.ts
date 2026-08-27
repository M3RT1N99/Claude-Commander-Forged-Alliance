/**
 * DER BROWSER-SELBSTTEST ALS GATE.
 *
 * `?sandbox=<karte>&selftest=<blueprint>` fährt im Browser die ganze Techdemo:
 * ACU spawnen, auswählen, Gebäude setzen, Fabrik bestücken, Panzer rollen,
 * Feind spawnen, Schuss, Treffer, Wrack, Partikel, Audio.
 *
 * CLAUDE.md nannte das jahrelang als Ende-zu-Ende-Gate. Es war keins: der
 * Selbsttest berechnete jeden Wert und schrieb dann Zeilen wie
 * „SELFTEST-KAMPF: KEIN Projektil-Mesh — der Sichtweg ist unterbrochen"
 * ins Log — ohne `throw`, ohne Exit-Code, ohne irgendein Signal, das ein
 * Treiber hätte lesen können. Ein Mensch musste ein Log-Fenster ansehen.
 *
 * Seit `selftestBefund()` in `src/main.ts` zählt er mit und hinterlegt das
 * Ergebnis in `document.title` (`SELFTEST-OK` / `SELFTEST-FAIL:N`) und in
 * `window.__selftest`. Dieses Skript liest es über das DevTools-Protokoll aus
 * und setzt den Exit-Code.
 *
 * Es läuft NICHT in `npm test`: es braucht einen laufenden Dev-Server und ein
 * headless Chrome. Der Weg:
 *
 *   1) npm run dev
 *   2) chrome --headless=new --mute-audio --remote-debugging-port=9333 \
 *        "http://localhost:5176/?sandbox=SCMP_009&selftest=uel0201"
 *   3) npx tsx scripts/selftest-gate.ts
 *
 * `--mute-audio` ist Pflicht — sonst hört der Nutzer Spielgeräusche ohne Fenster.
 */
const port = Number(process.argv[3] ?? 9333)
const timeoutMs = Number(process.argv[4] ?? 180_000)

interface Target {
  type: string
  url: string
  webSocketDebuggerUrl: string
}

let targets: Target[]
try {
  targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]
} catch {
  console.error(`Kein Chrome auf Port ${port}. Erst headless starten (siehe Kopf dieser Datei).`)
  process.exit(1)
}
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost'))
if (!page) {
  console.error('Keine Seite gefunden: ' + targets.map((t) => `${t.type} ${t.url}`).join(', '))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map<number, (v: unknown) => void>()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
  if (msg.id !== undefined) pending.get(msg.id)?.(msg.result)
})
await new Promise((r) => ws.addEventListener('open', r))

const evaluate = async (expr: string): Promise<unknown> => {
  const myId = ++id
  const done = new Promise<unknown>((r) => pending.set(myId, r))
  ws.send(
    JSON.stringify({
      id: myId,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: false },
    }),
  )
  const res = (await done) as { result?: { value?: unknown } }
  return res?.result?.value
}

interface SelftestErgebnis {
  status: string
  failures: number
  findings: string[]
}

console.log(`Warte auf das Selbsttest-Ergebnis (bis ${Math.round(timeoutMs / 1000)} s) …`)
const deadline = Date.now() + timeoutMs
let ergebnis: SelftestErgebnis | null = null
while (Date.now() < deadline) {
  const v = (await evaluate('window.__selftest ? JSON.stringify(window.__selftest) : null')) as
    | string
    | null
  if (v) {
    ergebnis = JSON.parse(v) as SelftestErgebnis
    break
  }
  await new Promise((r) => setTimeout(r, 1000))
}

ws.close()

if (!ergebnis) {
  console.error(
    'KEIN Ergebnis: der Selbsttest hat window.__selftest nie gesetzt.\n' +
      'Entweder lief er nicht (falsche URL — `&selftest=<blueprint>` fehlt?) oder er ist\n' +
      'unterwegs abgestürzt. Beides ist ein Fehlschlag, kein „unbekannt".',
  )
  process.exit(1)
}

console.log(`\n${ergebnis.status}`)
for (const f of ergebnis.findings) console.log(`  FUND ${f}`)
if (ergebnis.failures === 0) console.log('  kein Fund — die Kette läuft durch')
process.exit(ergebnis.failures === 0 ? 0 : 1)
