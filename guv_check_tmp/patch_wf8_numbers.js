/**
 * WF8-Patch: Numerische Felder als echte Zahlen statt Strings schreiben.
 *
 * Problem:
 *   fmt(n, 2) → n.toFixed(2) → String "4.00"
 *   Google Sheets (USER_ENTERED, deutsches Locale) interpretiert "4.00"
 *   als Datum (Punkt = Tausendertrenner → 4 = 4. Januar 1900).
 *
 * Fix:
 *   fmt() entfernt. Stattdessen r2()/r4() die echte JS-Zahlen liefern.
 *   Google Sheets schreibt dann numberValue statt stringValue → kein Datum.
 *
 * Nach dem Patch:
 *   1. GuV_Tagesposten im Google Sheet leeren (Zeilen 2–Ende löschen, Header lassen).
 *   2. WF8 einmal manuell ausführen → alle Daten werden neu mit korrekten Zahlen geschrieben.
 */
const http = require('http');
const fs   = require('fs');

const WF8_ID = 'qwpQMhZqDAIs8Wi9';
const API_KEY = JSON.parse(
  fs.readFileSync('C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/.dashboard-config.json', 'utf8')
).n8nApiKey;

function apiReq(method, path, body) {
  return new Promise((res, rej) => {
    const bs = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: 5678, path, method,
      headers: {
        'X-N8N-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        ...(bs ? { 'Content-Length': Buffer.byteLength(bs) } : {}),
      },
    };
    const r = http.request(opts, x => {
      let d = '';
      x.on('data', c => d += c);
      x.on('end', () => {
        if (x.statusCode < 300) res(JSON.parse(d));
        else rej(new Error('HTTP ' + x.statusCode + ': ' + d.substring(0, 500)));
      });
    });
    r.on('error', rej);
    if (bs) r.write(bs);
    r.end();
  });
}

// ── Neuer JS-Code für den Code-Node ──────────────────────────────────────────
const NEW_JS_CODE = `const transactions = $items('Read - Verarbeitete_Transaktionen').map(i => i.json);
const batches      = $items('Read - Lagerchargen').map(i => i.json);
const products     = $items('Read - Produkte').map(i => i.json);
const config       = $items('Read - GuV_Konfiguration').map(i => i.json)[0] || {};
const existingGuV  = $items('Read - GuV_Tagesposten (vorhanden)').map(i => i.json);

function clean(v) { return String(v == null ? '' : v).trim(); }
function num(v)   { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function r2(n)    { return Number.isFinite(n) ? Math.round(n * 100)   / 100   : 0; }
function r4(n)    { return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0; }

const kleinunternehmerAktiv = clean(config.kleinunternehmer_aktiv).toUpperCase() === 'TRUE';
const mwstSnack    = num(config.mwst_snack)    || 7;
const mwstGetraenk = num(config.mwst_getraenk) || 19;

function mwstVonProduktart(art) {
  const a = clean(art).toLowerCase();
  if (a === 'snack' || a.includes('snack') || a === 'riegel') return mwstSnack;
  if (a === 'getraenk' || a.includes('getraenk') || a.includes('drink')) return mwstGetraenk;
  return mwstGetraenk;
}

const batchMap = new Map();
for (const b of batches) {
  const id = clean(b.batch_id);
  if (id) batchMap.set(id, b);
}

const productMap = new Map();
for (const p of products) {
  const k = clean(p.product_key);
  if (k) productMap.set(k, p);
}

function aggKey(date, machineId, productKey) { return date + '|' + machineId + '|' + productKey; }
const existingKeys = new Set();
for (const r of existingGuV) {
  const d = clean(r.date), m = clean(r.machine_id), p = clean(r.product_key);
  if (d && m && p) existingKeys.add(aggKey(d, m, p));
}

function deriveDate(tx) {
  const ts = clean(tx.settlement_datetime_gmt || tx.sale_date || tx.timestamp || tx.processed_at);
  if (!ts) return '';
  const m = ts.match(/^(\\d{4}-\\d{2}-\\d{2})/);
  if (!m) return '';
  if (m[1].startsWith('2001-')) return ''; // Sentinel-Wert
  return m[1];
}

const aggregates = new Map();
let skippedStatus = 0, skippedNoPrice = 0, skippedExisting = 0, skippedInvalid = 0, processed = 0;

for (const tx of transactions) {
  const status = clean(tx.status).toUpperCase();
  if (status && status !== 'OK') { skippedStatus++; continue; }

  const date      = deriveDate(tx);
  const machineId  = clean(tx.machine_id);
  const productKey = clean(tx.product_key);
  if (!date || !machineId || !productKey) { skippedInvalid++; continue; }

  const vkBrutto = num(tx.vk_preis_brutto);
  if (vkBrutto <= 0) { skippedNoPrice++; continue; }

  const key = aggKey(date, machineId, productKey);
  if (existingKeys.has(key)) { skippedExisting++; continue; }

  const qty      = num(tx.quantity || tx.qty || 1) || 1;
  const umsatzBr = num(tx.umsatz_brutto) > 0 ? num(tx.umsatz_brutto) : qty * vkBrutto;

  const batchIds = clean(tx.batch_id_abgebucht).split(',').map(s => s.trim()).filter(Boolean);
  let ekBrutto = 0;
  let mwstEinkauf = 0;
  if (batchIds.length > 0) {
    const firstBatch = batchMap.get(batchIds[0]);
    if (firstBatch) {
      ekBrutto    = num(firstBatch.unit_cost);
      mwstEinkauf = num(firstBatch.mwst_satz);
    }
  }

  const product    = productMap.get(productKey) || {};
  const produktart = clean(product.produktart);
  if (!mwstEinkauf || mwstEinkauf <= 0) mwstEinkauf = mwstVonProduktart(produktart);

  const ekNetto  = mwstEinkauf > 0 ? ekBrutto / (1 + mwstEinkauf / 100) : ekBrutto;
  const warenein = qty * ekBrutto;

  if (!aggregates.has(key)) {
    aggregates.set(key, {
      date, machine_id: machineId, product_key: productKey,
      mdb_code: clean(tx.mdb_code_extracted || tx.mdb_code),
      product_slot_id: clean(tx.product_slot_id),
      nayax_product_name: clean(tx.nayax_product_name || tx.product_name),
      produktart,
      qty_sum: 0, umsatz_sum: 0, warenein_sum: 0,
      vk_weighted: 0, ek_brutto_weighted: 0, ek_netto_weighted: 0, mwst_weighted: 0,
      batch_missing: false,
    });
  }
  const a = aggregates.get(key);
  a.qty_sum            += qty;
  a.umsatz_sum         += umsatzBr;
  a.warenein_sum       += warenein;
  a.vk_weighted        += vkBrutto * qty;
  a.ek_brutto_weighted += ekBrutto * qty;
  a.ek_netto_weighted  += ekNetto  * qty;
  a.mwst_weighted      += mwstEinkauf * qty;
  if (batchIds.length === 0 || ekBrutto === 0) a.batch_missing = true;
  processed++;
}

const now = new Date().toISOString();
const out = [];
for (const a of aggregates.values()) {
  const q = a.qty_sum || 1;
  out.push({
    json: {
      date:                  a.date,
      machine_id:            a.machine_id,
      mdb_code:              a.mdb_code,
      product_slot_id:       a.product_slot_id,
      product_key:           a.product_key,
      nayax_product_name:    a.nayax_product_name,
      produktart:            a.produktart,
      quantity_sold:         a.qty_sum,
      vk_preis_brutto:       r4(a.vk_weighted / q),
      umsatz_brutto:         r2(a.umsatz_sum),
      ek_preis_netto:        r4(a.ek_netto_weighted / q),
      mwst_satz_einkauf:     r2(a.mwst_weighted / q),
      ek_preis_brutto:       r4(a.ek_brutto_weighted / q),
      wareneinsatz_brutto:   r2(a.warenein_sum),
      guv:                   r2(a.umsatz_sum - a.warenein_sum),
      kleinunternehmer_aktiv: kleinunternehmerAktiv ? 'TRUE' : 'FALSE',
      aggregiert_am:         now + (a.batch_missing ? ' [EK-Daten fehlen]' : ''),
    }
  });
}

if (out.length === 0) {
  return [{ json: { _info: 'Keine neuen Aggregationen', processed, skippedStatus, skippedNoPrice, skippedExisting, skippedInvalid, _empty: true } }];
}
return out;`;

// ── Patch ausführen ───────────────────────────────────────────────────────────
(async () => {
  console.log('Lade WF8 (' + WF8_ID + ')...');
  const wf = await apiReq('GET', '/api/v1/workflows/' + WF8_ID);

  const codeNode = wf.nodes.find(n => n.name === 'Code - GuV aggregieren');
  if (!codeNode) throw new Error('Code-Node "Code - GuV aggregieren" nicht gefunden');

  codeNode.parameters.jsCode = NEW_JS_CODE;
  console.log('  ✓ Code-Node aktualisiert (' + NEW_JS_CODE.length + ' Zeichen)');

  // Credentials sicherstellen
  wf.nodes.forEach(n => {
    if (n.type === 'n8n-nodes-base.googleSheets' && !n.credentials) {
      n.credentials = { googleSheetsOAuth2Api: { id: '5XfHt3SzjHCj8B5H', name: 'Sheets Automatenlager' } };
    }
  });

  console.log('Speichere WF8...');
  await apiReq('PUT', '/api/v1/workflows/' + WF8_ID, {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: {},
    staticData: wf.staticData || null,
  });
  console.log('  ✓ WF8 gespeichert');

  const v = await apiReq('GET', '/api/v1/workflows/' + WF8_ID);
  const code = v.nodes.find(n => n.name === 'Code - GuV aggregieren').parameters.jsCode;
  console.log('\n[Verify]');
  console.log('  r2() statt fmt() vorhanden:', code.includes('function r2(n)'));
  console.log('  fmt() entfernt:             ', !code.includes('function fmt('));
  console.log('  guv: r2(...)  vorhanden:    ', code.includes('guv:                   r2('));

  console.log('\n✅ Patch erfolgreich. Nächste Schritte:');
  console.log('   1. Google Sheet → GuV_Tagesposten → Zeilen 2 bis Ende löschen (Header behalten)');
  console.log('   2. WF8 in n8n manuell ausführen → Daten werden mit korrekten Zahlen neu geschrieben');
})().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
