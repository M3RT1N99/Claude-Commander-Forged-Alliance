/**
 * Screenshot der LAUFENDEN Seite über das DevTools-Protokoll.
 *
 * Nicht `chrome --screenshot --virtual-time-budget` nehmen: die virtuelle Zeit
 * treibt unsere requestAnimationFrame-Schleife nicht, und das Bild zeigt die
 * Seite VOR der ersten Animation — im Hauptmenü sieht man dann ein leeres
 * Klammergerüst, weil die Knöpfe noch auf Alpha 0 stehen (main.lua:610).
 *
 *   1) chrome --headless=new --remote-debugging-port=9333 "<url>"
 *   2) npx tsx scripts/shot.ts "<url>" bild.png
 */
const port = 9333
const url = process.argv[2] ?? 'http://localhost:5176/?http&frontend'

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost'))
if (!page) {
  console.log('keine Seite gefunden:', targets.map((t) => `${t.type} ${t.url}`).join(', '))
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
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }),
  )
  const res = (await done) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  if (res.exceptionDetails) return `FEHLER: ${JSON.stringify(res.exceptionDetails).slice(0, 200)}`
  return res.result?.value
}

console.log('Seite:', page.url)
const info = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('[data-name="button"]')]
  return JSON.stringify({
    buttons: btns.length,
    opacities: btns.slice(0, 3).map(b => b.style.opacity),
    controls: document.querySelectorAll('#maui-root > div').length,
  })
})()`)
console.log('Zustand:', info)

// Screenshot ueber CDP — mit LAUFENDER Seite, nicht mit eingefrorener virtueller Zeit.
const shotId = ++id
const shotDone = new Promise<unknown>((r) => pending.set(shotId, r))
ws.send(JSON.stringify({ id: shotId, method: 'Page.captureScreenshot', params: { format: 'png' } }))
const shot = (await shotDone) as { data: string }
const { writeFile } = await import('node:fs/promises')
await writeFile(process.argv[3] ?? 'shot.png', Buffer.from(shot.data, 'base64'))
console.log('Screenshot geschrieben')
ws.close()
