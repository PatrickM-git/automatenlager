'use strict';

/**
 * Sichtbarkeit der historischen GuV-Schicht (Issue #172).
 *
 * Befund: Das Steuerjahr 2025 liegt in guv_daily als source='sheets_seed' (Migration
 * aus der Google-Sheets-Ära) und wird vom GuV-Panel ANGEZEIGT — der einzige Quellen-
 * Filter im Lesepfad ist `source != 'historic_backfill'`. Der Backfill-Job (#172)
 * schreibt bewusst source='guv_backfill' (NICHT historic_backfill), damit die
 * nachgepflegten Posten ebenfalls sichtbar sind.
 *
 * Diese Tests sichern die Invariante strukturell ab: in den Lesepfaden wird AUSSCHLIESS-
 * LICH 'historic_backfill' ausgeschlossen; 'sheets_seed' und 'guv_backfill' tauchen in
 * KEINER Ausschluss-Klausel auf. Bricht jemand das (z. B. `source != 'guv_backfill'`),
 * wird die Historie unsichtbar — und dieser Test schlägt fehl.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
// Lesepfade, die historic_backfill filtern (gegen echten Code verifiziert).
const READ_PATH_FILES = ['economics.js', 'economics-live.js', 'assortment-slots.js', 'overview-monitoring.js'];

function readLib(f) { return fs.readFileSync(path.join(LIB, f), 'utf8'); }

test('#172 Sichtbarkeit: kein Lesepfad schließt sheets_seed oder guv_backfill aus', () => {
  for (const f of READ_PATH_FILES) {
    const src = readLib(f);
    // Ein Ausschluss sähe so aus: source != 'guv_backfill' / source <> 'sheets_seed'.
    assert.doesNotMatch(src, /source\s*(?:!=|<>)\s*'guv_backfill'/,
      `${f}: guv_backfill darf NICHT ausgeschlossen werden (sonst sind nachgepflegte Posten unsichtbar)`);
    assert.doesNotMatch(src, /source\s*(?:!=|<>)\s*'sheets_seed'/,
      `${f}: sheets_seed darf NICHT ausgeschlossen werden (sonst ist das Steuerjahr 2025 unsichtbar)`);
  }
});

test('#172 Sichtbarkeit: der Backfill schreibt die sichtbare Quelle guv_backfill (nicht historic_backfill)', () => {
  const bf = require('../lib/jobs/guv-backfill.js');
  assert.equal(bf.BACKFILL_SOURCE, 'guv_backfill');
  // Gegenprobe: 'historic_backfill' WIRD in mindestens einem Lesepfad gefiltert
  // (das ist die einzige bewusst ausgeblendete Quelle).
  const economics = readLib('economics.js');
  assert.match(economics, /source\s*(?:!=|<>)\s*'historic_backfill'/,
    'economics.js filtert weiterhin historic_backfill (die einzige ausgeblendete Quelle)');
});
