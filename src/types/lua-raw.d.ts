/**
 * Engine Lua is kept in real .lua files and imported as text.
 * Vite resolves `?raw` natively; Node does it via scripts/lua-loader.mjs.
 */
declare module '*.lua?raw' {
  const source: string
  export default source
}
declare module '*.lua' {
  const source: string
  export default source
}
