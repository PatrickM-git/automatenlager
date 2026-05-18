import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';

const SHEET_DOC_ID = '12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo';
const SHEETS_CRED = newCredential('Sheets Automatenlager');

const cronTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Cron - Taeglich 02:00',
    parameters: {
      rule: {
        interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 2, triggerAtMinute: 0 }]
      }
    },
    position: [240, 300]
  },
  output: [{}]
});

const readTransaktionen = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Read - Verarbeitete_Transaktionen',
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: { __rl: true, mode: 'id', value: SHEET_DOC_ID },
      sheetName: { __rl: true, mode: 'name', value: 'Verarbeitete_Transaktionen' },
      options: {}
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    position: [460, 300]
  },
  output: [{
    timestamp: '2026-05-11T10:00:00Z',
    machine_id: '457107528',
    mdb_code: '10',
    mdb_code_extracted: '10',
    product_slot_id: 'SLOT_10',
    product_key: 'SKU_SNICKERS',
    nayax_product_name: 'Snickers 40g',
    qty: 1,
    vk_preis_brutto: 1.5,
    umsatz_brutto: 1.5,
    batch_id_abgebucht: 'B_SNICKERS_20260101_001'
  }]
});

const readLagerchargen = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Read - Lagerchargen',
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: { __rl: true, mode: 'id', value: SHEET_DOC_ID },
      sheetName: { __rl: true, mode: 'name', value: 'Lagerchargen' },
      options: {}
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    executeOnce: true,
    position: [680, 300]
  },
  output: [{
    batch_id: 'B_SNICKERS_20260101_001',
    product_key: 'SKU_SNICKERS',
    unit_cost: 0.5,
    mwst_satz: 7,
    purchase_date: '2026-01-01',
    initial_qty: 16,
    remaining_qty: 12
  }]
});

const readProdukte = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Read - Produkte',
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: { __rl: true, mode: 'id', value: SHEET_DOC_ID },
      sheetName: { __rl: true, mode: 'name', value: 'Produkte' },
      options: {}
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    executeOnce: true,
    position: [900, 300]
  },
  output: [{
    product_key: 'SKU_SNICKERS',
    internal_product_name: 'Snickers 40g',
    produktart: 'snack'
  }]
});

const readKonfig = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Read - GuV_Konfiguration',
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: { __rl: true, mode: 'id', value: SHEET_DOC_ID },
      sheetName: { __rl: true, mode: 'name', value: 'GuV_Konfiguration' },
      options: {}
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    executeOnce: true,
    position: [1120, 300]
  },
  output: [{
    kleinunternehmer_aktiv: 'TRUE',
    mwst_snack: 7,
    mwst_getraenk: 19
  }]
});

const readExistingGuV = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Read - GuV_Tagesposten (vorhanden)',
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: { __rl: true, mode: 'id', value: SHEET_DOC_ID },
      sheetName: { __rl: true, mode: 'name', value: 'GuV_Tagesposten' },
      options: {}
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    executeOnce: true,
    alwaysOutputData: true,
    position: [1340, 300]
  },
  output: [{
    date: '2026-05-10',
    machine_id: '457107528',
    product_key: 'SKU_SNICKERS'
  }]
});

const guvCode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Code - GuV aggregieren',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: [
        "const transactions = $items('Read - Verarbeitete_Transaktionen').map(i => i.json);",
        "const batches      = $items('Read - Lagerchargen').map(i => i.json);",
        "const products     = $items('Read - Produkte').map(i => i.json);",
        "const config       = $items('Read - GuV_Konfiguration').map(i => i.json)[0] || {};",
        "const existingGuV  = $items('Read - GuV_Tagesposten (vorhanden)').map(i => i.json);",
        "",
        "function clean(v) { return String(v == null ? '' : v).trim(); }",
        "function num(v)   { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; }",
        "function fmt(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '0'; }",
        "",
        "const kleinunternehmerAktiv = clean(config.kleinunternehmer_aktiv).toUpperCase() === 'TRUE';",
        "const mwstSnack    = num(config.mwst_snack)    || 7;",
        "const mwstGetraenk = num(config.mwst_getraenk) || 19;",
        "",
        "function mwstVonProduktart(art) {",
        "  const a = clean(art).toLowerCase();",
        "  if (a === 'snack' || a.includes('snack') || a === 'riegel') return mwstSnack;",
        "  if (a === 'getraenk' || a.includes('getraenk') || a.includes('drink')) return mwstGetraenk;",
        "  return mwstGetraenk;",
        "}",
        "",
        "const batchMap = new Map();",
        "for (const b of batches) {",
        "  const id = clean(b.batch_id);",
        "  if (id) batchMap.set(id, b);",
        "}",
        "",
        "const productMap = new Map();",
        "for (const p of products) {",
        "  const k = clean(p.product_key);",
        "  if (k) productMap.set(k, p);",
        "}",
        "",
        "function aggKey(date, machineId, productKey) { return date + '|' + machineId + '|' + productKey; }",
        "const existingKeys = new Set();",
        "for (const r of existingGuV) {",
        "  const d = clean(r.date), m = clean(r.machine_id), p = clean(r.product_key);",
        "  if (d && m && p) existingKeys.add(aggKey(d, m, p));",
        "}",
        "",
        "function deriveDate(tx) {",
        "  const ts = clean(tx.sale_date || tx.timestamp || tx.processed_at);",
        "  if (!ts) return '';",
        "  const m = ts.match(/^(\\d{4}-\\d{2}-\\d{2})/);",
        "  return m ? m[1] : '';",
        "}",
        "",
        "const aggregates = new Map();",
        "let skippedExisting = 0, skippedInvalid = 0, processed = 0;",
        "",
        "for (const tx of transactions) {",
        "  const date = deriveDate(tx);",
        "  const machineId  = clean(tx.machine_id);",
        "  const productKey = clean(tx.product_key);",
        "  if (!date || !machineId || !productKey) { skippedInvalid++; continue; }",
        "",
        "  const key = aggKey(date, machineId, productKey);",
        "  if (existingKeys.has(key)) { skippedExisting++; continue; }",
        "",
        "  const qty       = num(tx.qty || tx.quantity || 1) || 1;",
        "  const vkBrutto  = num(tx.vk_preis_brutto);",
        "  const umsatzBr  = num(tx.umsatz_brutto || qty * vkBrutto);",
        "",
        "  const batchIds  = clean(tx.batch_id_abgebucht).split(',').map(s => s.trim()).filter(Boolean);",
        "  let ekBrutto    = 0;",
        "  let mwstEinkauf = 0;",
        "  if (batchIds.length > 0) {",
        "    const firstBatch = batchMap.get(batchIds[0]);",
        "    if (firstBatch) {",
        "      ekBrutto    = num(firstBatch.unit_cost);",
        "      mwstEinkauf = num(firstBatch.mwst_satz);",
        "    }",
        "  }",
        "",
        "  const product   = productMap.get(productKey) || {};",
        "  const produktart = clean(product.produktart);",
        "  if (!mwstEinkauf || mwstEinkauf <= 0) mwstEinkauf = mwstVonProduktart(produktart);",
        "",
        "  const ekNetto   = mwstEinkauf > 0 ? ekBrutto / (1 + mwstEinkauf / 100) : ekBrutto;",
        "  const warenein  = qty * ekBrutto;",
        "",
        "  if (!aggregates.has(key)) {",
        "    aggregates.set(key, {",
        "      date, machine_id: machineId, product_key: productKey,",
        "      mdb_code: clean(tx.mdb_code_extracted || tx.mdb_code),",
        "      product_slot_id: clean(tx.product_slot_id),",
        "      nayax_product_name: clean(tx.nayax_product_name || tx.product_name),",
        "      produktart,",
        "      qty_sum: 0, umsatz_sum: 0, warenein_sum: 0,",
        "      vk_weighted: 0, ek_brutto_weighted: 0, ek_netto_weighted: 0, mwst_weighted: 0",
        "    });",
        "  }",
        "  const a = aggregates.get(key);",
        "  a.qty_sum            += qty;",
        "  a.umsatz_sum         += umsatzBr;",
        "  a.warenein_sum       += warenein;",
        "  a.vk_weighted        += vkBrutto * qty;",
        "  a.ek_brutto_weighted += ekBrutto * qty;",
        "  a.ek_netto_weighted  += ekNetto  * qty;",
        "  a.mwst_weighted      += mwstEinkauf * qty;",
        "  processed++;",
        "}",
        "",
        "const now = new Date().toISOString();",
        "const out = [];",
        "for (const a of aggregates.values()) {",
        "  const q = a.qty_sum || 1;",
        "  out.push({",
        "    json: {",
        "      date: a.date,",
        "      machine_id: a.machine_id,",
        "      mdb_code: a.mdb_code,",
        "      product_slot_id: a.product_slot_id,",
        "      product_key: a.product_key,",
        "      nayax_product_name: a.nayax_product_name,",
        "      produktart: a.produktart,",
        "      quantity_sold: a.qty_sum,",
        "      vk_preis_brutto: fmt(a.vk_weighted / q, 4),",
        "      umsatz_brutto:   fmt(a.umsatz_sum, 2),",
        "      ek_preis_netto:  fmt(a.ek_netto_weighted / q, 4),",
        "      mwst_satz_einkauf: fmt(a.mwst_weighted / q, 2),",
        "      ek_preis_brutto: fmt(a.ek_brutto_weighted / q, 4),",
        "      wareneinsatz_brutto: fmt(a.warenein_sum, 2),",
        "      guv: fmt(a.umsatz_sum - a.warenein_sum, 2),",
        "      kleinunternehmer_aktiv: kleinunternehmerAktiv ? 'TRUE' : 'FALSE',",
        "      aggregiert_am: now",
        "    }",
        "  });",
        "}",
        "",
        "if (out.length === 0) {",
        "  return [{ json: { _info: 'Keine neuen Aggregationen', processed, skippedExisting, skippedInvalid, _empty: true } }];",
        "}",
        "return out;"
      ].join('\n')
    },
    position: [1560, 300]
  },
  output: [{
    date: '2026-05-11',
    machine_id: '457107528',
    mdb_code: '10',
    product_slot_id: 'SLOT_10',
    product_key: 'SKU_SNICKERS',
    nayax_product_name: 'Snickers 40g',
    produktart: 'snack',
    quantity_sold: 4,
    vk_preis_brutto: '1.5',
    umsatz_brutto: '6.00',
    ek_preis_netto: '0.4673',
    mwst_satz_einkauf: '7',
    ek_preis_brutto: '0.5',
    wareneinsatz_brutto: '2.00',
    guv: '4.00',
    kleinunternehmer_aktiv: 'TRUE',
    aggregiert_am: '2026-05-12T02:00:00Z'
  }]
});

const appendGuV = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Append - GuV_Tagesposten',
    parameters: {
      resource: 'sheet',
      operation: 'append',
      documentId: { __rl: true, mode: 'id', value: SHEET_DOC_ID },
      sheetName: { __rl: true, mode: 'name', value: 'GuV_Tagesposten' },
      columns: {
        mappingMode: 'autoMapInputData',
        value: {},
        matchingColumns: [],
        schema: [],
        attemptToConvertTypes: false,
        convertFieldsToString: false
      },
      options: {}
    },
    credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    position: [1780, 300]
  },
  output: [{}]
});

const stickyDesign = sticky(
  '## WF8 – GuV Tagesposten Aggregator\n\n' +
  '**Taeglich 02:00:** liest alle Verkaufstransaktionen, berechnet pro\n' +
  '(Tag × Maschine × Produkt) Umsatz, Wareneinsatz und GuV, und schreibt\n' +
  'das Ergebnis in `GuV_Tagesposten`.\n\n' +
  '**Idempotent:** Aggregationen, die fuer (date, machine_id, product_key)\n' +
  'bereits existieren, werden uebersprungen.\n\n' +
  '**Fallbacks:** Lagercharge ohne mwst_satz → Produktart-Default (7/19).\n' +
  'Transaktion ohne batch_id_abgebucht → Wareneinsatz 0 (Warnung im _info).\n\n' +
  '**Kleinunternehmer:** Status aus GuV_Konfiguration, wird in jede Zeile geschrieben.',
  [cronTrigger, readTransaktionen, readLagerchargen, readProdukte, readKonfig, readExistingGuV, guvCode, appendGuV],
  { color: 4, position: [200, 80], width: 1700, height: 180 }
);

export default workflow('wf8-guv-aggregator', 'WF8 - GuV Tagesposten Aggregator')
  .add(cronTrigger)
  .to(readTransaktionen)
  .to(readLagerchargen)
  .to(readProdukte)
  .to(readKonfig)
  .to(readExistingGuV)
  .to(guvCode)
  .to(appendGuV);
