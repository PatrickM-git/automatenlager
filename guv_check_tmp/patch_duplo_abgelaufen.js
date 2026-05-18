// patch_duplo_abgelaufen.js
// Setzt B_DUPLO_ORIGINAL_20260502_1 status → "abgelaufen"
// (MHD 2026-05-18 erreicht; physische Entnahme + remaining=0 kommt mit nächster Pickliste)
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const cfg = JSON.parse(fs.readFileSync('C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/.dashboard-config.json', 'utf8'));

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

(async () => {
  const path = 'duplo-abgelaufen-' + crypto.randomBytes(4).toString('hex');
  const wf = {
    name: 'WF_TEMP_DUPLO_ABGELAUFEN_' + new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-'),
    nodes: [
      { id: 'h', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { httpMethod: 'GET', path, responseMode: 'lastNode', options: {} }, webhookId: crypto.randomUUID() },
      { id: 's', name: 'S', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: `return [{ json: { batch_id: 'B_DUPLO_ORIGINAL_20260502_1', status: 'abgelaufen', notes: 'MHD 2026-05-18 erreicht. Physische Entnahme geplant 2026-05-19; remaining_qty-Bereinigung mit naechster Pickliste.' } }];` } },
      {
        id: 'u', name: 'U', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [440, 0], parameters: {
          operation: 'update',
          documentId: { __rl: true, value: '12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo', mode: 'id' },
          sheetName: { __rl: true, value: 'Lagerchargen', mode: 'name' },
          columns: {
            mappingMode: 'defineBelow',
            value: { batch_id: '={{ $json.batch_id }}', status: '={{ $json.status }}', notes: '={{ $json.notes }}' },
            matchingColumns: ['batch_id'],
            schema: [
              { id: 'batch_id', displayName: 'batch_id', required: false, defaultMatch: true, display: true, type: 'string', canBeUsedToMatch: true },
              { id: 'status', displayName: 'status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
              { id: 'notes', displayName: 'notes', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false },
            ]
          },
          options: {}
        },
        credentials: { googleSheetsOAuth2Api: { id: '5XfHt3SzjHCj8B5H', name: 'Sheets Automatenlager' } }
      }
    ],
    connections: { Webhook: { main: [[{ node: 'S', type: 'main', index: 0 }]] }, S: { main: [[{ node: 'U', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' }
  };

  const c = await apiReq('POST', '/api/v1/workflows', wf);
  await apiReq('POST', `/api/v1/workflows/${c.id}/activate`);
  await new Promise(r => setTimeout(r, 800));
  const r = await httpGet(`http://127.0.0.1:5678/webhook/${path}`);
  console.log('Duplo → abgelaufen:', r.status === 200 ? '✅ OK' : '❌ ' + r.status);
  await new Promise(r => setTimeout(r, 2500));
  await apiReq('POST', `/api/v1/workflows/${c.id}/deactivate`);
  await apiReq('DELETE', `/api/v1/workflows/${c.id}`);
  console.log('Temp-WF bereinigt.');
})().catch(e => console.error('FEHLER:', e));
