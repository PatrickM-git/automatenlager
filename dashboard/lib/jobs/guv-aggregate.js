'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Job: GuV-Tagesposten-Aggregator — Issue #161 (Stufe 6, Slice 1). Ersetzt WF8.
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Pro-Workflow-Disposition"
//
// FAITHFUL PORT von WF8 ("Code - GuV aggregieren" + "Prepare PGW - guv_daily" +
// dem pgw_write('guv_daily')-Zweig). Verifiziert gegen die ECHTEN WF8-JSON-Nodes
// UND den realen DB-Dump (docs/data-model/wf8-guv-port-preflight.md), NICHT gegen
// Doku-Annahmen. Das Sicherheitsnetz ist der Schatten-Harness (#160): die hier
// berechneten guv_daily-Zeilen MÜSSEN exakt WF8s gespeicherten Zeilen entsprechen,
// bevor WF8 deaktiviert wird (Kunden-P&L).
//
// WICHTIGE FAITHFULNESS-BEFUNDE (bewusst 1:1 nachgebaut, NICHT "korrigiert"):
//   * WF8s Konfig-SQL liest `cfg->>'kleinunternehmer_aktiv'` (snake_case); der
//     gespeicherte Schlüssel ist aber `kleinunternehmerAktiv` (camelCase) ⇒ WF8
//     sieht IMMER den COALESCE-Default 'FALSE'. Wir replizieren das exakt (sonst
//     bricht der Schatten-Match + ändert die Kunden-P&L). Die Live-Dashboard-
//     Ökonomie liest dagegen camelCase=true → bestehende Live/Nacht-Divergenz,
//     als separater Befund dokumentiert (kein stiller Fix in diesem Port).
//   * Der EINKAUFS-MwSt-Fallback (mwstVonProduktart) und die VERKAUFS-MwSt
//     (revenue_net) sind ZWEI verschiedene Ableitungen — beide wörtlich portiert.
//   * Zwischen-Rundung zählt: gross_profit = r2(Σumsatz − Σwarenein), NICHT
//     r2(Σumsatz) − r2(Σwarenein); revenue_net rechnet mit dem bereits gerundeten
//     revenue_gross.
//
// Datenzugriff: PER MANDANT DURCH DIE TÜR (lib/tenant-db.js). Reads RLS-/$1-gefiltert
// (Vorbild lib/alert-digest.js), Write als `db.tx` (Resolve machine_key→machine_id /
// product_key→product_id + Insert atomar), idempotent `ON CONFLICT (guv_key) DO
// NOTHING`. KEIN rohes pg ⇒ #107-Wächter-rein (Worker injiziert die Tür).
// ─────────────────────────────────────────────────────────────────────────────

const WORKFLOW_KEY = 'wf-guv-aggregate';
// Faithful: dieselbe `source`-Markierung wie WF8 (sonst kein Schatten-Match und
// die Live-Ökonomie unterscheidet historic_backfill nicht mehr von der Aggregation).
const SOURCE = 'wf8_guv_aggregator';

// ── Reine Helfer (wörtlich aus dem WF8-Code-Node) ────────────────────────────
function clean(v) { return String(v == null ? '' : v).trim(); }
function num(v) { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function r2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }

/**
 * Konfig wie WF8s "Read - GuV_Konfiguration"-SQL: snake_case-Schlüssel mit
 * COALESCE-Defaults. `config` ist der rohe JSONB-Wert (classification_settings
 * __default__) — die SQL las einzelne `cfg->>'…'`, wir tun dasselbe in JS.
 */
function parseConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const get = (k, dflt) => {
    const v = cfg[k];
    return v == null || v === '' ? dflt : v;
  };
  return {
    // FAITHFUL: snake_case — der camelCase-Wert wird (wie in WF8) NICHT gesehen.
    kleinunternehmerAktiv: clean(get('kleinunternehmer_aktiv', 'FALSE')).toUpperCase() === 'TRUE',
    mwstSnack: num(get('mwst_snack', '7')) || 7,
    mwstGetraenk: num(get('mwst_getraenk', '19')) || 19,
  };
}

// EINKAUFS-MwSt-Fallback (Code-Node) — nur relevant, wenn die Charge keine MwSt
// trägt; bei Kleinunternehmer=false ohnehin ohne Effekt auf guv_daily.
function mwstVonProduktart(art, mwstSnack, mwstGetraenk) {
  const a = clean(art).toLowerCase();
  if (a === 'snack' || a.includes('snack') || a === 'riegel') return mwstSnack;
  if (a === 'getraenk' || a.includes('getraenk') || a.includes('drink')) return mwstGetraenk;
  return mwstGetraenk;
}

function deriveDate(tx) {
  const ts = clean(tx.settlement_datetime_gmt || tx.sale_date || tx.timestamp || tx.processed_at);
  if (!ts) return '';
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return '';
  if (m[1].startsWith('2001-')) return ''; // Sentinel-Wert (faithful)
  return m[1];
}

function aggKey(date, machineId, productKey) { return date + '|' + machineId + '|' + productKey; }

/**
 * REINER Aggregations-Kern. Faithful zu "Code - GuV aggregieren" + "Prepare PGW -
 * guv_daily" zusammengeführt: liefert direkt die guv_daily-Payload-Zeilen.
 *
 * @param {object} input
 * @param {object[]} input.transactions  Read - Verarbeitete_Transaktionen
 * @param {object[]} input.batches       Read - Lagerchargen
 * @param {object[]} input.products      Read - Produkte
 * @param {object}   input.config        roher classification_settings.__default__-config
 * @param {object[]} input.existingKeys  Read - GuV_Tagesposten (vorhanden) [{date,machine_id,product_key}]
 * @param {boolean}  [input.skipExisting=true]  Produktionspfad überspringt vorhandene
 *        Keys (faithful); der Schattenpfad rechnet ALLE (zum Vergleich gegen WF8).
 * @returns {{rows:object[], stats:object}}  rows = guv_daily-Payload je Aggregat.
 */
function computeGuvRows({ transactions = [], batches = [], products = [], config = {}, existingKeys = [], skipExisting = true } = {}) {
  const { kleinunternehmerAktiv, mwstSnack, mwstGetraenk } = parseConfig(config);

  const batchMap = new Map();
  for (const b of batches) { const id = clean(b.batch_id); if (id) batchMap.set(id, b); }

  // productMap: keyed by product_key, LAST-wins in Eingabereihenfolge (faithful —
  // die Read-Produkte-Query liefert ihre ORDER BY-Reihenfolge, wir bewahren sie).
  const productMap = new Map();
  for (const p of products) { const k = clean(p.product_key); if (k) productMap.set(k, p); }

  const existingSet = new Set();
  for (const r of existingKeys) {
    const d = clean(r.date), m = clean(r.machine_id), p = clean(r.product_key);
    if (d && m && p) existingSet.add(aggKey(d, m, p));
  }

  const aggregates = new Map();
  const stats = { processed: 0, skippedStatus: 0, skippedNoPrice: 0, skippedExisting: 0, skippedInvalid: 0 };

  for (const tx of transactions) {
    const status = clean(tx.status).toUpperCase();
    if (status && status !== 'OK') { stats.skippedStatus++; continue; }

    const date = deriveDate(tx);
    const machineId = clean(tx.machine_id);
    const productKey = clean(tx.product_key);
    if (!date || !machineId || !productKey) { stats.skippedInvalid++; continue; }

    const vkBrutto = num(tx.vk_preis_brutto) || num((productMap.get(productKey) || {}).sale_price_eur);
    const qty = num(tx.quantity || tx.qty || 1) || 1;
    const umsatzBr = num(tx.umsatz_brutto) > 0 ? num(tx.umsatz_brutto) : qty * vkBrutto;
    if (vkBrutto <= 0 && umsatzBr <= 0) { stats.skippedNoPrice++; continue; }

    const key = aggKey(date, machineId, productKey);
    if (skipExisting && existingSet.has(key)) { stats.skippedExisting++; continue; }

    const batchIds = clean(tx.batch_id_abgebucht).split(',').map((s) => s.trim()).filter(Boolean);
    let ekNetto = 0;
    let mwstEinkauf = 0;
    if (batchIds.length > 0) {
      const firstBatch = batchMap.get(batchIds[0]);
      if (firstBatch) { ekNetto = num(firstBatch.unit_cost); mwstEinkauf = num(firstBatch.mwst_satz); }
    }

    const product = productMap.get(productKey) || {};
    const produktart = clean(product.produktart);
    if (!mwstEinkauf || mwstEinkauf <= 0) mwstEinkauf = mwstVonProduktart(produktart, mwstSnack, mwstGetraenk);

    const ekBrutto = mwstEinkauf > 0 ? ekNetto * (1 + mwstEinkauf / 100) : ekNetto;
    const warenein = qty * ((kleinunternehmerAktiv && mwstEinkauf > 0) ? ekBrutto : ekNetto);

    if (!aggregates.has(key)) {
      aggregates.set(key, {
        date, machine_id: machineId, product_key: productKey,
        mdb_code: clean(tx.mdb_code_extracted || tx.mdb_code),
        produktart,
        qty_sum: 0, umsatz_sum: 0, warenein_sum: 0,
      });
    }
    const a = aggregates.get(key);
    a.qty_sum += qty;
    a.umsatz_sum += umsatzBr;
    a.warenein_sum += warenein;
    stats.processed++;
  }

  // Prepare-PGW-Mapping → guv_daily-Payload (faithful, inkl. Zwischen-Rundung).
  const rows = [];
  for (const a of aggregates.values()) {
    const umsatzBrutto = r2(a.umsatz_sum);
    const wareneinsatzBrutto = r2(a.warenein_sum);
    const guv = r2(a.umsatz_sum - a.warenein_sum);
    const art = clean(a.produktart).toLowerCase();
    const vatRate = kleinunternehmerAktiv ? 0
      : (art === 'snack' || art.includes('snack') || art === 'riegel' ? 7 : 19);
    const revenueNet = vatRate === 0 ? umsatzBrutto : Math.round(umsatzBrutto / (1 + vatRate / 100) * 100) / 100;
    rows.push({
      guv_key: aggKey(a.date, a.machine_id, a.product_key),
      posting_date: a.date,
      machine_key: String(a.machine_id),
      mdb_code: a.mdb_code || null, // faithful: '' → null (pgw_write castet ::INTEGER)
      product_key: a.product_key,
      quantity_sold: a.qty_sum,
      revenue_gross: umsatzBrutto,
      revenue_net: revenueNet,
      cost_of_goods: wareneinsatzBrutto,
      gross_profit: guv,
      source: SOURCE,
    });
  }
  return { rows, stats };
}

// ── Reads durch die Tür (per Mandant) ────────────────────────────────────────
// Faithful zu WF8s 5 Read-Nodes, aber tenant-gefiltert (WHERE x.tenant_id = $1,
// mandanten-treue Joins) — Vorbild alert-digest. RLS filtert zusätzlich.
async function readGuvInputs(db, tenant) {
  // SEQUENZIELL (kein Promise.all): db.read holt je Aufruf einen eigenen Client/
  // Transaktion; nacheinander hält den Worker-Pool (max 4) frei UND macht denselben
  // Code im #94-Sandbox (EIN Client) live testbar. Latenz ist bei 15-min-Kadenz egal.
  const reads = [
    // 1) Verarbeitete Transaktionen (120-Tage-Fenster), inkl. LATERAL-Preis + erste Charge.
    () => db.read({
      tenant,
      tables: ['sales_transactions', 'machines', 'products', 'slot_assignments', 'prices', 'stock_batches'],
      params: [],
      text:
        `SELECT
           to_char(st.settlement_at,'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS settlement_datetime_gmt,
           m.machine_key AS machine_id,
           COALESCE(p.product_key,'') AS product_key,
           COALESCE(st.mdb_code::text,'') AS mdb_code_extracted,
           COALESCE(st.mdb_code::text,'') AS mdb_code,
           st.quantity,
           st.gross_amount AS umsatz_brutto,
           COALESCE(pr.sale_price_gross::text,'') AS vk_preis_brutto,
           COALESCE(st.processing_status,'OK') AS status,
           COALESCE(ek.batch_key,'') AS batch_id_abgebucht
         FROM automatenlager.sales_transactions st
         JOIN automatenlager.machines m ON m.machine_id = st.machine_id AND m.tenant_id = st.tenant_id
         LEFT JOIN automatenlager.products p ON p.product_id = st.product_id AND p.tenant_id = st.tenant_id
         LEFT JOIN automatenlager.slot_assignments sa ON sa.slot_assignment_id = st.slot_assignment_id AND sa.tenant_id = st.tenant_id
         LEFT JOIN LATERAL (
           SELECT pc2.sale_price_gross FROM automatenlager.prices pc2
           WHERE pc2.slot_assignment_id = st.slot_assignment_id AND pc2.tenant_id = st.tenant_id AND pc2.valid_to IS NULL
           ORDER BY pc2.valid_from DESC LIMIT 1
         ) pr ON TRUE
         LEFT JOIN LATERAL (
           SELECT sb.batch_key FROM automatenlager.stock_batches sb
           WHERE sb.product_id = st.product_id AND sb.tenant_id = st.tenant_id
             AND sb.received_at <= st.settlement_at::date
             AND sb.status IN ('aktiv','active','reserve','leer')
           ORDER BY sb.received_at ASC, sb.batch_id ASC LIMIT 1
         ) ek ON TRUE
         WHERE st.tenant_id = $1
           AND st.settlement_at > NOW() - INTERVAL '120 days'
         ORDER BY st.settlement_at ASC` }),
    // 2) Lagerchargen (für ek_netto/mwst je erster Charge).
    () => db.read({
      tenant,
      tables: ['stock_batches', 'products'],
      params: [],
      text:
        `SELECT sb.batch_key AS batch_id,
                COALESCE(sb.unit_cost_net::text,'') AS unit_cost,
                COALESCE(p.vat_rate_pct::text,'') AS mwst_satz
         FROM automatenlager.stock_batches sb
         JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
         WHERE sb.tenant_id = $1 AND sb.status IN ('aktiv','active','reserve')
         ORDER BY p.name, sb.mhd_date ASC NULLS LAST` }),
    // 3) Produkte (productMap: product_key → {produktart, sale_price_eur}); ORDER BY
    //    EXAKT wie WF8 (last-wins-Determinismus der Map).
    () => db.read({
      tenant,
      tables: ['slot_assignments', 'products', 'machines', 'prices'],
      params: [],
      text:
        `SELECT p.product_key AS product_key,
                p.category AS produktart,
                COALESCE(pr.sale_price_gross::text,'') AS sale_price_eur
         FROM automatenlager.slot_assignments sa
         JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
         JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
         LEFT JOIN LATERAL (SELECT pc.sale_price_gross FROM automatenlager.prices pc WHERE pc.slot_assignment_id=sa.slot_assignment_id AND pc.tenant_id = sa.tenant_id AND pc.valid_to IS NULL ORDER BY pc.valid_from DESC LIMIT 1) pr ON TRUE
         WHERE sa.tenant_id = $1
         ORDER BY m.machine_key, sa.mdb_code, sa.active DESC` }),
    // 4) GuV-Konfiguration: globales __default__ (gilt für alle Mandanten); die
    //    Vereinigungs-Policy erlaubt __default__ trotz gesetztem Mandanten-GUC.
    //    tenant-gated via `$1::text IS NOT NULL` (Vorbild alert-digest).
    () => db.read({
      tenant,
      tables: ['classification_settings'],
      params: [],
      text:
        `SELECT COALESCE((SELECT config FROM automatenlager.classification_settings
                           WHERE mandant_id='__default__' AND $1::text IS NOT NULL),
                         '{}'::jsonb) AS config` }),
    // 5) Vorhandene GuV-Keys (90-Tage-Fenster) — Skip-Optimierung (faithful).
    () => db.read({
      tenant,
      tables: ['guv_daily', 'machines', 'products'],
      params: [],
      text:
        `SELECT to_char(gd.posting_date,'YYYY-MM-DD') AS date,
                m.machine_key AS machine_id,
                p.product_key AS product_key
         FROM automatenlager.guv_daily gd
         JOIN automatenlager.machines m ON m.machine_id = gd.machine_id AND m.tenant_id = gd.tenant_id
         JOIN automatenlager.products p ON p.product_id = gd.product_id AND p.tenant_id = gd.tenant_id
         WHERE gd.tenant_id = $1 AND gd.posting_date > CURRENT_DATE - INTERVAL '90 days'` }),
  ];
  const out = [];
  for (const run of reads) out.push(await run()); // sequenziell (s. o.)

  return {
    transactions: out[0].rows || [],
    batches: out[1].rows || [],
    products: out[2].rows || [],
    config: (out[3].rows[0] && out[3].rows[0].config) || {},
    existingKeys: out[4].rows || [],
  };
}

// ── Write durch die Tür (db.tx, per Mandant) ─────────────────────────────────
// Resolve machine_key→machine_id / product_key→product_id (faithful zu pgw_write,
// aber tenant-scoped) + Insert mit EXPLIZITEM tenant_id, ON CONFLICT (guv_key)
// DO NOTHING. Resolve + Insert in EINER Transaktion (atomar pro Mandant).
async function writeGuvRows(db, tenant, rows) {
  const result = { inserted: 0, conflictSkipped: 0, unresolved: 0, attempted: rows.length };
  if (!rows.length) return result;

  return db.tx(tenant, async (door) => {
    // SEQUENZIELL: db.tx läuft auf EINEM dedizierten Client; parallele Queries auf
    // einem pg-Client sind verboten ("already executing"). Auflösen vor dem Insert.
    const mRes = await door.read({ tables: ['machines'], text: `SELECT machine_key, machine_id FROM automatenlager.machines WHERE tenant_id = $1` });
    const pRes = await door.read({ tables: ['products'], text: `SELECT product_key, product_id FROM automatenlager.products WHERE tenant_id = $1` });
    const machineMap = new Map((mRes.rows || []).map((r) => [String(r.machine_key), r.machine_id]));
    const productMap = new Map((pRes.rows || []).map((r) => [String(r.product_key), r.product_id]));

    for (const row of rows) {
      const machineId = machineMap.get(String(row.machine_key));
      const productId = productMap.get(String(row.product_key));
      if (machineId == null || productId == null) {
        // Faithful zu pgw_write: nicht auflösbar ⇒ diese Zeile auslassen (n8n ruft
        // pgw_write je Item einzeln auf; ein Fehler bricht nicht den ganzen Lauf).
        result.unresolved++;
        continue;
      }
      const ins = await door.write({
        tables: ['guv_daily'],
        text:
          `INSERT INTO automatenlager.guv_daily
             (tenant_id, guv_key, posting_date, machine_id, mdb_code, product_id,
              quantity_sold, revenue_gross, revenue_net, cost_of_goods, gross_profit, source)
           VALUES ($1, $2, $3::date, $4::bigint, $5::integer, $6::bigint,
                   $7::integer, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12)
           ON CONFLICT (guv_key) DO NOTHING`,
        params: [row.guv_key, row.posting_date, machineId, row.mdb_code, productId,
          row.quantity_sold, row.revenue_gross, row.revenue_net, row.cost_of_goods, row.gross_profit, row.source],
      });
      const n = ins && typeof ins.rowCount === 'number' ? ins.rowCount : 0;
      if (n > 0) result.inserted += n; else result.conflictSkipped++;
    }
    return result;
  });
}

// ── Per-Mandant-Job (für den tenant-runner) ──────────────────────────────────
async function runGuvAggregateForTenant(db, tenant, _opts = {}) {
  const inputs = await readGuvInputs(db, tenant);
  const { rows, stats } = computeGuvRows({ ...inputs, skipExisting: true });
  const writeRes = await writeGuvRows(db, tenant, rows);
  return { tenant, computed: rows.length, stats, ...writeRes };
}

// ── Schatten-Sicherheitsnetz (rechnet, schreibt NIE) ─────────────────────────
// computeShadowIntended: ALLE Aggregate (skipExisting:false), damit gegen WF8s
// gespeicherte Zeilen verglichen werden kann. readActualWf8Guv: die echten,
// von WF8 geschriebenen guv_daily-Zeilen (source='wf8_guv_aggregator') derselben
// Tage. Beide auf eine vergleichbare, normalisierte Form gebracht.
function normalizeGuvForCompare(row) {
  return {
    guv_key: String(row.guv_key),
    quantity_sold: Number(row.quantity_sold),
    revenue_gross: r2(Number(row.revenue_gross)),
    revenue_net: r2(Number(row.revenue_net)),
    cost_of_goods: r2(Number(row.cost_of_goods)),
    gross_profit: r2(Number(row.gross_profit)),
  };
}

async function computeShadowIntended(db, tenant) {
  const inputs = await readGuvInputs(db, tenant);
  const { rows } = computeGuvRows({ ...inputs, skipExisting: false });
  return rows.map(normalizeGuvForCompare);
}

// Liest WF8s tatsächliche guv_daily-Zeilen (nur source='wf8_guv_aggregator') der
// letzten `days` Tage, in vergleichbarer Form. So vergleicht der Schatten-Harness
// Äpfel mit Äpfeln (historic_backfill/sheets_seed bleiben außen vor).
async function readActualWf8Guv(db, tenant, { days = 120 } = {}) {
  const res = await db.read({
    tenant,
    tables: ['guv_daily'],
    params: [String(days)],
    text:
      `SELECT gd.guv_key, gd.quantity_sold, gd.revenue_gross, gd.revenue_net,
              gd.cost_of_goods, gd.gross_profit
         FROM automatenlager.guv_daily gd
        WHERE gd.tenant_id = $1
          AND gd.source = 'wf8_guv_aggregator'
          AND gd.posting_date > CURRENT_DATE - ($2 || ' days')::interval`,
  });
  return (res.rows || []).map(normalizeGuvForCompare);
}

// ── Job-Factory für den Worker ───────────────────────────────────────────────
/**
 * @param {object} deps
 * @param {{runForAll:Function}} deps.tenantRunner  Per-Mandant-Runner (#160).
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createGuvAggregateJob({ tenantRunner } = {}) {
  if (!tenantRunner || typeof tenantRunner.runForAll !== 'function') {
    throw new TypeError('guv-aggregate: tenantRunner mit runForAll() erforderlich');
  }
  return {
    key: WORKFLOW_KEY,
    run: async () => {
      // continueOnError: ein fehlschlagender Mandant darf die übrigen nicht stoppen.
      const res = await tenantRunner.runForAll(runGuvAggregateForTenant, { continueOnError: true });
      const inserted = Object.values(res.perTenant).reduce((s, r) => s + ((r && r.inserted) || 0), 0);
      return { tenants: res.tenants.length, inserted, errors: res.errors, perTenant: res.perTenant };
    },
  };
}

module.exports = {
  createGuvAggregateJob,
  runGuvAggregateForTenant,
  computeGuvRows,
  parseConfig,
  mwstVonProduktart,
  deriveDate,
  readGuvInputs,
  writeGuvRows,
  computeShadowIntended,
  readActualWf8Guv,
  normalizeGuvForCompare,
  WORKFLOW_KEY,
  SOURCE,
};
