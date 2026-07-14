/**
 * Klickt in der LAUFENDEN Seite auf einen Menü-Text und macht danach ein Bild.
 *
 *   1) chrome --headless=new --remote-debugging-port=9333 "<url>"
 *   2) npx tsx scripts/shot-click.ts <port> "<text>" bild.png
 */
const port = Number(process.argv[2] ?? 9333)
/** Mehrere Klicks nacheinander: "Optionen,Ton" */
const labels = (process.argv[3] ?? 'Optionen').split(',')
const outFile = process.argv[4] ?? 'shot.png'

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost'))
if (!page) {
  console.log('keine Seite gefunden')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown }
  if (m.id !== undefined) pending.get(m.id)?.(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))

const send = async (method: string, params: unknown = {}): Promise<any> => {
  const myId = ++id
  const done = new Promise<any>((r) => pending.set(myId, r))
  ws.send(JSON.stringify({ id: myId, method, params }))
  return done
}
const evaluate = async (expression: string): Promise<any> => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) return `FEHLER: ${JSON.stringify(res.exceptionDetails).slice(0, 200)}`
  return res.result?.value
}

for (const label of labels) {
  // Die Mitte des Controls finden, das den Text trägt.
  const pos = await evaluate(`(() => {
    const el = [...document.querySelectorAll('#maui-root div')].find(d => d.textContent === ${JSON.stringify(label)} && d.children.length === 0)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!pos) {
    console.log(`Text "${label}" nicht gefunden`)
    process.exit(1)
  }
  console.log(`klick auf "${label}" @${pos.x},${pos.y}`)
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: pos.x,
      y: pos.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
  }
  await new Promise((r) => setTimeout(r, 3500))
}

console.log('Log:', await evaluate(`document.querySelector('#log').textContent.split(String.fromCharCode(10)).filter(l => l.includes('FEHLER')).slice(-3).join(' || ') || 'kein Fehler'`))
console.log('Controls:', await evaluate(`document.querySelectorAll('#maui-root > div').length`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFile } = await import('node:fs/promises')
await writeFile(outFile, Buffer.from(shot.data, 'base64'))
console.log('Screenshot geschrieben')
ws.close()
