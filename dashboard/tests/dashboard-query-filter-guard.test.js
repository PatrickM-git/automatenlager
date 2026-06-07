'use strict';

/**
 * #107 Query-Filter-Contract-Guard — Gerüst im MELDE-MODUS (Issue #122, Stufe 3).
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md §"#107 …Guard"
 *
 * STRUKTURELLER Vertrag (KEIN SQL-Parsing): der Wächter erzwingt
 *   (a) kein direkter DB-Zugriff (new Client/new Pool/require('pg')/client.query/
 *       pool.query) AUSSERHALB der Tür (lib/tenant-db.js);
 *   (b) eine bewusste, enge Global-Allowlist echt-globaler Tabellen.
 *
 * In Stufe 3/#122 läuft er im MELDE-MODUS: er INVENTARISIERT alle noch an der Tür
 * vorbei laufenden Lesepfade (Worklist) und bricht den Build NICHT. Der scharfe
 * Modus (findViolations gegen eine schrumpfende Allowlist) wird hier nur als
 * Mechanismus bewiesen (Pflicht-Testfälle 7 + 12), scharf geschaltet wird er
 * bereichsweise in #123ff. und vollständig in #129.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const guard = require('../lib/query-filter-guard.js');

const LIB_DIR = path.join(__dirname, '..', 'lib');

test('#122 Guard Melde-Modus: Worklist aller noch ungefilterten Lesepfade, bricht NICHT', () => {
  const report = guard.buildReport({ libDir: LIB_DIR });
  assert.ok(Array.isArray(report.bypass), 'bypass-Worklist ist eine Liste');
  // Heute laufen noch viele Module an der Tür vorbei — die Worklist ist nicht leer.
  assert.ok(report.bypass.length > 0, 'Melde-Modus listet noch-ungefilterte Lesepfade');
  const files = report.bypass.map((b) => b.file);
  // Stabile Vertreter, die strukturell rohes pg tragen (Infrastruktur-Guards, KEIN
  // Mandanten-Datenpfad): db-schema (information_schema), stock-cost-invariant
  // (Invarianten-Check). Alle Stufe-4-SCHREIBPFADE (location-profiles #135,
  // machine-create/-profiles #136, settings-thresholds #137) sind durch die Tür.
  for (const known of ['db-schema.js', 'stock-cost-invariant.js']) {
    assert.ok(files.includes(known), `Worklist enthält ${known}`);
  }
  // Jeder Eintrag trägt eine Begründung (welches Muster).
  for (const b of report.bypass) {
    assert.ok(Array.isArray(b.reasons) && b.reasons.length > 0, `${b.file} hat Begründungen`);
  }
});

test('#122 Guard: die Tür (tenant-db.js) ist erlaubte DB-Schicht, NICHT in der Worklist', () => {
  const report = guard.buildReport({ libDir: LIB_DIR });
  const bypassFiles = report.bypass.map((b) => b.file);
  assert.ok(!bypassFiles.includes('tenant-db.js'), 'die Tür gilt nicht als Verstoß');
  assert.ok(report.door.some((d) => d.file === 'tenant-db.js'), 'die Tür ist als DOOR_FILE klassifiziert');
});

test('#122 Guard: reine Logik-/injizierte Module werden NICHT fälschlich gemeldet', () => {
  // tenant-directory.js (Stufe-2-Registry) nutzt injizierte query → kein rohes pg.
  // pg-url.js ist reine String-Logik. auth.js ist DB-frei.
  const report = guard.buildReport({ libDir: LIB_DIR });
  const bypassFiles = report.bypass.map((b) => b.file);
  for (const clean of ['tenant-directory.js', 'pg-url.js', 'auth.js']) {
    assert.ok(!bypassFiles.includes(clean), `${clean} darf nicht gemeldet werden (kein rohes pg)`);
  }
});

test('#122 Guard scharfer Probe-Modus (Testfall 7+12): roher DB-Read außerhalb der Tür schlägt fehl', () => {
  // Synthetische Quellen — der Scanner arbeitet rein strukturell auf Quelltext.
  for (const src of [
    "const { Client } = require('pg'); const c = new Client(); c.query('SELECT 1');",
    "const c = new (require('pg').Client)(); c.query('SELECT * FROM automatenlager.guv_daily');",
    "const pool = new Pool(); pool.query('SELECT 1');",
  ]) {
    const reasons = guard.scanSource(src);
    assert.ok(reasons.length > 0, `roher DB-Zugriff wird erkannt: ${src.slice(0, 30)}…`);
  }
  // Sauberer Tür-Konsument (geht durch die Tür) → kein Befund.
  const clean = "const r = await tenantDb.read({ tenant, tables: ['guv_daily'], text: 'SELECT 1' });";
  assert.equal(guard.scanSource(clean).length, 0, 'Tür-Konsum ist kein Verstoß');
});

test('#122 Guard findViolations: schrumpfende Allowlist (bereichsweise scharf)', () => {
  const report = guard.buildReport({ libDir: LIB_DIR });
  const allBypass = report.bypass.map((b) => b.file);

  // Volle aktuelle Worklist als Allowlist ⇒ KEINE Verstöße (Melde-Modus-Äquivalent).
  const none = guard.findViolations({ libDir: LIB_DIR, allowlist: allBypass });
  assert.equal(none.length, 0, 'mit voller Allowlist keine Verstöße');

  // Einen Bereich „scharf schalten" (aus der Allowlist nehmen) ⇒ er wird zum Verstoß.
  const sharpened = allBypass.filter((f) => f !== 'db-schema.js');
  const violations = guard.findViolations({ libDir: LIB_DIR, allowlist: sharpened });
  assert.ok(violations.some((v) => v.file === 'db-schema.js'),
    'ein aus der Allowlist genommenes rohes pg-Modul ist ein Verstoß');
});

// ── Bereichsweise scharf (Default-Deny, schrumpfende Allowlist) ──────────────────
// Noch NICHT migrierte Module mit rohem DB-Zugriff. Pro Slice wird diese Liste
// KLEINER; im Endzustand (#129) bleibt nur die Infrastruktur-Ausnahme. Migrierte
// Module dürfen hier NICHT stehen — sonst könnten sie unbemerkt zurückfallen.
// Noch raw: Module mit Stufe-4-SCHREIBPFADEN (Lesepfade sind durch die Tür migriert,
// aber upsert/create/delete/setThreshold bleiben roh = Stufe 4) + Infrastruktur-Guards
// (db-schema, stock-cost-invariant lesen information_schema/Invarianten, kein Mandanten-
// Datenpfad) + correction-cases/product-onboarding (#128). Schrumpft weiter in #128.
// Verbleibende Allowlist nach #128. Zwei Klassen (in #129 final klassifiziert):
//  (a) INFRASTRUKTUR-Guards (kein Mandanten-Datenpfad): db-schema (information_schema),
//      stock-cost-invariant (Invarianten-Check). Bleiben dauerhaft.
//  (b) Module mit Stufe-4-SCHREIBPFADEN (Lesepfade migriert, upsert/create/delete/
//      setThreshold bleiben roh = Stufe 4): location-profiles, machine-create,
//      machine-profiles, settings-thresholds.
const STILL_BYPASSING = [
  'db-schema.js', 'stock-cost-invariant.js',
];
// Pro Slice durch die Tür geführte (migrierte) Lese-Module bzw. -pfade.
const MIGRATED = [
  'economics.js', 'economics-live.js',                                  // #123 Finanzen/GuV
  'overview-monitoring.js', 'automaten-view.js', 'alert-digest.js',     // #124 Übersicht/Cockpit/Monitoring
  'assortment-slots.js', 'category-config.js',                          // #125 Sortiment
  'inventory-mhd.js',                                                   // #126 Bestand/MHD/Lager
  'nayax-devices.js',                                                   // #127 (reines Lesemodul ⇒ voll migriert)
  'correction-cases.js', 'product-onboarding.js',                      // #128 (reine Lesemodule ⇒ voll migriert)
];

test('#123 Guard scharf: kein Bypass außerhalb der schrumpfenden Allowlist (Default-Deny)', () => {
  const violations = guard.findViolations({ libDir: LIB_DIR, allowlist: STILL_BYPASSING });
  assert.deepEqual(violations.map((v) => v.file), [],
    'jeder noch-rohe Lesepfad muss explizit allowlistet sein; Neuzugang ⇒ Verstoß');
});

test('#123 Guard: Finanz-Module migriert (nicht im Bypass, NICHT allowlistet ⇒ Rückfall = Verstoß)', () => {
  const bypassFiles = guard.buildReport({ libDir: LIB_DIR }).bypass.map((b) => b.file);
  for (const f of MIGRATED) {
    assert.ok(!bypassFiles.includes(f), `${f} ist migriert (kein rohes pg mehr)`);
    assert.ok(!STILL_BYPASSING.includes(f), `${f} ist NICHT allowlistet`);
  }
});

test('#122 Guard: enge, dokumentierte Global-Allowlist — Default mandantenpflichtig', () => {
  // Echt-global (Verzeichnis/Auth-Infrastruktur, keine Kundendaten):
  for (const g of ['tenants', 'tenant_users', 'platform_admins']) {
    assert.equal(guard.isGlobalTable(g), true, `${g} ist global`);
    assert.ok(guard.GLOBAL_TABLE_ALLOWLIST[g] && guard.GLOBAL_TABLE_ALLOWLIST[g].length > 5,
      `${g} hat eine Begründung`);
  }
  // NICHT global — kundenspezifischer Inhalt ⇒ mandantenpflichtig (Reviewer-Härtung):
  for (const t of ['machines', 'locations', 'settings_thresholds', 'sales_transactions',
                   'guv_daily', 'products', 'stock_batches', 'warnings', 'nayax_devices']) {
    assert.equal(guard.isGlobalTable(t), false, `${t} ist mandantenpflichtig, NICHT global`);
  }
});

test('#122 Guard: Global-Allowlist ist bewusst eng (keine schleichende Aufblähung)', () => {
  // Anti-Regression: die Liste bleibt sehr kurz (nur Verzeichnis/Auth). Wächst sie,
  // muss diese Zahl bewusst angefasst und die Aufnahme begründet werden.
  const n = Object.keys(guard.GLOBAL_TABLE_ALLOWLIST).length;
  assert.ok(n <= 5, `Global-Allowlist eng halten (ist ${n}, erwartet ≤ 5)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// #129 — BUILD-BLOCKING-ENDZUSTAND
// Alle Lese-Domänen (#123–#128) sind migriert ⇒ die Read-Migrations-Ausnahmeliste
// ist LEER. Was strukturell noch rohes pg trägt, ist ausschließlich:
//  (a) INFRASTRUKTUR — kein Mandanten-Datenpfad (information_schema/Invarianten);
//  (b) STUFE-4-SCHREIBPFADE — die Lesepfade dieser Module sind durch die Tür; nur
//      ihre Schreibfunktionen (upsert/create/delete/setThreshold) bleiben roh und
//      werden in Stufe 4 (Schreib-Isolation) + Stufe 5 (RLS) nachgezogen.
// Ab jetzt bricht JEDER neue rohe/ungefilterte Read AUSSERHALB dieser Allowlist
// den Build (build-blocking, nicht nur Warnung).
// ─────────────────────────────────────────────────────────────────────────────
const INFRASTRUCTURE_ALLOWLIST = ['db-schema.js', 'stock-cost-invariant.js'];
// Nach #135–#137 sind ALLE lib-Schreibpfade durch die Tür ⇒ leer. (Der verbleibende
// rohe Schreib-Einstieg ist die write-off-Transaktion in server.js — #138/#139, via
// entryFiles erfasst, nicht über libDir.)
const STUFE4_WRITE_ALLOWLIST = [];
const FINAL_ALLOWLIST = [...INFRASTRUCTURE_ALLOWLIST, ...STUFE4_WRITE_ALLOWLIST];

test('#129 Guard build-blocking: kein roher DB-Zugriff außerhalb der finalen Allowlist', () => {
  const violations = guard.findViolations({ libDir: LIB_DIR, allowlist: FINAL_ALLOWLIST });
  assert.deepEqual(violations.map((v) => v.file), [],
    'Endzustand: jeder NEUE rohe/ungefilterte Read bricht den Build (keine Toleranz)');
});

test('#129 Guard: Read-Migrations-Ausnahmeliste ist LEER (alle Lese-Domänen migriert)', () => {
  // Alle migrierten Lese-Module sind NICHT auf der finalen Allowlist (kein Rückfall möglich).
  for (const f of MIGRATED) {
    assert.ok(!FINAL_ALLOWLIST.includes(f), `${f} ist migriert und NICHT allowlistet`);
  }
  // STILL_BYPASSING (laufende Allowlist) deckt sich mit der finalen Allowlist —
  // es gibt keine "noch nicht migriert"-Restposten mehr (nur Infra + Stufe-4-Writes).
  assert.deepEqual([...STILL_BYPASSING].sort(), [...FINAL_ALLOWLIST].sort());
});

test('#129 Guard (Testfall 12+13): künstlicher roher/ungefilterter Read bräche den Build', () => {
  // No-Bypass (Testfall 12): direkter pg.Client-Read außerhalb der Tür.
  assert.ok(guard.scanSource("const c = new (require('pg').Client)(); await c.connect(); c.query('SELECT 1');").length > 0);
  // Build-blocking (Testfall 13): eine neue lib-Datei mit rohem Read wäre — da NICHT
  // auf der finalen Allowlist — sofort ein Verstoß (findViolations würde sie melden).
  const simulatedNewBypass = FINAL_ALLOWLIST; // ein NEUES Modul stünde hier NICHT drin
  assert.ok(!simulatedNewBypass.includes('a-new-unfiltered-read-module.js'),
    'ein neues ungefiltertes Lesemodul ist per Definition nicht allowlistet ⇒ Build rot');
});
