// guv_historic_backfill.js
// Historisches GuV-Backfill: Oct 2025 – May 10, 2026
//
// Quelle: _nayax_sales.json (alle Einträge Oct 2025 – Mai 10, 2026)
//   Datum < 2026-05-02: pre-cutover MDB-Map
//   Datum >= 2026-05-02: aktuelle MDB-Map (post-cutover)
//   Datum >= 2026-05-11: übersprungen (WF8 deckt ab hier ab)
// Dedup gegen vorhandene GuV_Tagesposten (date|machine_id|product_key)
//
// Aufruf:
//   node guv_historic_backfill.js --dry-run   (zeigt nur Vorschau, schreibt nichts)
//   node guv_historic_backfill.js              (schreibt wirklich)

const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');
const cfg = JSON.parse(fs.readFileSync('C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/.dashboard-config.json', 'utf8'));
const SHEET_ID = '12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo';
const MACHINE_ID = '457107528';
const CRED = { googleSheetsOAuth2Api: { id: '5XfHt3SzjHCj8B5H', name: 'Sheets Automatenlager' } };
const CUTOVER_DATE = '2026-05-02'; // Vor diesem Datum: pre-cutover MDB-Map; ab hier: aktuelle Map
const NAYAX_END_DATE = '2026-05-11'; // Nayax-Eintraege >= dieses Datum werden uebersprungen (WF8 laeuft ab hier)
const NAYAX_FILE = 'C:/Users/patri/Documents/mein-erstes-Projekt/guv_check_tmp/_nayax_sales.json';
const now = new Date().toISOString();

// ---------- Hilfsfunktionen ----------

function fetchCsv(sheetName) {
  return new Promise((res, rej) => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&cacheBust=${Date.now()}`;
    function doGet(u) {
      https.get(u, r => {
        if (r.statusCode >= 300 && r.statusCode < 400) { doGet(r.headers.location); return; }
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
      }).on('error', rej);
    }
    doGet(url);
  });
}

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
  if (!rows.length) return [];
  const h = rows[0];
  return rows.slice(1).filter(r => r.some(v => v)).map(r => {
    const o = {}; h.forEach((k, i) => o[k.trim()] = (r[i] ?? '').trim()); return o;
  });
}

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const num   = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };
const fmt   = (n, d) => isFinite(n) ? n.toFixed(d) : '0';

// "DD.MM.YYYY ..." → "YYYY-MM-DD"
function parseNayaxDate(dt) {
  const m = clean(dt).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

// Rohes Datum in verschiedenen Formaten → "YYYY-MM-DD"
function parseAnyDate(raw) {
  const s = clean(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\.\d{2}\.\d{4}/.test(s)) {
    const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  }
  return '';
}

// ---------- n8n API ----------

function apiReq(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: 5678, path, method,
      headers: {
        'X-N8N-API-KEY': cfg.n8nApiKey, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = http.request(opts, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode >= 400) rej(new Error(`HTTP ${r.statusCode}: ${d.slice(0, 300)}`));
        else try { res(JSON.parse(d)); } catch { res(d); }
      });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}

function httpGet(url) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port || 5678, path: u.pathname + u.search }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
    }).on('error', rej);
  });
}

async function appendRowsViaWorkflow(rows) {
  if (!rows.length) return 200;
  const wfPath = 'guv-backfill-' + crypto.randomBytes(4).toString('hex');
  const jsCode = `return ${JSON.stringify(rows.map(r => ({ json: r })))};`;
  const wf = {
    name: 'WF_TEMP_GUV_BACKFILL_' + now.slice(0, 10),
    nodes: [
      {
        id: 'h', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
        parameters: { httpMethod: 'GET', path: wfPath, responseMode: 'lastNode', options: {} },
        webhookId: crypto.randomUUID()
      },
      {
        id: 'c', name: 'Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0],
        parameters: { mode: 'runOnceForAllItems', jsCode }
      },
      {
        id: 'gs', name: 'Append', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [440, 0],
        parameters: {
          operation: 'append',
          documentId: { __rl: true, value: SHEET_ID, mode: 'id' },
          sheetName: { __rl: true, value: 'GuV_Tagesposten', mode: 'name' },
          columns: {
            mappingMode: 'autoMapInputData', value: {}, schema: [], matchingColumns: [],
            attemptToConvertTypes: false, convertFieldsToString: false
          },
          options: {}
        },
        credentials: CRED
      }
    ],
    connections: {
      Webhook: { main: [[{ node: 'Data', type: 'main', index: 0 }]] },
      Data:    { main: [[{ node: 'Append', type: 'main', index: 0 }]] }
    },
    settings: { executionOrder: 'v1' }
  };
  const created = await apiReq('POST', '/api/v1/workflows', wf);
  await apiReq('POST', `/api/v1/workflows/${created.id}/activate`);
  await new Promise(r => setTimeout(r, 800));
  const result = await httpGet(`http://127.0.0.1:5678/webhook/${wfPath}`);
  await new Promise(r => setTimeout(r, 3000));
  await apiReq('POST', `/api/v1/workflows/${created.id}/deactivate`);
  await apiReq('DELETE', `/api/v1/workflows/${created.id}`);
  return result.status;
}

// ---------- Regex fuer Nayax product_info ----------
// Formate: "Name(MDB  PRICE)" oder "Name(MDB = PRICE)"
const INFO_RE = /^(.+?)\((\d+)\s+(?:=\s+)?(\d+\.?\d*)\)$/;

// ---------- Hauptlogik ----------

(async () => {
  console.log(`=== GuV historisches Backfill ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);
  console.log('Lade Google Sheets...');

  const [lcRaw, prRaw, vtRaw, plRaw, aliasRaw, guvRaw] = await Promise.all([
    fetchCsv('Lagerchargen'),
    fetchCsv('Produkte'),
    fetchCsv('Verarbeitete_Transaktionen'),
    fetchCsv('Produktwechsel_Log'),
    fetchCsv('Produkt_Aliase'),
    fetchCsv('GuV_Tagesposten'),
  ]);

  const lc     = parseCsv(lcRaw);
  const pr     = parseCsv(prRaw);
  const vt     = parseCsv(vtRaw);
  const pl     = parseCsv(plRaw);
  const aliasList = parseCsv(aliasRaw);
  const guv    = parseCsv(guvRaw);

  console.log(`Lagerchargen: ${lc.length} | Produkte: ${pr.length} | VT: ${vt.length} | PL: ${pl.length} | Aliase: ${aliasList.length} | GuV vorhanden: ${guv.length}\n`);

  // 1. EK-Map: product_key → { unit_cost, mwst_satz }
  //    Verwende erste (aelteste) Charge pro Produkt als Referenz
  const ekMap   = new Map();
  const batchMap = new Map();
  for (const b of lc) {
    const key = clean(b.product_key);
    const bid = clean(b.batch_id);
    if (bid) batchMap.set(bid, b);
    if (key && !ekMap.has(key)) {
      ekMap.set(key, { unit_cost: num(b.unit_cost), mwst_satz: num(b.mwst_satz) });
    }
  }

  // 2. Produktart-Map
  const produktartMap = new Map();
  for (const p of pr) {
    const key = clean(p.product_key);
    if (key && !produktartMap.has(key)) produktartMap.set(key, clean(p.produktart || 'snack'));
  }

  // 3. Aktueller MDB-Map (post-cutover, active=TRUE)
  const mdbCurrentMap = new Map();
  for (const p of pr) {
    const mdb    = clean(p.mdb_code);
    const key    = clean(p.product_key);
    const active = clean(p.active || '').toUpperCase() === 'TRUE';
    if (mdb && key && active) mdbCurrentMap.set(mdb, key);
  }
  console.log('MDB-Belegung (aktuell):');
  for (const [mdb, key] of [...mdbCurrentMap].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  MDB ${String(mdb).padStart(2)}: ${key}`);
  }

  // 4. Pre-Cutover MDB-Map: starte von aktuell, mache Produktwechsel_Log rueckgaengig
  const mdbPreMap = new Map(mdbCurrentMap);
  console.log('\nProduktWechsel_Log:');
  for (const entry of pl) {
    const mdb    = clean(entry.mdb_code || entry.mdb || entry.slot || '');
    const oldKey = clean(entry.old_product_key || entry.alter_product_key || entry.previous_product_key || '');
    const newKey = clean(entry.new_product_key || entry.neuer_product_key || entry.current_product_key || '');
    const rawDate = clean(entry.change_date || entry.change_datetime || entry.wechseldatum || entry.datum || entry.date || '');
    const changeDate = parseAnyDate(rawDate) || rawDate;
    console.log(`  MDB ${String(mdb).padStart(2)}: ${oldKey || '?'} → ${newKey || '?'} (${changeDate || 'kein Datum'})`);
    if (mdb && oldKey && changeDate && changeDate <= CUTOVER_DATE) {
      mdbPreMap.set(mdb, oldKey);
    }
  }
  console.log('\nMDB-Belegung (pre-cutover):');
  for (const [mdb, key] of [...mdbPreMap].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const curr = mdbCurrentMap.get(mdb);
    if (curr !== key) console.log(`  MDB ${String(mdb).padStart(2)}: ${key}  (aktuell: ${curr || '-'})`);
  }

  // 5. Name→product_key Alias-Map
  const aliasMap = new Map();
  // Aus Produkt_Aliase
  for (const a of aliasList) {
    const normAlias = clean(a.normalized_alias || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rawAlias  = clean(a.alias_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = clean(a.product_key);
    if (key) {
      if (normAlias) aliasMap.set(normAlias, key);
      if (rawAlias && rawAlias !== normAlias) aliasMap.set(rawAlias, key);
    }
  }
  // Aus Produkte (internal_product_name)
  for (const p of pr) {
    const key  = clean(p.product_key);
    const name = clean(p.internal_product_name || p.product_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (name && key && !aliasMap.has(name)) aliasMap.set(name, key);
  }

  // 6. Dedup-Set aus bestehenden GuV_Tagesposten
  const existingKeys = new Set();
  for (const r of guv) {
    const d = clean(r.date), m = clean(r.machine_id), p = clean(r.product_key);
    if (d && m && p) existingKeys.add(`${d}|${m}|${p}`);
  }

  // ---------- Aggregation ----------
  const aggregates = new Map();
  const skipped = { noMap: 0, noEK: 0, dedup: 0, noDate: 0 };
  const samples = { noMap: [], noEK: [] };

  function record(date, machineId, mdbCode, productKey, nayaxName, qty, vkBrutto, ekBrutto, mwstEinkauf, produktart) {
    const aggKey = `${date}|${machineId}|${productKey}`;
    if (existingKeys.has(aggKey)) { skipped.dedup++; return; }
    const ekNetto = mwstEinkauf > 0 ? ekBrutto / (1 + mwstEinkauf / 100) : ekBrutto;
    if (!aggregates.has(aggKey)) {
      aggregates.set(aggKey, {
        date, machine_id: machineId, mdb_code: mdbCode, product_key: productKey,
        nayax_product_name: nayaxName, produktart,
        qty_sum: 0, umsatz_sum: 0, warenein_sum: 0,
        vk_w: 0, ek_brutto_w: 0, ek_netto_w: 0, mwst_w: 0
      });
    }
    const a = aggregates.get(aggKey);
    a.qty_sum      += qty;
    a.umsatz_sum   += qty * vkBrutto;
    a.warenein_sum += qty * ekBrutto;
    a.vk_w         += vkBrutto  * qty;
    a.ek_brutto_w  += ekBrutto  * qty;
    a.ek_netto_w   += ekNetto   * qty;
    a.mwst_w       += mwstEinkauf * qty;
  }

  // --- Nayax-Sales laden & VK-Fallback-Map bauen ---
  const nayaxSales = JSON.parse(fs.readFileSync(NAYAX_FILE, 'utf8'));
  // transaction_id → vk_preis_brutto (als Fallback fuer VT-Eintraege ohne VK)
  const txVKMap = new Map();
  for (const s of nayaxSales) {
    if (s.transaction_id && s.vk_preis_brutto > 0) {
      txVKMap.set(String(s.transaction_id), s.vk_preis_brutto);
    }
  }

  // --- Quelle: _nayax_sales.json (alle Datum < NAYAX_END_DATE) ---
  // Datum < CUTOVER_DATE: pre-cutover MDB-Map | Datum >= CUTOVER_DATE: aktuelle MDB-Map
  // WF8 laeuft ab NAYAX_END_DATE und deckt alles ab Mai 11+ ab (Dedup via existingKeys).
  console.log('\n--- Verarbeite _nayax_sales.json (alle Eintraege bis ' + NAYAX_END_DATE + ') ---');
  let nayaxProcessed = 0;

  for (const sale of nayaxSales) {
    const date = parseNayaxDate(clean(sale.settlement_datetime || ''));
    if (!date) { skipped.noDate++; continue; }
    if (date >= NAYAX_END_DATE) continue; // WF8 deckt ab Mai 11 ab

    const infoMatch = clean(sale.product_info || '').match(INFO_RE);
    if (!infoMatch) continue;
    const [, rawName, mdbStr, priceStr] = infoMatch;
    const mdbCode  = String(parseInt(mdbStr));
    const vkBrutto = parseFloat(priceStr) || num(sale.vk_preis_brutto);
    const nameLow  = rawName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    // MDB-Map je nach Datum (pre- oder post-cutover)
    const mdbMapForDate = date < CUTOVER_DATE ? mdbPreMap : mdbCurrentMap;

    // Mapping: erst Alias (Produktname), dann MDB-Map
    let productKey = aliasMap.get(nameLow) || mdbMapForDate.get(mdbCode);

    if (!productKey) {
      skipped.noMap++;
      if (samples.noMap.length < 8) samples.noMap.push(`"${rawName.trim()}" MDB${mdbCode} ${date}`);
      continue;
    }

    const ek = ekMap.get(productKey);
    if (!ek || ek.unit_cost <= 0) {
      skipped.noEK++;
      if (samples.noEK.length < 8) samples.noEK.push(`${productKey} (${rawName.trim()}) ${date}`);
      continue;
    }

    const produktart = produktartMap.get(productKey) || 'snack';
    record(date, MACHINE_ID, mdbCode, productKey, rawName.trim(), 1, vkBrutto, ek.unit_cost, ek.mwst_satz, produktart);
    nayaxProcessed++;
  }
  console.log(`Verarbeitet: ${nayaxProcessed} Nayax-Verkäufe`);

  // ---------- Output-Rows bauen ----------
  const outputRows = [];
  for (const a of aggregates.values()) {
    const q = a.qty_sum || 1;
    outputRows.push({
      date:                  a.date,
      machine_id:            a.machine_id,
      mdb_code:              a.mdb_code,
      product_slot_id:       '',
      product_key:           a.product_key,
      nayax_product_name:    a.nayax_product_name,
      produktart:            a.produktart,
      quantity_sold:         a.qty_sum,
      vk_preis_brutto:       fmt(a.vk_w / q, 4),
      umsatz_brutto:         fmt(a.umsatz_sum, 2),
      ek_preis_netto:        fmt(a.ek_netto_w / q, 4),
      mwst_satz_einkauf:     fmt(a.mwst_w / q, 2),
      ek_preis_brutto:       fmt(a.ek_brutto_w / q, 4),
      wareneinsatz_brutto:   fmt(a.warenein_sum, 2),
      guv:                   fmt(a.umsatz_sum - a.warenein_sum, 2),
      kleinunternehmer_aktiv: 'FALSE',
      aggregiert_am:         now
    });
  }
  outputRows.sort((a, b) => a.date.localeCompare(b.date) || a.product_key.localeCompare(b.product_key));

  // ---------- Zusammenfassung ----------
  const totalUmsatz  = outputRows.reduce((s, r) => s + parseFloat(r.umsatz_brutto), 0);
  const totalGuV     = outputRows.reduce((s, r) => s + parseFloat(r.guv), 0);
  const totalQty     = outputRows.reduce((s, r) => s + r.quantity_sold, 0);

  console.log('\n=== ZUSAMMENFASSUNG ===');
  console.log(`Nayax-Einträge verarbeitet (Oct 2025 – Mai 10): ${nayaxProcessed}`);
  console.log(`Übersprungen: ${skipped.noMap} kein Mapping | ${skipped.noEK} kein EK | ${skipped.dedup} dedup | ${skipped.noDate} kein Datum`);
  console.log(`Neue GuV-Einträge (aggregiert): ${outputRows.length}`);
  console.log(`Gesamt-Umsatz: ${totalUmsatz.toFixed(2)} EUR | Gesamt-GuV: ${totalGuV.toFixed(2)} EUR | Verkäufe: ${totalQty}`);
  if (samples.noMap.length) console.log(`Kein Mapping (Beispiele): ${samples.noMap.join(' | ')}`);
  if (samples.noEK.length)  console.log(`Kein EK (Beispiele):      ${samples.noEK.join(' | ')}`);

  // Per-Produkt-Übersicht
  const byProduct = new Map();
  for (const r of outputRows) {
    if (!byProduct.has(r.product_key)) byProduct.set(r.product_key, { qty: 0, umsatz: 0, guv: 0 });
    const p = byProduct.get(r.product_key);
    p.qty     += r.quantity_sold;
    p.umsatz  += parseFloat(r.umsatz_brutto);
    p.guv     += parseFloat(r.guv);
  }
  console.log('\nPro Produkt:');
  console.log('product_key                          | qty | umsatz  | guv');
  for (const [key, v] of [...byProduct].sort((a, b) => b[1].umsatz - a[1].umsatz)) {
    console.log(`  ${key.padEnd(35)} | ${String(v.qty).padStart(3)} | ${v.umsatz.toFixed(2).padStart(7)} | ${v.guv.toFixed(2).padStart(7)}`);
  }

  // Erste 10 Tages-Eintraege
  console.log('\nErste 10 Tages-Eintraege:');
  console.log('date       | product_key                      | qty | umsatz |    guv');
  for (const r of outputRows.slice(0, 10)) {
    console.log(`  ${r.date} | ${r.product_key.padEnd(32)} | ${String(r.quantity_sold).padStart(3)} | ${String(r.umsatz_brutto).padStart(6)} | ${String(r.guv).padStart(7)}`);
  }

  // JSON-Vorschau speichern (immer)
  fs.writeFileSync(
    'C:/Users/patri/Documents/mein-erstes-Projekt/guv_check_tmp/_guv_backfill_preview.json',
    JSON.stringify(outputRows, null, 2)
  );
  console.log(`\nVorschau gespeichert: _guv_backfill_preview.json (${outputRows.length} Eintraege)`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Keine Änderungen in Google Sheets.');
    return;
  }

  if (outputRows.length === 0) {
    console.log('\nNichts zu schreiben.');
    return;
  }

  // ---------- In GuV_Tagesposten schreiben (Batches à 25 Zeilen) ----------
  const BATCH = 25;
  console.log(`\nSchreibe ${outputRows.length} Zeilen in Batches à ${BATCH}...`);
  for (let i = 0; i < outputRows.length; i += BATCH) {
    const batch = outputRows.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(outputRows.length / BATCH);
    const status = await appendRowsViaWorkflow(batch);
    console.log(`Batch ${batchNum}/${totalBatches}: ${batch.length} Zeilen → ${status === 200 ? '✅ OK' : '❌ Status ' + status}`);
    if (status !== 200) {
      console.error('Fehler im Batch, Abbruch!');
      process.exit(1);
    }
  }

  console.log('\n✅ Historisches GuV-Backfill abgeschlossen.');
})().catch(e => {
  console.error('\nFEHLER:', e.message || e);
  process.exit(1);
});
