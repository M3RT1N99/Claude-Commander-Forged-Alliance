/**
 * DAS DURCHSPIELEN ALS GATE — damit `npm test` es überhaupt ausführt.
 *
 * `scripts/playthrough.ts` ist das einzige im Repo, das eine ganze Partie fährt
 * (Sim-VM + UI-VM, dieselben Boot-Pfade wie der Browser) und dabei jeden WARN,
 * jeden Lua-Fehler und jedes fehlende Engine-Teil mit Datei und Zeile sammelt.
 *
 * Es endete unbedingt mit `process.exit(0)`. Es konnte also nichts melden, was
 * jemanden aufhält — und `run-tests.ts` nimmt ohnehin nur Dateien, die mit
 * `verify` beginnen, also lief es nie automatisch. Damit war die Ende-zu-Ende-
 * Abdeckung des Projekts exakt null, obwohl das Werkzeug dafür fertig dalag.
 *
 * Seit dieser Änderung vergleicht es seine Funde gegen eine eingecheckte Liste
 * (`scripts/fixtures/playthrough-baseline.json`): ein NEUER Fund macht rot, ein
 * verschwundener ist Fortschritt und darf die Liste kürzen. Verglichen werden
 * die Fund-Schlüssel, nicht die Anzahl — sonst verdeckt ein behobener Fehler
 * einen neuen.
 *
 * Rot geprüft, bevor es zählt: ein künstliches `WARN` im Fabrik-Tick erscheint
 * als „NEUER Fund" und das Gate wird rot.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-playthrough.ts
 */
await import('./playthrough.ts')

// Top-level `await` needs this file to BE a module (TS1375). The only import
// above is a dynamic one, so the module marker has to be explicit.
export {}
