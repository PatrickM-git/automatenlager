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
// ─────────────────────────────────────────────────────────────────────────────

const { computeGuvRows, writeGuvRows } = require('./guv-aggregate.js');

const BACKFILL_SOURCE = 'guv_backfill';
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
  return { ...summary, ...writeRes };
}

async function loadConfig(db, tenant) {
  const res = await db.read({
    tenant, tables: ['classification_settings'],
    text: `SELECT COALESCE((SELECT config FROM automatenlager.classification_settings WHERE mandant_id='__default__' AND $1::text IS NOT NULL), '{}'::jsonb) AS config`,
  });
  return (res.rows[0] && res.rows[0].config) || {};
}

module.exports = {
  parseNayaxExportCsv, parseGermanDate, buildComputeInputs,
  loadBackfillMaps, loadExistingKeys, runGuvBackfillForTenant,
  BACKFILL_SOURCE, INFO_RE,
};
