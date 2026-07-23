/**
 * Node module hook: import *.lua files as text, exactly like Vite's `?raw`.
 *
 * Engine Lua lives in real .lua files (syntax highlighting, no TS template
 * literal escaping traps — a backtick in a Lua comment used to silently end
 * the TS string). Vite understands `import src from './x.lua?raw'` natively;
 * Node does not, so this hook teaches it the same thing.
 *
 * Registered via scripts/register-lua.mjs, loaded with `tsx --import`.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const isLua = (s) => s.split('?')[0].endsWith('.lua')

export async function resolve(specifier, context, next) {
  if (isLua(specifier)) {
    const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd()
    const file = specifier.split('?')[0]
    const abs = file.startsWith('.') ? resolvePath(base, file) : file
    return { url: pathToFileURL(abs).href, format: 'lua', shortCircuit: true }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (context.format === 'lua' || isLua(url)) {
    const source = await readFile(fileURLToPath(url.split('?')[0]), 'utf8')
    return {
      format: 'module',
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    }
  }
  return next(url, context)
}
