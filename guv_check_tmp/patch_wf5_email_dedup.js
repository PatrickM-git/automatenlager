/**
 * Patcht WF5 'Code - Email Zusammenfassung erstellen':
 * Fügt Dedup-Logik nach relevantAlerts ein, sodass jedes Produkt
 * pro Typ nur EINMAL in der Mail erscheint – egal ob der Alert aus
 * Code-MHD (frisch) oder Code-Offene-Hinweise (Sheet) stammt.
 *
 * Bevorzugt den Eintrag mit MDB-Code (mehr Info).
 */
const http = require('http');
const fs   = require('fs');

const cfg     = JSON.parse(fs.readFileSync('C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/.dashboard-config.json', 'utf8'));
const API_KEY = cfg.n8nApiKey;
const WF5_ID  = 'A1TQ7CnHXonafVIv';

function apiReq(m, p, b) {
  return new Promise((resolve, reject) => {
    const body = b ? JSON.stringify(b) : null;
    const req  = http.request({
      hostname : '127.0.0.1',
      port     : 5678,
      path     : p,
      method   : m,
      headers  : {
        'X-N8N-API-KEY' : API_KEY,
        'Content-Type'  : 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
        } else {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function pickAllowed(s) {
  const allowed = ['executionOrder','timezone','saveDataErrorExecution','saveDataSuccessExecution',
                   'saveManualExecutions','saveExecutionProgress','callerPolicy','errorWorkflow'];
  const out = {};
  for (const k of allowed) if (s && s[k] !== undefined) out[k] = s[k];
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Dedup-Block der nach relevantAlerts eingefügt wird
// ──────────────────────────────────────────────────────────────────────────────
const DEDUP_BLOCK = `
// PATCH EMAIL_DEDUP: pro Produkt+Typ nur einmal in der Mail anzeigen.
// Behebt doppelte Eintraege wenn Code-MHD (frische Alerts) und
// Code-Offene-Hinweise (Sheet-Eintraege) dasselbe Produkt enthalten.
// Bevorzugt den Eintrag mit MDB-Code (mehr Info fuer den User).
const _dedupSeen = new Map(); // key -> index in _dedupedAlerts
const _dedupedAlerts = [];
for (const _da of relevantAlerts) {
  const _dk = type(_da) + '::' + (productKey(_da) || productName(_da));
  if (!_dedupSeen.has(_dk)) {
    _dedupSeen.set(_dk, _dedupedAlerts.length);
    _dedupedAlerts.push(_da);
  } else if (!mdbCode(_dedupedAlerts[_dedupSeen.get(_dk)]) && mdbCode(_da)) {
    // Vorhandenen Eintrag durch Version mit MDB-Code ersetzen
    _dedupedAlerts[_dedupSeen.get(_dk)] = _da;
  }
}
`;

(async () => {
  console.log('Lade WF5 …');
  const wf = await apiReq('GET', `/api/v1/workflows/${WF5_ID}`);

  // Backup
  const backupPath = `C:/Users/patri/Documents/mein-erstes-Projekt/guv_check_tmp/_wf5_BACKUP_EMAIL_DEDUP_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2));
  console.log('Backup:', backupPath);

  const node = wf.nodes.find(n => n.name === 'Code - Email Zusammenfassung erstellen');
  if (!node) { console.error('Node nicht gefunden'); process.exit(1); }

  let js = node.parameters.jsCode;

  if (js.includes('// PATCH EMAIL_DEDUP')) {
    console.log('ℹ️  Bereits gepatch – kein Aenderungsbedarf.');
    return;
  }

  // ── Schritt 1: Dedup-Block nach relevantAlerts einfügen ──────────────────
  const ANCHOR = 'const relevantAlerts = alerts.filter(alert => {';
  if (!js.includes(ANCHOR)) {
    console.error('Einfüge-Ankerpunkt nicht gefunden'); process.exit(1);
  }

  // Wir suchen das Ende des relevantAlerts-Blocks (die schließende `});`)
  // und fügen danach den Dedup-Block ein.
  const afterFilter = '\n});\n';
  const insertAt = js.indexOf(afterFilter, js.indexOf(ANCHOR));
  if (insertAt === -1) {
    console.error('Ende des relevantAlerts-Blocks nicht gefunden'); process.exit(1);
  }
  const insertPos = insertAt + afterFilter.length;
  js = js.slice(0, insertPos) + DEDUP_BLOCK + js.slice(insertPos);

  // ── Schritt 2: for-Schleife auf _dedupedAlerts umlenken ──────────────────
  const OLD_LOOP = 'for (const alert of relevantAlerts) {';
  const NEW_LOOP = 'for (const alert of _dedupedAlerts) {';
  if (!js.includes(OLD_LOOP)) {
    console.error('Loop-Ankerpunkt nicht gefunden'); process.exit(1);
  }
  js = js.replace(OLD_LOOP, NEW_LOOP);

  // ── Syntax-Check ─────────────────────────────────────────────────────────
  try {
    new (require('vm')).Script('(async () => {\n' + js + '\n})()');
    console.log('✔ Syntax OK');
  } catch (e) {
    console.error('Syntax-Fehler:', e.message);
    fs.writeFileSync('C:/Users/patri/Documents/mein-erstes-Projekt/guv_check_tmp/_bad_email_dedup.js', js);
    process.exit(1);
  }

  // ── Patch anwenden ───────────────────────────────────────────────────────
  node.parameters.jsCode = js;
  await apiReq('PUT', `/api/v1/workflows/${WF5_ID}`, {
    name        : wf.name,
    nodes       : wf.nodes,
    connections : wf.connections,
    settings    : pickAllowed(wf.settings || {})
  });
  console.log('✅ WF5 Email-Dedup-Patch erfolgreich angewendet.');

  // ── Lokales JSON aktualisieren ───────────────────────────────────────────
  const localPath = 'C:/Users/patri/Documents/mein-erstes-Projekt/WF5 - MHD und niedrige Lagercharge ueberwachen.json';
  if (fs.existsSync(localPath)) {
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const ln = local.nodes.find(n => n.name === 'Code - Email Zusammenfassung erstellen');
    if (ln) {
      ln.parameters.jsCode = js;
      fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
      console.log('Lokales JSON aktualisiert:', localPath);
    }
  }

  // ── Patch-Code sichern ───────────────────────────────────────────────────
  fs.writeFileSync(
    'C:/Users/patri/Documents/mein-erstes-Projekt/guv_check_tmp/_wf5_Code___Email_Zusammenfassung_erstellen.js',
    js
  );
  console.log('Code-Snapshot gespeichert.');
})().catch(e => { console.error(e.message); process.exit(1); });
