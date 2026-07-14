/**
 * Fremder Code lebt in eigenen Dateien und wird als TEXT importiert.
 *
 * Zwei Sprachen sind das:
 *   *.lua    Engine-Lua      (src/engine-lua/**)
 *   *.glsl   Shader          (src/viewer/shaders/**)
 *
 * Beides gehört NICHT in TS-Template-Literale (CLAUDE.md): dort sieht kein
 * Werkzeug den Code als das, was er ist — keine Syntaxhervorhebung, keine
 * Prüfung, und ein Backtick in einem Kommentar beendet still den TS-String.
 *
 * Vite löst `?raw` von selbst auf; Node lernt es über scripts/lua-loader.mjs.
 */
declare module '*.lua?raw' {
  const source: string
  export default source
}
declare module '*.lua' {
  const source: string
  export default source
}
declare module '*.glsl?raw' {
  const source: string
  export default source
}
declare module '*.glsl' {
  const source: string
  export default source
}
