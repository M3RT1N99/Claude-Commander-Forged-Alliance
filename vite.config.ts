import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_GAME_DIR =
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

/**
 * Dev-only middleware: serves the local game installation under /gamefiles
 * with HTTP range support, so the app can be developed/tested without the
 * File-System-Access picker. Never part of a production build — assets stay
 * on the user's machine.
 */
function gameFileServer(): Plugin {
  const gameDir = process.env.CFA_GAME_DIR ?? DEFAULT_GAME_DIR

  const sanitize = (p: string): string => {
    const rel = path.normalize(p).replace(/^[/\\]+/, '')
    if (rel.split(/[/\\]/).some((seg) => seg === '..')) {
      throw new Error('invalid path')
    }
    return rel
  }

  return {
    name: 'cfa-game-file-server',
    configureServer(server) {
      server.middlewares.use('/gamefiles', (req, res) => {
        try {
          const u = new URL(req.url ?? '/', 'http://localhost')

          if (u.pathname === '/__list') {
            const dir = path.join(gameDir, sanitize(u.searchParams.get('dir') ?? ''))
            const items = fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
              name: d.name,
              dir: d.isDirectory(),
              size: d.isDirectory() ? 0 : fs.statSync(path.join(dir, d.name)).size,
            }))
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(items))
            return
          }

          const file = path.join(gameDir, sanitize(decodeURIComponent(u.pathname)))
          const st = fs.statSync(file)
          res.setHeader('accept-ranges', 'bytes')

          if (req.method === 'HEAD') {
            res.setHeader('content-length', String(st.size))
            res.end()
            return
          }

          const range = req.headers.range
          if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range)
            if (m) {
              const start = Number(m[1])
              const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
              res.statusCode = 206
              res.setHeader('content-range', `bytes ${start}-${end}/${st.size}`)
              res.setHeader('content-length', String(end - start + 1))
              fs.createReadStream(file, { start, end }).pipe(res)
              return
            }
          }

          res.setHeader('content-length', String(st.size))
          fs.createReadStream(file).pipe(res)
        } catch {
          res.statusCode = 404
          res.end('not found')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [gameFileServer()],
  server: {
    // Listen on all addresses, not just localhost: then BOTH works -
    // http://localhost:5173 on this computer and http://<LAN-IP>:5173 from
    // any other device on the network (Vite prints the address at startup).
    //
    // Attention: this means that /gamefiles can also be read in the local network in dev mode —
    // so the game installation. In the production build there is the middleware
    // not; There the files come from the folder that the user chooses.
    host: true,
  },
})
