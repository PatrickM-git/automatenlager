'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #107 Query-Filter-Contract-Guard — Issue #122 (Gerüst, Melde-Modus), Stufe 3.
// SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md §"#107 …Guard"
//
// ZWECK: automatisch erkennen, ob mandanten-bezogene Tabellen AN DER TÜR VORBEI
// gelesen werden (direkter pg-Zugriff außerhalb von lib/tenant-db.js). Der
// Wächter ist ein Test der bestehenden Suite (Prior Art: db-schema-/produktart-
// Contract-Guards), KEIN Laufzeit-Hook.
//
// MECHANISMUS — STRUKTURELLER VERTRAG, KEIN SQL-PARSING: beliebiges SQL semantisch
// zu verstehen wäre fragil (zusammengebautes SQL, Joins, Aggregate) und damit eine
// Scheingarantie. Stattdessen wird strukturell geprüft: Gibt es rohen DB-Zugriff
// (new Client/new Pool/require('pg')/client.query/pool.query) AUSSERHALB der Tür?
// Damit reduziert sich „vergessener Filter" robust auf „greift jemand an der Tür
// vorbei?" — ohne SQL-Parser.
//
// MODI:
//   * buildReport()    — MELDE-MODUS: inventarisiert ALLE Lesepfade, listet die
//                        noch an der Tür vorbei laufenden (Worklist). Bricht NICHT.
//   * findViolations() — SCHARF: gegen eine (pro Slice schrumpfende) Allowlist
//                        noch-nicht-migrierter Dateien; alles außerhalb der
//                        Allowlist (und nicht die Tür) ist ein Verstoß. Im
//                        Endzustand (#129) ist die Allowlist leer ⇒ build-blocking.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

// Die EINE erlaubte DB-Zugriffsschicht (die Mandanten-Tür). Nur hier ist rohes pg
// legitim — „kein DB-Zugriff AUSSERHALB der Tür".
const DOOR_FILES = Object.freeze(['tenant-db.js']);

// Der Wächter selbst trägt die Erkennungsmuster (new Client/client.query/…) als
// String-LITERALE und würde sich sonst selbst melden. Er ist kein Lesepfad ⇒
// vom Scan ausgenommen (kein DB-Zugriff zur Laufzeit).
const SELF_FILES = Object.freeze(['query-filter-guard.js']);

// Reine Logik-/injizierte Module, die per Konstruktion kein rohes pg tragen, hier
// nur zur Dokumentation (sie tauchen ohnehin nicht in der Worklist auf, weil sie
// keines der Muster matchen): tenant-directory.js (injizierte query), pg-url.js,
// auth.js. KEIN Sonderfall nötig — der Scanner findet sie schlicht nicht.

// Rohe DB-Zugriffsmuster (grep-bar, strukturell — kein SQL-Parsing).
const RAW_DB_PATTERNS = Object.freeze([
  { re: /new\s+Client\b/, why: 'new Client' },
  { re: /new\s+Pool\b/, why: 'new Pool' },
  { re: /require\(\s*['"]pg['"]\s*\)/, why: "require('pg')" },
  { re: /\bclient\.query\s*\(/, why: 'client.query(' },
  { re: /\bpool\.query\s*\(/, why: 'pool.query(' },
]);

// ─── Global-Allowlist echt-globaler Tabellen (EXTREM ENG, dokumentiert) ──────────
// Default ist MANDANTENPFLICHTIG; global ist die begründete Ausnahme, nicht die
// Regel. Aufnahmekriterium: KEINERLEI kundenspezifische Information. Jede Aufnahme
// ist ein bewusster, reviewter Akt mit Begründung (siehe auch
// docs/security/query-filter-guard-allowlist.md).
//
// NICHT global (kundenspezifisch ⇒ mandantenpflichtig): machines, locations,
// settings_thresholds, products, sales_transactions, guv_daily, stock_batches,
// warnings, nayax_devices (als Geräte-ZUORDNUNG). Der einzige eng begründete
// Globalfall von nayax_devices ist die reine Existenz-/Claiming-Eindeutigkeits-
// prüfung (kein nutzersichtbarer Lesepfad; Onboarding/Stufe 6) — das ist eine
// QUERY-Form, keine Tabellen-Ausnahme, und daher NICHT hier gelistet.
const GLOBAL_TABLE_ALLOWLIST = Object.freeze({
  tenants:
    'Mandanten-Verzeichnis (Auth-Infrastruktur). Nur von der Verzeichnis-/Auth-Schicht gelesen, nie als Mandantendaten ausgespielt.',
  tenant_users:
    'Verzeichnis: Login→Mandant (Auth-Infrastruktur). Keine operativen Kundendaten.',
  platform_admins:
    'Verzeichnis: Break-Glass-Schlüssel der Plattform-Admins (Auth-Infrastruktur). Keine Kundendaten.',
});

function isGlobalTable(name) {
  return Object.prototype.hasOwnProperty.call(GLOBAL_TABLE_ALLOWLIST, String(name || '').trim());
}

/** Strukturelle Prüfung EINER Quelldatei: welche rohen DB-Muster kommen vor? */
function scanSource(src) {
  const text = String(src == null ? '' : src);
  return RAW_DB_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why);
}

/** Alle .js-Dateien eines Verzeichnisses (nicht rekursiv — lib/ ist flach). */
function listJsFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
}

/**
 * Scannt ein lib-Verzeichnis (und optional zusätzliche Einzeldateien außerhalb von
 * lib/) und klassifiziert jede Datei mit rohem DB-Zugriff in „Tür" (erlaubt) vs.
 * „bypass" (Worklist).
 *
 * #131 (Stufe 4): `entryFiles` erweitert den Scan ADDITIV auf Schreib-Einstiegs-
 * dateien, deren rohe pg-Transaktionen NICHT in lib/ liegen (v. a. server.js mit
 * den Endpunkt-Transaktionen wie write-off). So entgeht kein Schreibpfad der
 * Inventur nur, weil er im Server statt in einem lib-Modul steht. Melde-Modus.
 * @param {object} opts
 * @param {string} opts.libDir              flaches lib-Verzeichnis
 * @param {string[]} [opts.doorFiles]       erlaubte DB-Schicht (Basenames)
 * @param {string[]} [opts.entryFiles]      zusätzliche absolute Dateipfade (additiv)
 * @param {string[]} [opts.extraDirs]       zusätzliche flache Verzeichnisse (additiv,
 *                                          z. B. lib/jobs/ — Stufe 6 #160)
 * @returns {{door:{file,reasons}[], bypass:{file,reasons}[], all:{file,reasons}[]}}
 */
function buildReport({ libDir, doorFiles = DOOR_FILES, entryFiles = [], extraDirs = [] } = {}) {
  if (!libDir) throw new TypeError('query-filter-guard: libDir erforderlich');
  const all = [];
  for (const file of listJsFiles(libDir)) {
    if (SELF_FILES.includes(file)) continue; // der Wächter meldet sich nicht selbst
    const reasons = scanSource(fs.readFileSync(path.join(libDir, file), 'utf8'));
    if (reasons.length) all.push({ file, reasons });
  }
  // #160 (Stufe 6): zusätzliche Verzeichnisse (z. B. lib/jobs/) FLACH mitscannen,
  // per Basename klassifiziert (wie entryFiles). So unterliegen die portierten Jobs
  // demselben No-Bypass-Vertrag wie lib/ — der Worker injiziert die Tür, der einzige
  // legitime rohe-pg-Job ist der Infra-Runner (dokumentierte Allowlist-Ausnahme).
  for (const dir of extraDirs) {
    if (!fs.existsSync(dir)) continue; // fehlendes Verzeichnis ⇒ nichts zu scannen
    for (const file of listJsFiles(dir)) {
      if (SELF_FILES.includes(file) || all.some((r) => r.file === file)) continue;
      const reasons = scanSource(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (reasons.length) all.push({ file, reasons });
    }
  }
  // Additive Einstiegsdateien (absolute Pfade; per Basename klassifiziert).
  for (const fp of entryFiles) {
    const base = path.basename(fp);
    if (SELF_FILES.includes(base) || all.some((r) => r.file === base)) continue;
    const reasons = scanSource(fs.readFileSync(fp, 'utf8'));
    if (reasons.length) all.push({ file: base, reasons });
  }
  const door = all.filter((r) => doorFiles.includes(r.file));
  const bypass = all.filter((r) => !doorFiles.includes(r.file));
  return { door, bypass, all };
}

/**
 * SCHARFER Modus: liefert die Verstöße — bypass-Dateien, die NICHT auf der
 * (pro Slice schrumpfenden) Allowlist noch-nicht-migrierter Dateien stehen.
 * Allowlist leer ⇒ jeder bypass ist ein Verstoß (build-blocking-Endzustand).
 */
function findViolations({ libDir, doorFiles = DOOR_FILES, allowlist = [], entryFiles = [], extraDirs = [] } = {}) {
  const { bypass } = buildReport({ libDir, doorFiles, entryFiles, extraDirs });
  const allow = new Set(allowlist);
  return bypass.filter((r) => !allow.has(r.file));
}

/** Menschliche Zusammenfassung für den Melde-Modus (vom Test geloggt). */
function formatReport(report) {
  const lines = [];
  lines.push(`Query-Filter-Guard (Melde-Modus): ${report.bypass.length} Lesepfad(e) noch an der Tür vorbei.`);
  for (const b of report.bypass) lines.push(`  - ${b.file}  [${b.reasons.join(', ')}]`);
  return lines.join('\n');
}

module.exports = {
  DOOR_FILES,
  RAW_DB_PATTERNS,
  GLOBAL_TABLE_ALLOWLIST,
  isGlobalTable,
  scanSource,
  listJsFiles,
  buildReport,
  findViolations,
  formatReport,
};
