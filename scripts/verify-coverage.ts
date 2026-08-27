/**
 * Die Bestandsaufnahme ALS GATE — damit `npm test` sie überhaupt ausführt.
 *
 * `scripts/coverage-engine.ts` misst jede der 1149 Engine-Bindungen und prüft
 * sich seit dieser Änderung selbst gegen eine eingecheckte Untergrenze
 * (`scripts/fixtures/coverage-baseline.json`). Aufgerufen wurde es aber von
 * niemandem: `run-tests.ts` nimmt nur Dateien, die mit `verify` beginnen.
 *
 * Genau das war der teuerste Einzelfehler des Projekts — das Werkzeug meldete
 * **43 Tage lang** „398 Bindungen, 86 %, NO-OP 0", während 751 Klassen-Bindungen
 * gar nicht geparst wurden. Ein Messgerät, dessen Ausfall niemand bemerkt, ist
 * schlimmer als keins.
 *
 * Rot geprüft, bevor es zählt: entfernt man die CRLF-Normalisierung in
 * `coverage-engine.ts:34`, meldet der Bericht wieder exakt 398/86 %/NO-OP 0 —
 * und dieses Gate wird rot mit „0 Klassenzeilen geparst".
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-coverage.ts
 */
await import('./coverage-engine.ts')

// Top-level `await` needs this file to BE a module (TS1375). The only import
// above is a dynamic one, so the module marker has to be explicit.
export {}
