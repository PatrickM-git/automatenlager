'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SCHATTEN-/PARITÄTS-HARNESS für den WF8-GuV-Cutover (Issue #161, Stufe 6 Slice 1).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Testing Decisions"
//
// FINANZ-SICHERHEITSNETZ (PFLICHT vor `WF8 deaktivieren`): beweist, dass der Port
// `lib/jobs/guv-aggregate.js` algorithmisch IDENTISCH zu WF8 rechnet — gegen die
// ECHTE Mini-DB, nicht gegen Annahmen.
//
// WARUM PARITÄT (gleiche Inputs → gleiche Outputs) statt "Recompute vs. gespeichert":
// WF8s cost_of_goods hängt am Chargen-Schnappschuss (FIFO, status aktiv→leer). Der
// bewegt sich täglich, also weichen HEUTE neu berechnete Vergangenheitstage
// legitim von den DAMALS gespeicherten ab (Drift) — WF8 selbst überschreibt sie
// nie (ON CONFLICT DO NOTHING). Die drift-IMMUNE, rigorose Äquivalenz ist daher:
// WF8s WÖRTLICHER Node-Code und der Port, auf DENSELBEN aktuellen Read-Inputs,
// müssen Zeile für Zeile dasselbe liefern. Genau das prüft dieser Harness.
//
// READ-ONLY: führt nur die WF8-Read-SQLs aus und rechnet in-memory. KEINE Mutation.
// Exit 0 = byte-identisch (Cutover erlaubt); Exit 3 = Abweichung (NICHT deaktivieren).
//
// Nutzung:  node tools/shadow-guv-parity.js
// (liegt bewusst außerhalb lib/ — kein Mandanten-Datenpfad, nicht im Web-/Worker-Lauf)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const { resolvePgUrl } = require('../tests/helpers/migration-sandbox.js');
const guv = require('../lib/jobs/guv-aggregate.js');

const WF8_JSON = path.join(__dirname, '..', '..', 'WF8 - GuV Tagesposten Aggregator.json');

// Lädt WF8s Node-Code/SQL WÖRTLICH aus der exportierten Workflow-JSON (keine
// Abschrift → keine Transkriptionsfehler). Bricht hart, wenn ein Node fehlt.
function loadWf8() {
  const wf = JSON.parse(fs.readFileSync(WF8_JSON, 'utf8'));
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const need = (name, get) => { const n = byName[name]; if (!n) throw new Error(`WF8-Node fehlt: ${name}`); return get(n); };
  return {
    sqlTx: need('Read - Verarbeitete_Transaktionen', (n) => n.parameters.query),
    sqlBat: need('Read - Lagerchargen', (n) => n.parameters.query),
    sqlProd: need('Read - Produkte', (n) => n.parameters.query),
    sqlCfg: need('Read - GuV_Konfiguration', (n) => n.parameters.query),
    aggCode: need('Code - GuV aggregieren', (n) => n.parameters.jsCode),
    prepCode: need('Prepare PGW - guv_daily', (n) => n.parameters.jsCode),
  };
}

// SICHERHEIT/Trust-Grenze: `new Function(...)` führt hier WF8s WÖRTLICHEN Node-Code
// als Referenz-Orakel aus. Die Quelle ist die versionierte, repo-kontrollierte
// Workflow-JSON (kein Nutzer-Input, keine Interpolation fremder Strings in den
// Body). Dieses Tool ist read-only und liegt außerhalb des Web-/Worker-Laufs.
// Genau dieses 1:1-Ausführen IST der Zweck (drift-immune Paritätsprüfung).
//
// WF8s "Code - GuV aggregieren": die 5 $items(...)-Kopfzeilen durch injizierte
// Arrays ersetzen, Rest wörtlich ausführen.
function runWf8Aggregate(wf8, transactions, batches, products, config, existingGuV) {
  const body = wf8.aggCode.replace(/^[\s\S]*?const existingGuV[^\n]*\n/, '');
  // eslint-disable-next-line no-new-func
  const fn = new Function('transactions', 'batches', 'products', 'config', 'existingGuV', body);
  return fn(transactions, batches, products, config, existingGuV);
}
// WF8s "Prepare PGW - guv_daily": $input.all() → das Aggregat-Output-Array.
function runWf8Prepare(wf8, aggOut) {
  const body = wf8.prepCode.replace('return $input.all()', 'return ($input_all)');
  // eslint-disable-next-line no-new-func
  const fn = new Function('$input_all', body);
  return fn(aggOut);
}

const FIELDS = ['posting_date', 'machine_key', 'product_key', 'mdb_code', 'quantity_sold',
  'revenue_gross', 'revenue_net', 'cost_of_goods', 'gross_profit', 'source'];

function norm(r) {
  return {
    guv_key: String(r.guv_key),
    posting_date: String(r.posting_date),
    machine_key: String(r.machine_key),
    product_key: String(r.product_key),
    mdb_code: r.mdb_code == null ? null : Number(r.mdb_code),
    quantity_sold: Number(r.quantity_sold),
    revenue_gross: Number(r.revenue_gross),
    revenue_net: Number(r.revenue_net),
    cost_of_goods: Number(r.cost_of_goods),
    gross_profit: Number(r.gross_profit),
    source: String(r.source),
  };
}

async function main() {
  const url = resolvePgUrl();
  if (!url) { console.error('PARITY: kein DASHBOARD_V2_PG_URL — abgebrochen.'); process.exit(2); }
  let Client; try { ({ Client } = require('pg')); } catch { console.error('PARITY: pg fehlt.'); process.exit(2); }
  const wf8 = loadWf8();

  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  await c.connect();
  let transactions; let batches; let products; let config; let rawCfg;
  try {
    const who = await c.query('SELECT current_user, current_database()');
    console.log('PARITY current_user/db:', JSON.stringify(who.rows[0]));
    transactions = (await c.query(wf8.sqlTx)).rows;
    batches = (await c.query(wf8.sqlBat)).rows;
    products = (await c.query(wf8.sqlProd)).rows;
    config = (await c.query(wf8.sqlCfg)).rows[0] || {}; // WF8s flache snake-Konfig
    rawCfg = ((await c.query(
      `SELECT config FROM automatenlager.classification_settings WHERE mandant_id='__default__'`)).rows[0] || {}).config || {};
  } finally {
    await c.end();
  }

  // existingGuV=[] / skipExisting:false ⇒ BEIDE Seiten rechnen ALLE Keys → vergleichbar.
  const wf8Rows = runWf8Prepare(wf8, runWf8Aggregate(wf8, transactions, batches, products, config, [])).map((x) => x.json.data);
  const mine = guv.computeGuvRows({ transactions, batches, products, config: rawCfg, existingKeys: [], skipExisting: false }).rows;

  const wMap = new Map(wf8Rows.map((r) => [String(r.guv_key), norm(r)]));
  const mMap = new Map(mine.map((r) => [String(r.guv_key), norm(r)]));
  let matched = 0; let mism = 0; let onlyW = 0; let onlyM = 0; const bad = [];
  for (const [k, w] of wMap) {
    const m = mMap.get(k);
    if (!m) { onlyW++; continue; }
    const diff = FIELDS.filter((f) => !Object.is(w[f], m[f]));
    if (diff.length) { mism++; if (bad.length < 20) bad.push({ key: k, diff: diff.map((f) => `${f}: wf8=${w[f]} port=${m[f]}`) }); }
    else matched++;
  }
  for (const k of mMap.keys()) if (!wMap.has(k)) onlyM++;

  console.log(`\nWF8-Referenzzeilen=${wf8Rows.length}  Port-Zeilen=${mine.length}`);
  console.log(`PARITÄT (identische Inputs):  matched=${matched}  mismatched=${mism}  onlyWF8=${onlyW}  onlyPort=${onlyM}`);
  if (mism || onlyW || onlyM) {
    console.log('❌ ABWEICHUNG — WF8 NICHT deaktivieren:');
    console.log(JSON.stringify(bad, null, 2));
    process.exit(3);
  }
  console.log('✅ BYTE-IDENTISCH zu WF8 auf jedem Key — Cutover finanziell abgesichert.');
  process.exit(0);
}

main().catch((e) => { console.error('PARITY Fehler:', e.message); process.exit(1); });
