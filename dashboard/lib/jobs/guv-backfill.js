'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GuV-Backfill-Job (Issue #172): wartbares, idempotentes Lücken-Füllen für die GuV,
// wenn Nayax keine/unvollständige Verkaufszahlen geliefert hat.
// SPEC-Kontext: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
//
// PRINZIP:
//   * Authoritative Fallback-Quelle = ein vom Betreiber gepflegter Nayax-Roh-Export
//     (Google-Sheet, CSV-Export ohne Login). Format je Zeile: Produktauswahl
//     "Name(MDB  PREIS)", Begleichszeit (DD.MM.YYYY), "Zu begleichender Wert".
//   * Mapping (Name→product_key via Aliase/Produktname, MDB→product_key via aktive
//     slot_assignments) + EK aus stock_batches — alles aus der AKTUELLEN DB.
//   * Aggregation/Buchung über GENAU dieselbe Logik wie der Nacht-Job
//     (computeGuvRows + writeGuvRows aus guv-aggregate.js) → byte-genau, keine zweite
//     Formel. Kleinunternehmer ⇒ brutto + cost_basis-Stempel.
//   * IDEMPOTENT + lückenfüllend: Dedup gegen vorhandene guv_daily-Keys + Insert
//     ON CONFLICT (guv_key) DO NOTHING ⇒ „greift immer", beliebig wiederholbar.
//   * source='guv_backfill' (NICHT 'historic_backfill', das vom Panel gefiltert wird)
//     ⇒ die nachgepflegten Posten sind im GuV-Panel SICHTBAR.
//
// ZWEI Betriebsarten, EINE Logik (runGuvBackfillForTenant):
//   * On-Demand-CLI tools/run-guv-backfill.js (Vorschau/Einmallauf).
//   * Wiederkehrender Worker-Job createGuvBackfillJob (s. u.) — erkennt GuV-Lücken
//     automatisch und füllt sie, wenn Nayax nichts/Unvollständiges lieferte. Quelle
//     (Sheet-ID) via Env GUV_BACKFILL_SHEET_ID; perspektivisch pro Mandant (Stufe 6).
//
// KEINE Pflege-Tabelle (User-Vorgabe): unfüllbare Verkäufe (noMap/noEK) werden als
// Lauf-Telemetrie/Warnung gemeldet, nicht in einer Tabelle geführt.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('node:https');
const { computeGuvRows, writeGuvRows } = require('./guv-aggregate.js');

const BACKFILL_SOURCE = 'guv_backfill';
const WORKFLOW_KEY = 'wf-guv-backfill';
// Vom Betreiber freigegebenes Sheet mit den Roh-Umsätzen (öffentlicher CSV-Export,
// kein Login). Heute global; Stufe 6: pro Mandant via injiziertem fetchSource/Config.
const DEFAULT_SHEET_ID = '16RAC2iUmnSxVWJf-F3Bai2zPSGGs5BLF';
// Der einzige produktive Automat heute (n8n war auf '457107528' hartkodiert); pro
// Mandant konfigurierbar in Stufe 6. Env-Override GUV_BACKFILL_MACHINE_KEY.
const DEFAULT_MACHINE_KEY = '457107528';
// Format der Produktauswahl: "Name(MDB  PREIS)" oder "Name(MDB = PREIS)".
const INFO_RE = /^(.+?)\((\d+)\s+(?:=\s+)?(\d+\.?\d*)\)$/;

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }

// Robuster CSV-Parser (quoted, eingebettete Zeilenumbrüche — Nayax-Produktauswahl
// enthält oft ein '\n'). Liefert Array von Zeilen-Arrays.
function parseCsv(text) {
  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cur.push(f); f = ''; }
    else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}

// "DD.MM.YYYY ..." → "YYYY-MM-DD"
function parseGermanDate(dt) {
  const m = String(dt == null ? '' : dt).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/**
 * Parst den Nayax-Roh-Export (CSV des freigegebenen Sheets) in Roh-Verkäufe.
 * Spalten werden per Header-Name gefunden (robust gegen Spalten-Umordnung):
 *   "Produktauswahl-Informationen" (Name(MDB PREIS)), "Produktcode in Karte" (MDB),
 *   "Zu begleichender Wert" (brutto), "Maschinen-Begleichszeit" (Settlement).
 * @returns {{date,machineKey,name,mdb,gross}[]}
 */
function parseNayaxExportCsv(csvText, { machineKey = '457107528' } = {}) {
  const rows = parseCsv(csvText);
  const hi = rows.findIndex((r) => r.some((c) => /Transaktions-ID/.test(c)));
  if (hi === -1) return [];
  const header = rows[hi].map((h) => h.trim());
  const col = (needle) => header.findIndex((h) => h.toLowerCase().includes(needle.toLowerCase()));
  const cInfo = col('Produktauswahl');
  const cMdb = col('Produktcode in Karte');
  const cGross = col('Zu begleichender Wert');
  const cSettle = col('Begleichszeit');
  const cAuth = col('Autorisierungszeit');

  const out = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || r.length <= cInfo) continue;
    const info = String(r[cInfo] || '').trim();
    const date = parseGermanDate(r[cSettle] || r[cAuth] || '');
    if (!date) continue;
    const m = info.match(INFO_RE);
    let name = '', mdb = String(r[cMdb] || '').trim(), gross = num(r[cGross]);
    if (m) { name = m[1].trim(); mdb = String(parseInt(m[2], 10)); gross = gross || parseFloat(m[3]); }
    else if (!info) continue; // weder Info noch Name ⇒ unbrauchbar
    out.push({ date, machineKey, name, mdb, gross });
  }
  return out;
}

/**
 * Baut aus Roh-Verkäufen + DB-Maps die EXAKTEN computeGuvRows-Eingaben (transactions/
 * batches/products), damit der Backfill byte-genau wie der Nacht-Job rechnet.
 * Liefert zusätzlich die nicht auflösbaren Verkäufe (noMap/noEK) zur Meldung.
 */
function buildComputeInputs(rawSales, { aliasMap, mdbMap, ekMap, categoryMap }) {
  const transactions = [];
  const batchesByKey = new Map();
  const productsByKey = new Map();
  const unresolved = { noMap: [], noEK: [] };

  for (const s of rawSales) {
    const pk = aliasMap.get(norm(s.name)) || mdbMap.get(String(s.mdb));
    if (!pk) { unresolved.noMap.push(s); continue; }
    const ek = ekMap.get(pk);
    if (!(ek && ek.unitCostNet > 0)) { unresolved.noEK.push({ ...s, product_key: pk }); continue; }

    const batchId = `bf_${pk}`;
    if (!batchesByKey.has(batchId)) {
      batchesByKey.set(batchId, { batch_id: batchId, unit_cost: ek.unitCostNet, mwst_satz: ek.vatRatePct });
    }
    if (!productsByKey.has(pk)) {
      productsByKey.set(pk, { product_key: pk, produktart: categoryMap.get(pk) || '', sale_price_eur: String(s.gross) });
    }
    transactions.push({
      settlement_datetime_gmt: `${s.date}T10:00:00Z`,
      machine_id: s.machineKey,
      product_key: pk,
      mdb_code_extracted: s.mdb,
      mdb_code: s.mdb,
      quantity: 1,
      umsatz_brutto: s.gross,
      vk_preis_brutto: String(s.gross),
      status: 'OK',
      batch_id_abgebucht: batchId,
    });
  }
  return {
    transactions,
    batches: [...batchesByKey.values()],
    products: [...productsByKey.values()],
    unresolved,
  };
}

// ── DB-Maps durch die Tür (per Mandant) ──────────────────────────────────────
async function loadBackfillMaps(db, tenant) {
  const q = (text) => db.read({ tenant, tables: ['products', 'product_aliases', 'slot_assignments', 'stock_batches'], text });
  const prods = (await q(`SELECT product_key, name, category, vat_rate_pct FROM automatenlager.products WHERE tenant_id = $1`)).rows;
  const aliases = (await q(`SELECT a.alias, p.product_key FROM automatenlager.product_aliases a JOIN automatenlager.products p ON p.product_id = a.product_id AND p.tenant_id = a.tenant_id WHERE a.tenant_id = $1`)).rows;
  const slots = (await q(`SELECT s.mdb_code, p.product_key FROM automatenlager.slot_assignments s JOIN automatenlager.products p ON p.product_id = s.product_id AND p.tenant_id = s.tenant_id WHERE s.tenant_id = $1 AND s.active = TRUE`)).rows;
  // EK-Referenz = ÄLTESTE Charge je Produkt mit positivem Netto-EK (wie der Original-
  // Backfill „erste/älteste Charge"), nicht min() — vermeidet Cent-Ausreißer.
  const eks = (await q(`SELECT DISTINCT ON (p.product_key) p.product_key, b.unit_cost_net AS ek, p.vat_rate_pct AS vat
                          FROM automatenlager.stock_batches b
                          JOIN automatenlager.products p ON p.product_id = b.product_id AND p.tenant_id = b.tenant_id
                         WHERE b.tenant_id = $1 AND b.unit_cost_net > 0
                         ORDER BY p.product_key, b.received_at ASC NULLS LAST, b.batch_id ASC`)).rows;

  const aliasMap = new Map();
  for (const p of prods) aliasMap.set(norm(p.name), p.product_key);
  for (const a of aliases) aliasMap.set(norm(a.alias), a.product_key);
  const mdbMap = new Map();
  for (const s of slots) mdbMap.set(String(s.mdb_code), s.product_key);
  const categoryMap = new Map();
  for (const p of prods) categoryMap.set(p.product_key, p.category);
  const ekMap = new Map();
  for (const e of eks) ekMap.set(e.product_key, { unitCostNet: num(e.ek), vatRatePct: num(e.vat) });
  return { aliasMap, mdbMap, ekMap, categoryMap };
}

async function loadExistingKeys(db, tenant) {
  const res = await db.read({
    tenant, tables: ['guv_daily', 'machines', 'products'],
    text:
      `SELECT to_char(gd.posting_date,'YYYY-MM-DD') AS date, m.machine_key AS machine_id, p.product_key AS product_key
         FROM automatenlager.guv_daily gd
         JOIN automatenlager.machines m ON m.machine_id = gd.machine_id AND m.tenant_id = gd.tenant_id
         JOIN automatenlager.products p ON p.product_id = gd.product_id AND p.tenant_id = gd.tenant_id
        WHERE gd.tenant_id = $1`,
  });
  return res.rows;
}

/**
 * Backfill für EINEN Mandanten: parst die Quelle, mappt, rechnet wie der Nacht-Job,
 * füllt fehlende guv_daily-Posten (idempotent). dryRun ⇒ nur Vorschau, kein Write.
 */
async function runGuvBackfillForTenant(db, tenant, { csvText, config = null, dryRun = false, machineKey = '457107528' } = {}) {
  const rawSales = parseNayaxExportCsv(csvText, { machineKey });
  const maps = await loadBackfillMaps(db, tenant);
  const existingKeys = await loadExistingKeys(db, tenant);
  const cfg = config || await loadConfig(db, tenant);

  const { transactions, batches, products, unresolved } = buildComputeInputs(rawSales, maps);
  // GENAU die Nacht-Job-Logik: brutto-Kostenbasis + cost_basis-Stempel, Dedup via existingKeys.
  const { rows } = computeGuvRows({ transactions, batches, products, config: cfg, existingKeys, skipExisting: true });
  const backfillRows = rows.map((r) => ({ ...r, source: BACKFILL_SOURCE }));

  const summary = {
    tenant,
    rawSales: rawSales.length,
    mapped: transactions.length,
    noMap: unresolved.noMap.length,
    noEK: unresolved.noEK.length,
    newRows: backfillRows.length,
    unresolved,
  };
  if (dryRun) return { ...summary, dryRun: true, rows: backfillRows };
  const writeRes = await writeGuvRows(db, tenant, backfillRows);
  // writeRes.unresolved ist eine ZAHL (write-seitige machine_key/product_key-Resolve-
  // Fehler) und würde sonst das Mapping-Objekt summary.unresolved (noMap/noEK-Arrays)
  // überschreiben. Getrennt führen: `unresolved` bleibt das Objekt (Samples für CLI +
  // Worker-Telemetrie), die Write-Zahl wird `unresolvedWrites`.
  const { unresolved: unresolvedWrites, ...writeCounts } = writeRes;
  return { ...summary, ...writeCounts, unresolvedWrites };
}

async function loadConfig(db, tenant) {
  const res = await db.read({
    tenant, tables: ['classification_settings'],
    text: `SELECT COALESCE((SELECT config FROM automatenlager.classification_settings WHERE tenant_id='__default__' AND $1::text IS NOT NULL), '{}'::jsonb) AS config`,
  });
  return (res.rows[0] && res.rows[0].config) || {};
}

// ── Quelle: freigegebener Google-Sheet-CSV-Export ────────────────────────────
/** Sheet-ID aus der Env (GUV_BACKFILL_SHEET_ID) ODER der Default. Stufe 6: pro Mandant. */
function resolveSheetId(env = process.env) {
  const v = env && env.GUV_BACKFILL_SHEET_ID != null ? String(env.GUV_BACKFILL_SHEET_ID).trim() : '';
  return v || DEFAULT_SHEET_ID;
}

/** Ziel-Automat aus der Env (GUV_BACKFILL_MACHINE_KEY) ODER der Default. */
function resolveMachineKey(env = process.env) {
  const v = env && env.GUV_BACKFILL_MACHINE_KEY != null ? String(env.GUV_BACKFILL_MACHINE_KEY).trim() : '';
  return v || DEFAULT_MACHINE_KEY;
}

/**
 * Holt den Nayax-Roh-Export als CSV aus dem freigegebenen Google-Sheet (öffentlicher
 * CSV-Export, kein Login; folgt Redirects). `httpsImpl` injizierbar ⇒ Tests laufen
 * offline. Kein rohes pg ⇒ #107-Wächter-rein. Auch von der On-Demand-CLI genutzt.
 */
function fetchBackfillCsv(sheetId, { httpsImpl = https, timeoutMs = 10000 } = {}) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv`;
  return new Promise((resolve, reject) => {
    (function get(u, depth) {
      if (depth > 6) return reject(new Error('guv-backfill: zu viele Redirects beim Sheet-Abruf'));
      const req = httpsImpl.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); get(r.headers.location, depth + 1); return; }
        if (r.statusCode !== 200) { r.resume(); return reject(new Error(`guv-backfill: Sheet-Abruf HTTP ${r.statusCode}`)); }
        let d = ''; r.setEncoding('utf8'); r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('guv-backfill: Timeout beim Sheet-Abruf')); });
      req.on('error', reject);
    })(url, 0);
  });
}

// ── Job-Factory für den Worker (analog createGuvAggregateJob) ─────────────────
/**
 * Wiederkehrender GuV-Backfill-Job: holt den Nayax-Roh-Export EINMAL pro Lauf und
 * füllt je Mandant durch die Tür fehlende guv_daily-Posten (idempotent,
 * source='guv_backfill'). Erkennt GuV-Lücken automatisch (Dedup gegen vorhandene
 * Keys) und füllt sie, wenn Nayax keine/unvollständige Zahlen lieferte.
 *
 * Unfüllbare Verkäufe (noMap = kein Produkt-Mapping, noEK = kein Einkaufspreis)
 * werden als kompakte Lauf-TELEMETRIE im Rückgabewert + als WARNUNG (logger)
 * gemeldet — bewusst KEINE Pflege-Tabelle (User-Vorgabe). Die Lauf-Telemetrie
 * (Start/Ende/Status) landet wie bei den anderen Jobs in audit.workflow_runs
 * (der Worker umschließt run() mit dem Recorder).
 *
 * @param {object} deps
 * @param {{runForAll:Function, listTenants?:Function}} deps.tenantRunner  Per-Mandant-Runner (#160).
 * @param {() => Promise<string>} [deps.fetchSource]  Liefert den CSV-Text. Default:
 *        Google-Sheet-CSV via resolveSheetId(env). Tests injizieren Fixture-CSV
 *        (kein Netz). Stufe 6: pro-Mandant-Quelle (Credential-/Config-Vault).
 * @param {object} [deps.env]
 * @param {(...a:any[])=>void} [deps.logger]  Warnungs-Logger für unfüllbare Lücken.
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createGuvBackfillJob({ tenantRunner, fetchSource, env = process.env, logger } = {}) {
  if (!tenantRunner || typeof tenantRunner.runForAll !== 'function') {
    throw new TypeError('guv-backfill: tenantRunner mit runForAll() erforderlich');
  }
  const log = typeof logger === 'function' ? logger : () => {};
  const machineKey = resolveMachineKey(env);
  const sheetId = resolveSheetId(env);
  // Quelle injizierbar (Tests/Stufe-6-per-Mandant); Default = freigegebenes Sheet.
  const source = typeof fetchSource === 'function' ? fetchSource : () => fetchBackfillCsv(sheetId);

  return {
    key: WORKFLOW_KEY,
    run: async () => {
      // Fail-closed + sparsam: ohne Mandanten in der Registry NICHTS tun (und nicht
      // unnötig das externe Sheet abrufen).
      const known = typeof tenantRunner.listTenants === 'function' ? tenantRunner.listTenants() : null;
      if (Array.isArray(known) && known.length === 0) {
        return { skipped: 'keine Mandanten in der Registry', tenants: 0, inserted: 0 };
      }

      // EINMAL holen, über alle Mandanten teilen (heute ein globaler Export; Stufe 6:
      // pro-Mandant-Quelle ⇒ fetchSource bekommt dann den Mandanten).
      const csvText = await source();

      const res = await tenantRunner.runForAll(
        (db, tenant) => runGuvBackfillForTenant(db, tenant, { csvText, machineKey }),
        { continueOnError: true });

      const perTenant = res.perTenant || {};
      const sum = (field) => Object.values(perTenant).reduce((s, r) => s + ((r && r[field]) || 0), 0);
      const inserted = sum('inserted');
      const conflictSkipped = sum('conflictSkipped');
      const noMap = sum('noMap');
      const noEK = sum('noEK');

      // Unfüllbares als TELEMETRIE/WARNUNG bündeln — beschränkte Stichprobe je Mandant
      // (keine unbegrenzten Arrays in der Telemetrie). Die schweren `unresolved`/`rows`-
      // Felder NICHT in perTenant zurückgeben (kompakte Lauf-Telemetrie).
      const unfillable = [];
      const perTenantSummary = {};
      for (const [tenant, r] of Object.entries(perTenant)) {
        if (!r) { perTenantSummary[tenant] = r; continue; }
        const { unresolved, rows, ...rest } = r; // unresolved-Arrays + dryRun-rows abstreifen
        perTenantSummary[tenant] = rest;
        const u = unresolved || {};
        const noMapSamples = (u.noMap || []).slice(0, 10).map((s) => ({ name: s.name, mdb: s.mdb, date: s.date }));
        const noEKSamples = (u.noEK || []).slice(0, 10).map((s) => ({ product_key: s.product_key, date: s.date }));
        if (noMapSamples.length || noEKSamples.length) {
          unfillable.push({ tenant, noMap: (u.noMap || []).length, noEK: (u.noEK || []).length, noMapSamples, noEKSamples });
        }
      }
      if (noMap + noEK > 0) {
        log(`guv-backfill: ${noMap} unmappbare + ${noEK} ohne-EK Verkäufe (NICHT gefüllt) über ${res.tenants.length} Mandant(en) — siehe unfillable`);
      }

      return { tenants: res.tenants.length, inserted, conflictSkipped, noMap, noEK, unfillable, errors: res.errors, perTenant: perTenantSummary };
    },
  };
}

module.exports = {
  parseNayaxExportCsv, parseGermanDate, buildComputeInputs,
  loadBackfillMaps, loadExistingKeys, runGuvBackfillForTenant,
  createGuvBackfillJob, fetchBackfillCsv, resolveSheetId, resolveMachineKey,
  BACKFILL_SOURCE, WORKFLOW_KEY, DEFAULT_SHEET_ID, DEFAULT_MACHINE_KEY, INFO_RE,
};
