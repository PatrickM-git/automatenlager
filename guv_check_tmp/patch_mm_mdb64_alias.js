// patch_mm_mdb64_alias.js
// Schritt 1: Alias "M&M's" → SKU_M_AND_M_CRISPY in Produkt_Aliase einfügen
// Schritt 2: UNKNOWN_PRODUCT-Transaktion 6751983710 als MANUALLY_RESOLVED markieren
// Lagerbestand bleibt unverändert (User-verifiziert)
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const cfg = JSON.parse(fs.readFileSync('C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/.dashboard-config.json', 'utf8'));
const SHEET_ID = '12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo';
const CRED = { googleSheetsOAuth2Api: { id: '5XfHt3SzjHCj8B5H', name: 'Sheets Automatenlager' } };
const now = new Date().toISOString();

function apiReq(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname: '127.0.0.1', port: 5678, path, method, headers: { 'X-N8N-API-KEY': cfg.n8nApiKey, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } };
    const req = http.request(opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { if (r.statusCode >= 400) rej(new Error(`HTTP ${r.statusCode}: ${d.slice(0, 400)}`)); else try { res(JSON.parse(d)); } catch { res(d); } }); });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
function httpGet(url) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); }).on('error', rej);
  });
}

async function runTempWf(name, nodes, connections) {
  const wfPath = name + '-' + crypto.randomBytes(4).toString('hex');
  const nodesWithWebhook = [
    { id: 'h', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { httpMethod: 'GET', path: wfPath, responseMode: 'lastNode', options: {} }, webhookId: crypto.randomUUID() },
    ...nodes
  ];
  const connsWithWebhook = { Webhook: { main: [[{ node: nodes[0].name, type: 'main', index: 0 }]] }, ...connections };
  const wf = { name: 'WF_TEMP_' + name.toUpperCase() + '_' + now.slice(0, 10), nodes: nodesWithWebhook, connections: connsWithWebhook, settings: { executionOrder: 'v1' } };
  const c = await apiReq('POST', '/api/v1/workflows', wf);
  await apiReq('POST', `/api/v1/workflows/${c.id}/activate`);
  await new Promise(r => setTimeout(r, 800));
  const r = await httpGet(`http://127.0.0.1:5678/webhook/${wfPath}`);
  await new Promise(r => setTimeout(r, 2500));
  await apiReq('POST', `/api/v1/workflows/${c.id}/deactivate`);
  await apiReq('DELETE', `/api/v1/workflows/${c.id}`);
  return r.status;
}

(async () => {
  // --- SCHRITT 1: Alias anhängen ---
  const aliasData = {
    alias_name: "M&M's",
    normalized_alias: "m&ms",
    product_key: 'SKU_M_AND_M_CRISPY',
    source: 'Manuelle_Korrektur',
    confidence: 'hoch',
    approved: 'TRUE',
    created_at: now,
    last_seen_at: now,
    supplier: '',
    invoice_item_example: "M&M's(64 = 1.20)",
    notes: "Nayax sendet M&Ms ohne Sortenangabe fuer MDB 64. Korrekt: SKU_M_AND_M_CRISPY."
  };
  const aliasSchema = Object.keys(aliasData).map(id => ({ id, displayName: id, type: 'string', required: false, display: true, defaultMatch: id === 'alias_name', canBeUsedToMatch: id === 'alias_name' }));

  const s1 = await runTempWf('mm-alias', [
    { id: 'c', name: 'Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: `return [{ json: ${JSON.stringify(aliasData)} }];` } },
    { id: 'gs', name: 'Append', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [440, 0], parameters: { operation: 'append', documentId: { __rl: true, value: SHEET_ID, mode: 'id' }, sheetName: { __rl: true, value: 'Produkt_Aliase', mode: 'name' }, columns: { mappingMode: 'defineBelow', value: Object.fromEntries(Object.keys(aliasData).map(k => [k, `={{ $json.${k} }}`])), schema: aliasSchema }, options: {} }, credentials: CRED }
  ], { Data: { main: [[{ node: 'Append', type: 'main', index: 0 }]] } });
  console.log('Schritt 1 – Alias einfügen:', s1 === 200 ? '✅ OK' : '❌ ' + s1);

  // --- SCHRITT 2: VT-Eintrag auflösen ---
  const vtData = { transaction_id: '6751983710', product_key: 'SKU_M_AND_M_CRISPY', status: 'MANUALLY_RESOLVED', notes: "Manuell aufgeloest: M&Ms auf MDB 64 = SKU_M_AND_M_CRISPY. Alias hinzugefuegt. Lagerbestand vom User verifiziert, kein Abzug." };
  const vtSchema = Object.keys(vtData).map(id => ({ id, displayName: id, type: 'string', required: false, display: true, defaultMatch: id === 'transaction_id', canBeUsedToMatch: id === 'transaction_id' }));

  const s2 = await runTempWf('mm-vt-resolve', [
    { id: 'c', name: 'Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: `return [{ json: ${JSON.stringify(vtData)} }];` } },
    { id: 'gs', name: 'Update', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [440, 0], parameters: { operation: 'update', documentId: { __rl: true, value: SHEET_ID, mode: 'id' }, sheetName: { __rl: true, value: 'Verarbeitete_Transaktionen', mode: 'name' }, columns: { mappingMode: 'defineBelow', value: Object.fromEntries(Object.keys(vtData).map(k => [k, `={{ $json.${k} }}`])), matchingColumns: ['transaction_id'], schema: vtSchema }, options: {} }, credentials: CRED }
  ], { Data: { main: [[{ node: 'Update', type: 'main', index: 0 }]] } });
  console.log('Schritt 2 – VT auflösen:   ', s2 === 200 ? '✅ OK' : '❌ ' + s2);

  console.log('\nErgebnis:');
  console.log('  Produkt_Aliase: "M\'M\'s" → SKU_M_AND_M_CRISPY hinzugefügt');
  console.log('  Verarbeitete_Transaktionen 6751983710: MANUALLY_RESOLVED');
  console.log('  Lagerbestand: unverändert (User-verifiziert)');
})().catch(e => console.error('FEHLER:', e));
