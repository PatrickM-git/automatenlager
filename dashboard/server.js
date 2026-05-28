const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const { buildEconomicsData, queryEconomicsPg } = require('./lib/economics.js');
const { buildInventoryMhdData, queryInventoryMhdPg } = require('./lib/inventory-mhd.js');
const { buildAssortmentSlotsData, queryAssortmentSlotsPg } = require('./lib/assortment-slots.js');
const { buildOverviewData, buildMonitoringData, queryOverviewMonitoringPg } = require('./lib/overview-monitoring.js');
const { searchRefillTargets, buildRefillDetails, validateRefillQty, buildRefillAuditEntry } = require('./lib/refill.js');
const { buildSlotChangePreview, validateSlotChange, buildSlotChangePayload, buildSlotChangeAuditEntry } = require('./lib/slot-change.js');
const { buildProductOnboardingData, queryProductOnboardingPg } = require('./lib/product-onboarding.js');
const { buildCsvExport, buildCsvFilename } = require('./lib/reports.js');
const { buildLocationProfile, buildLocationComparison, queryLocationsPg, upsertLocationPg } = require('./lib/location-profiles.js');
const { buildCorrectionCases, queryCorrectionCasesPg } = require('./lib/correction-cases.js');
const { buildMachineProfile, getMachineOptions, queryMachineProfilesPg, upsertMachineProfilePg } = require('./lib/machine-profiles.js');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, '.dashboard-config.json');
const LOCAL_ENV_FILES = [
  path.join(ROOT, '.env.local'),
  path.join(__dirname, '.env.local'),
];

const workflowFiles = [
  'WF0 - product_slot_id Backfill.json',
  'WF1 - Rechnungseingang automatisch mit Claude.json',
  'WF2 - Smart Product Selection - Rechnungsvorschlaege freigeben.json',
  'WF3 Nayax Lynx FIFO Lagerbestand - manueller Abruf - mit WF4 Integration.json',
  'WF4 - MDB Produktzuordnung bearbeiten.json',
  'WF5 - MHD und niedrige Lagercharge ueberwachen.json',
  'WF7 - Nachfuellung melden.json',
  'WF8 - GuV Tagesposten Aggregator.json',
  'WF9 - Pickliste verarbeiten.json',
];

const workbookFilePattern = /^nayax_lager.*\.xlsx$/i;
const googleSheetId = '12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo';
const googleSheetUrl = `https://docs.google.com/spreadsheets/d/${googleSheetId}/edit?gid=1505466008#gid=1505466008`;
const liveSheetNames = [
  'Dashboard',
  'Produkte',
  'Lagerchargen',
  'Produkt_Aenderungsvorschlaege',
  'Produkt_Aliase',
  'Rechnungseingang_Pruefung',
  'Lagerchargen_Vorschlaege',
  'Bestandsaufnahme_Handschrift',
  'Produktwechsel_Log',
  'Fehler_und_Hinweise',
  'Offene_Eingaben',
  'Workflow_Anpassungen',
  'Einstellungen',
  'Quellen_und_Pruefung',
  'Verarbeitete_Transaktionen',
  'System_Status',
];

const dashboardV2Areas = new Map([
  ['overview', { path: '/api/v2/overview', label: 'Overview' }],
  ['inventory-mhd', { path: '/api/v2/inventory-mhd', label: 'Bestand & MHD' }],
  ['economics', { path: '/api/v2/economics', label: 'GuV & KPI' }],
  ['assortment-slots', { path: '/api/v2/assortment-slots', label: 'Sortiment & Slots' }],
  ['monitoring', { path: '/api/v2/monitoring', label: 'Monitoring' }],
]);

const DASHBOARD_V2_UPLOAD_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const dashboardV2UploadTargets = {
  invoice: {
    id: 'invoice',
    label: 'Rechnung',
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
    allowedExtensions: ['.pdf', '.png', '.jpg', '.jpeg'],
    workflowName: /^WF1 - Rechnungseingang automatisch mit Claude$/i,
  },
  picklist: {
    id: 'picklist',
    label: 'Pickliste',
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf'],
    allowedExtensions: ['.pdf'],
    workflowName: /^WF9 - Pickliste verarbeiten$/i,
  },
};

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key) values[key] = value;
  }
  return values;
}

function loadLocalEnv() {
  return LOCAL_ENV_FILES.reduce((values, filePath) => {
    return { ...values, ...parseEnvFile(filePath) };
  }, {});
}

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfigFile(data) {
  const existing = readConfigFile();
  const merged = { ...existing, ...data };
  // Never store empty string for apiKey — keep existing
  if (!merged.n8nApiKey) delete merged.n8nApiKey;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function maskApiKey(key) {
  if (!key || key.length < 8) return key ? '••••••••' : '';
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

function dashboardConfig() {
  const localEnv = loadLocalEnv();
  const fileConfig = readConfigFile();
  // Priority: process.env > config file (UI-saved) > .env.local files
  const n8nBaseUrl = process.env.N8N_BASE_URL || fileConfig.n8nBaseUrl || localEnv.N8N_BASE_URL || 'http://127.0.0.1:5678';
  const n8nApiKey  = process.env.N8N_API_KEY  || fileConfig.n8nApiKey  || localEnv.N8N_API_KEY  || '';
  const source = process.env.N8N_API_KEY ? 'env' : fileConfig.n8nApiKey ? 'config_file' : localEnv.N8N_API_KEY ? 'env_file' : 'none';
  return {
    n8nBaseUrl: n8nBaseUrl.replace(/\/+$/, ''),
    n8nApiKey,
    hasN8nApiKey: Boolean(n8nApiKey),
    source,
    envFiles: LOCAL_ENV_FILES.filter((filePath) => fs.existsSync(filePath)).map((filePath) => path.relative(ROOT, filePath)),
  };
}

function getViewer(req) {
  const login = clean(req.headers['tailscale-user-login']);
  const configuredAdmins = clean(process.env.DASHBOARD_ADMIN_LOGIN)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const normalizedLogin = login.toLowerCase();
  // No Tailscale-Serve identity header = operator trust (plain TCP Tailscale or localhost).
  // Guest status requires an explicit tailscale-user-login that is NOT in the admin list.
  const isAdmin = !normalizedLogin
    || configuredAdmins.includes(normalizedLogin)
    || normalizedLogin.startsWith('patrick');

  return {
    login: login || (isLocalDashboardHost(req.headers.host) ? 'local-admin' : 'operator'),
    role: isAdmin ? 'admin' : 'guest',
    canTriggerActions: isAdmin,
  };
}

function isLocalDashboardHost(hostHeader) {
  const host = clean(hostHeader).toLowerCase();
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function auditGuestAccess(viewer, event, details = {}) {
  if (viewer.role !== 'guest') return;
  const auditPath = process.env.DASHBOARD_AUDIT_LOG || path.join(__dirname, 'logs', 'guest-access.jsonl');
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    login: viewer.login,
    role: viewer.role,
    ...details,
  };
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function clean(value) {
  return String(value ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatBerlinDateTime(date) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function dashboardV2PgUrl() {
  return clean(process.env.DASHBOARD_V2_PG_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL);
}

function collectRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`Body groesser als ${maxBytes} Bytes.`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return clean((match && (match[1] || match[2])) || '');
}

function parseMultipartFormData(bodyBuffer, contentType) {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    const error = new Error('Boundary im multipart/form-data Header fehlt.');
    error.code = 'MULTIPART_BOUNDARY_MISSING';
    throw error;
  }

  const delimiter = `--${boundary}`;
  const text = bodyBuffer.toString('latin1');
  const segments = text.split(delimiter).slice(1);
  const fields = {};
  const files = [];

  for (const segment of segments) {
    if (segment.startsWith('--')) break;

    let part = segment;
    if (part.startsWith('\r\n')) part = part.slice(2);
    if (part.endsWith('\r\n')) part = part.slice(0, -2);
    if (!part) continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const rawHeaders = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4);
    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) continue;
      const key = clean(line.slice(0, separatorIndex).toLowerCase());
      const value = clean(line.slice(separatorIndex + 1));
      headers[key] = value;
    }

    const disposition = headers['content-disposition'] || '';
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    const name = clean((nameMatch && nameMatch[1]) || '');
    if (!name) continue;

    const fileNameMatch = /filename="([^"]*)"/i.exec(disposition);
    const fileName = fileNameMatch ? clean(fileNameMatch[1]) : '';

    if (!fileName) {
      fields[name] = bodyText;
      continue;
    }

    const fileBuffer = Buffer.from(bodyText, 'latin1');
    files.push({
      fieldName: name,
      fileName,
      mimeType: clean(headers['content-type']).toLowerCase(),
      sizeBytes: fileBuffer.length,
      data: fileBuffer,
    });
  }

  return { fields, files };
}

function safeFileName(value) {
  const normalized = clean(value).replace(/\\/g, '/');
  return path.basename(normalized);
}

function validateV2Upload(targetConfig, parsedForm, routeTarget) {
  const formTarget = clean(parsedForm.fields.target).toLowerCase();
  if (formTarget && formTarget !== routeTarget) {
    const error = new Error('Der Zieltyp im Formular passt nicht zur Upload-Route.');
    error.code = 'TARGET_MISMATCH';
    error.status = 400;
    throw error;
  }

  const file = parsedForm.files.find((entry) => entry.fieldName === 'file') || parsedForm.files[0];
  if (!file) {
    const error = new Error('Es wurde keine Datei im Feld "file" gesendet.');
    error.code = 'FILE_MISSING';
    error.status = 400;
    throw error;
  }

  file.fileName = safeFileName(file.fileName);
  if (!file.fileName) {
    const error = new Error('Der Dateiname fehlt oder ist ungueltig.');
    error.code = 'FILE_NAME_INVALID';
    error.status = 422;
    throw error;
  }

  const extension = path.extname(file.fileName).toLowerCase();
  if (!targetConfig.allowedExtensions.includes(extension)) {
    const error = new Error(`${targetConfig.label}-Upload akzeptiert diesen Dateinamen nicht.`);
    error.code = 'FILE_TYPE_NOT_ALLOWED';
    error.status = 422;
    throw error;
  }

  const mimeType = clean(file.mimeType).toLowerCase();
  if (!targetConfig.allowedMimeTypes.includes(mimeType)) {
    const error = new Error(`${targetConfig.label}-Upload akzeptiert diesen Content-Type nicht.`);
    error.code = 'FILE_TYPE_NOT_ALLOWED';
    error.status = 422;
    throw error;
  }

  if (file.sizeBytes <= 0) {
    const error = new Error('Die Datei ist leer.');
    error.code = 'FILE_EMPTY';
    error.status = 422;
    throw error;
  }

  if (file.sizeBytes > targetConfig.maxBytes) {
    const error = new Error(`${targetConfig.label}-Datei ist zu gross (max. ${targetConfig.maxBytes} Bytes).`);
    error.code = 'FILE_TOO_LARGE';
    error.status = 413;
    throw error;
  }

  return file;
}

function resolveV2UploadWorkflow(targetConfig, n8n) {
  const workflow = pickWorkflowForAction(n8n.workflows || [], targetConfig.workflowName);
  if (!workflow || !workflow.active) return null;

  const webhook = firstProductionWebhook(workflow);
  if (!webhook?.path) return null;
  const method = clean(webhook.method || 'POST').toUpperCase();
  if (method !== 'POST') return null;

  const webhookUrl = `${n8n.baseUrl || dashboardConfig().n8nBaseUrl}/webhook/${encodeURIComponent(webhook.path)}`;
  return {
    id: workflow.id,
    name: workflow.name,
    webhookPath: webhook.path,
    method,
    url: webhookUrl,
  };
}

function buildV2UploadCapabilities(viewer) {
  return {
    viewer,
    canUpload: viewer.canTriggerActions,
    targets: Object.values(dashboardV2UploadTargets).map((target) => ({
      id: target.id,
      label: target.label,
      maxBytes: target.maxBytes,
      allowedMimeTypes: target.allowedMimeTypes,
      allowedExtensions: target.allowedExtensions,
    })),
  };
}

function readDashboardV2LastSuccess(area) {
  const filePath = process.env.DASHBOARD_V2_LAST_SUCCESS_FILE
    || path.join(__dirname, 'logs', 'dashboard-v2-last-success.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const stamp = clean(data?.[area]?.generatedAt || data?.[area]?.lastSuccessfulAt);
    const parsed = stamp ? new Date(stamp) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  } catch {
    return null;
  }
}

function buildDashboardV2Error(area, code, message, status = 503) {
  const now = new Date();
  const lastSuccessfulAt = readDashboardV2LastSuccess(area);
  const lastSuccessfulDate = lastSuccessfulAt ? new Date(lastSuccessfulAt) : null;
  return {
    status,
    body: {
      ok: false,
      area,
      source: 'postgres',
      generatedAt: now.toISOString(),
      generatedAtDisplay: formatBerlinDateTime(now),
      lastSuccessfulAt,
      lastSuccessfulAtDisplay: lastSuccessfulDate ? formatBerlinDateTime(lastSuccessfulDate) : null,
      data: null,
      error: {
        code,
        message,
      },
    },
  };
}

async function buildDashboardV2Area(area, query = {}) {
  if (!dashboardV2Areas.has(area)) {
    return buildDashboardV2Error(area, 'V2_AREA_NOT_FOUND', 'Dieser Dashboard-v2-Bereich ist nicht definiert.', 404);
  }

  const pgUrl = dashboardV2PgUrl();
  if (!pgUrl) {
    return buildDashboardV2Error(
      area,
      'PG_UNCONFIGURED',
      'PostgreSQL ist fuer Dashboard v2 nicht konfiguriert. Es wird kein Sheet- oder Legacy-Fallback genutzt.',
    );
  }

  if (area === 'overview' || area === 'monitoring') {
    try {
      const raw = await queryOverviewMonitoringPg(pgUrl);
      const overview = buildOverviewData(raw);
      const monitoring = buildMonitoringData(raw);
      const now = new Date();
      return {
        status: 200,
        body: {
          ok: true,
          area,
          source: 'postgres',
          generatedAt: now.toISOString(),
          generatedAtDisplay: formatBerlinDateTime(now),
          lastSuccessfulAt: now.toISOString(),
          lastSuccessfulAtDisplay: formatBerlinDateTime(now),
          data: area === 'overview'
            ? {
                ...overview,
                ampels: monitoring.ampels,
                stale: monitoring.stale,
              }
            : {
                ...monitoring,
              },
          error: null,
        },
      };
    } catch (err) {
      return buildDashboardV2Error(area, 'PG_ERROR', `PostgreSQL-Abfrage fehlgeschlagen: ${err.message}`);
    }
  }

  if (area === 'economics') {
    try {
      const pgRows = await queryEconomicsPg(pgUrl, query);
      const data = buildEconomicsData(pgRows, query);
      const now = new Date();
      return {
        status: 200,
        body: {
          ok: true,
          area,
          source: 'postgres',
          generatedAt: now.toISOString(),
          generatedAtDisplay: formatBerlinDateTime(now),
          lastSuccessfulAt: now.toISOString(),
          lastSuccessfulAtDisplay: formatBerlinDateTime(now),
          data,
          error: null,
        },
      };
    } catch (err) {
      return buildDashboardV2Error(area, 'PG_ERROR', `PostgreSQL-Abfrage fehlgeschlagen: ${err.message}`);
    }
  }

  if (area === 'inventory-mhd') {
    try {
      const pgRows = await queryInventoryMhdPg(pgUrl, query);
      const data = buildInventoryMhdData(pgRows, query);
      const now = new Date();
      return {
        status: 200,
        body: {
          ok: true,
          area,
          source: 'postgres',
          generatedAt: now.toISOString(),
          generatedAtDisplay: formatBerlinDateTime(now),
          lastSuccessfulAt: now.toISOString(),
          lastSuccessfulAtDisplay: formatBerlinDateTime(now),
          data,
          error: null,
        },
      };
    } catch (err) {
      return buildDashboardV2Error(area, 'PG_ERROR', `PostgreSQL-Abfrage fehlgeschlagen: ${err.message}`);
    }
  }

  if (area === 'assortment-slots') {
    try {
      const pgRows = await queryAssortmentSlotsPg(pgUrl, query);
      const data = buildAssortmentSlotsData(pgRows, query);
      const now = new Date();
      return {
        status: 200,
        body: {
          ok: true,
          area,
          source: 'postgres',
          generatedAt: now.toISOString(),
          generatedAtDisplay: formatBerlinDateTime(now),
          lastSuccessfulAt: now.toISOString(),
          lastSuccessfulAtDisplay: formatBerlinDateTime(now),
          data,
          error: null,
        },
      };
    } catch (err) {
      return buildDashboardV2Error(area, 'PG_ERROR', `PostgreSQL-Abfrage fehlgeschlagen: ${err.message}`);
    }
  }

  return buildDashboardV2Error(
    area,
    'PG_READER_NOT_AVAILABLE',
    'PostgreSQL ist konfiguriert, aber der Dashboard-v2-PG-Reader ist fuer diesen Bereich noch nicht verbunden.',
  );
}

function normalizeNumber(value) {
  const n = Number(clean(value).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function mdbNorm(value) {
  const s = clean(value).replace(',', '.');
  return /^\d+\.0+$/.test(s) ? String(parseInt(s, 10)) : s;
}

function isActive(value) {
  return ['TRUE', '1', 'JA', 'YES', 'AKTIV', 'ACTIVE'].includes(clean(value).toUpperCase());
}

function formatIsoStamp(value) {
  const raw = clean(value);
  if (!raw) {
    return `BACKFILL_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  }

  const excelSerial = Number(raw.replace(',', '.'));
  const parsedDate = Number.isFinite(excelSerial) && excelSerial > 20000
    ? new Date((excelSerial - 25569) * 86400 * 1000)
    : new Date(raw);

  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }

  return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
}

function productSlotId(row) {
  return [
    'PS',
    clean(row.machine_id),
    mdbNorm(row.mdb_code),
    clean(row.product_key),
    formatIsoStamp(row.valid_from_datetime || row.valid_from),
  ].join('_');
}

function parseDate(value) {
  const text = clean(value);
  if (!text) return null;

  const serial = Number(text.replace(',', '.'));
  if (Number.isFinite(serial) && serial > 20000) {
    return new Date((serial - 25569) * 86400 * 1000);
  }

  const de = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (de) {
    return new Date(Date.UTC(Number(de[3]), Number(de[2]) - 1, Number(de[1])));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => clean(cell))) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(clean);
  return rows.slice(1)
    .filter((row) => row.some((cell) => clean(cell)))
    .map((row, index) => {
      const out = { row_number: index + 2 };
      headers.forEach((header, i) => {
        if (header) out[header] = row[i] ?? '';
      });
      return out;
    });
}

function daysUntil(date) {
  const now = new Date();
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.ceil((b - a) / 86400000);
}

function guvDateRange(zeitraum, von, bis) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  if (zeitraum === 'woche') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { von: start.toISOString().slice(0, 10), bis: todayStr };
  }
  if (zeitraum === 'monat') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { von: start.toISOString().slice(0, 10), bis: todayStr };
  }
  if (zeitraum === 'quartal') {
    const start = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    return { von: start.toISOString().slice(0, 10), bis: todayStr };
  }
  const defaultVon = (() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  })();
  return { von: von || defaultVon, bis: bis || todayStr };
}

function readJson(fileName) {
  const fullPath = path.join(ROOT, fileName);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, ''));
}

function findLatestWorkbookFile() {
  const candidates = fs.readdirSync(ROOT)
    .filter((fileName) => workbookFilePattern.test(fileName))
    .map((fileName) => ({
      fileName,
      mtimeMs: fs.statSync(path.join(ROOT, fileName)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.fileName || '';
}

function nodeNames(workflow) {
  return (workflow.nodes || []).map((node) => node.name || '');
}

function getSetValue(node, key) {
  const assignments = node?.parameters?.assignments?.assignments || [];
  const found = assignments.find((item) => item.name === key);
  return found ? found.value : undefined;
}

function summarizeWorkflow(fileName) {
  const fullPath = path.join(ROOT, fileName);
  const stat = fs.statSync(fullPath);
  const workflow = readJson(fileName);
  const nodes = workflow.nodes || [];
  const names = nodeNames(workflow);
  const codeNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.code');
  const aggregateCodeNodes = codeNodes.filter((node) => {
    const nodeCode = clean(node.parameters?.jsCode);
    return nodeCode.includes('.first()') || nodeCode.includes('$items(');
  });
  const googleNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.googleSheets');
  const executeNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.executeWorkflow');
  const mailNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.emailSend');
  const triggerNodes = nodes.filter((node) => /trigger/i.test(node.type || ''));
  const codeModesOk = aggregateCodeNodes.every((node) => node.parameters?.mode === 'runOnceForAllItems');
  const js = codeNodes.map((node) => clean(node.parameters?.jsCode)).join('\n');
  const title = workflow.name || fileName.replace(/\.json$/i, '');

  const checks = [];
  const addCheck = (label, ok, detail) => checks.push({ label, ok, detail });

  if (title.startsWith('WF0')) {
    const config = nodes.find((node) => node.name === 'Config - WF0');
    const updateNode = nodes.find((node) => node.name === 'Google Sheets - product_slot_id aktualisieren');
    addCheck('Backfill nur manuell', names.includes('Manual Trigger'), 'keine automatische Aktivierung');
    addCheck('Matching per row_number', updateNode?.parameters?.columns?.matchingColumns?.includes('row_number'), 'sicherer als product_key');
    addCheck('Testmodus aktiv', Number(getSetValue(config, 'max_updates')) === 2, 'max_updates = 2');
  }

  if (title.startsWith('WF1')) {
    addCheck('WF2-Start vorbereitet', names.some((name) => name.includes('WF2 Start')) && executeNodes.length > 0, 'Rechnung nach Pruefung an WF2');
  }

  if (title.startsWith('WF2')) {
    addCheck('Slotdaten nicht blind setzen', js.includes('slot_direct_assignment') || js.includes('product_direct_slot_assignment'), 'WF4 wird optional gestartet');
    addCheck('WF4 optional angebunden', executeNodes.some((node) => clean(node.name).includes('WF4')), 'Slotfreigabe bleibt in WF4');
  }

  if (title.startsWith('WF3')) {
    addCheck('WF4-Integration vorhanden', names.some((name) => name.includes('WF4')), 'MDB-Abweichung kann WF4 vorbereiten');
    addCheck('MDB bleibt Kontrollsignal', js.includes('MDB_CODE_CHANGED_FOR_PRODUCT') || js.includes('mdb'), 'ProductName bleibt fuehrend');
  }

  if (title.startsWith('WF4')) {
    addCheck('Vorhandene WF2-Zeile ergaenzen', names.includes('Google Sheets - Vorhandene Produktzeilen ergänzen'), 'keine neue Dublette bei slotloser Basiszeile');
    addCheck('Doppelte aktive Slots geblockt', js.includes('WF4_SLOT_ALREADY_ACTIVE'), 'erneuter Lauf erzeugt keine zweite aktive Slotzeile');
  }

  if (title.startsWith('WF5')) {
    addCheck('GMX-Zusammenfassung', mailNodes.some((node) => clean(node.name).includes('GMX')), 'Mail nach jedem MHD-/Lagercheck');
    addCheck('MHD und Bestand gekoppelt', js.includes('MHD_WITHIN_30_DAYS_LOW_BATCH_STOCK'), 'MHD <= 30 Tage und Restbestand < 5');
  }

  if (title.startsWith('WF7')) {
    addCheck('Webhook-Trigger', nodes.some((node) => node.type === 'n8n-nodes-base.webhook'), 'Manueller Nachfüllung-Aufruf per GET');
    addCheck('Produkte-Update', googleNodes.length > 0, 'current_machine_qty und Slot-Bestand aktualisieren');
  }

  if (title.startsWith('WF8')) {
    addCheck('Schedule-Trigger', nodes.some((node) => node.type === 'n8n-nodes-base.scheduleTrigger'), 'Tägl. 02:00 Aggregation');
    addCheck('GuV-Append', googleNodes.some((node) => clean(node.name).toLowerCase().includes('guv')), 'GuV_Tagesposten befüllen');
  }

  if (title.startsWith('WF9')) {
    addCheck('Drive-Trigger', nodes.some((node) => node.type === 'n8n-nodes-base.googleDriveTrigger'), 'Auto-Trigger bei neuer Pickliste');
    addCheck('Idempotenz-Schutz', js.includes('PICKLISTE_VERARBEITET'), 'Verhindert Doppelverarbeitung');
  }

  if (aggregateCodeNodes.length) {
    addCheck('Aggregierende Code-Nodes', codeModesOk, `${aggregateCodeNodes.length} Node(s) mit .first() oder $items(...)`);
  }

  return {
    fileName,
    title,
    active: Boolean(workflow.active),
    updatedAt: stat.mtime.toISOString(),
    nodeCount: nodes.length,
    connectionCount: Object.keys(workflow.connections || {}).length,
    triggerCount: triggerNodes.length,
    codeNodeCount: codeNodes.length,
    googleNodeCount: googleNodes.length,
    executeNodeCount: executeNodes.length,
    mailNodeCount: mailNodes.length,
    codeModesOk,
    triggers: triggerNodes.map((node) => node.name),
    integrations: executeNodes.map((node) => node.name),
    checks,
  };
}

function summarizeN8nWorkflow(workflow) {
  const nodes = workflow.nodes || [];
  const codeNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.code');
  const aggregateCodeNodes = codeNodes.filter((node) => {
    const nodeCode = clean(node.parameters?.jsCode);
    return nodeCode.includes('.first()') || nodeCode.includes('$items(');
  });
  const triggerNodes = nodes.filter((node) => /trigger/i.test(node.type || ''));
  const formTriggerNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.formTrigger');
  const webhookNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.webhook');
  const googleNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.googleSheets');
  const executeNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.executeWorkflow');
  const mailNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.emailSend');

  return {
    id: clean(workflow.id),
    name: clean(workflow.name),
    active: Boolean(workflow.active),
    updatedAt: workflow.updatedAt || workflow.createdAt || '',
    nodeCount: nodes.length,
    triggerCount: triggerNodes.length,
    codeNodeCount: codeNodes.length,
    aggregateCodeNodesOk: aggregateCodeNodes.every((node) => node.parameters?.mode === 'runOnceForAllItems'),
    aggregateCodeNodeCount: aggregateCodeNodes.length,
    googleNodeCount: googleNodes.length,
    executeNodeCount: executeNodes.length,
    mailNodeCount: mailNodes.length,
    formTriggers: formTriggerNodes.map((node) => ({
      name: clean(node.name),
      formTitle: clean(node.parameters?.formTitle),
      formPath: clean(node.parameters?.options?.path || node.parameters?.options?.formPath || node.parameters?.path || node.parameters?.formPath || node.webhookId),
    })),
    webhooks: webhookNodes.map((node) => ({
      name: clean(node.name),
      path: clean(node.parameters?.path || node.webhookId),
      // n8n Webhook default httpMethod ist GET (typeVersion 2+)
      method: clean(node.parameters?.httpMethod || 'GET').toUpperCase(),
    })),
    tags: (workflow.tags || []).map((tag) => clean(tag.name || tag)).filter(Boolean),
  };
}

const workflowActions = [
  {
    id: 'invoice-intake',
    label: 'Rechnungseingang starten',
    shortLabel: 'Rechnungseingang',
    description: 'Neue Rechnungen einlesen, prüfen und Vorschlagsprozess vorbereiten.',
    workflowName: /^WF1 - Rechnungseingang automatisch mit Claude$/i,
    preferredTrigger: 'webhook',
  },
  {
    id: 'invoice-approval',
    label: 'Rechnungsvorschlag bearbeiten',
    shortLabel: 'Vorschlag prüfen',
    description: 'Den nächsten offenen Rechnungsvorschlag per Formular freigeben oder ablehnen.',
    workflowName: /^WF2 - Smart Product Selection - Rechnungsvorschlaege freigeben$/i,
    preferredTrigger: 'form',
  },
  {
    id: 'sales-fifo',
    label: 'Nayax-Verkäufe verarbeiten',
    shortLabel: 'Verkäufe/FIFO',
    description: 'Nayax-Verkäufe abrufen, FIFO abbuchen und MDB-Kontrollhinweise erzeugen.',
    workflowName: /^WF3 Nayax Lynx FIFO Lagerbestand - manueller Abruf$/i,
    preferredTrigger: 'webhook',
  },
  {
    id: 'slot-assignment',
    label: 'MDB-/Produktzuordnung bearbeiten',
    shortLabel: 'Slot-Zuordnung',
    description: 'Produkt-, MDB- und Slotwechsel historisiert prüfen und freigeben.',
    workflowName: /^WF4 - MDB Produktzuordnung bearbeiten$/i,
    preferredTrigger: 'form',
  },
  {
    id: 'mhd-stock-check',
    label: 'MHD & Lagerbestand prüfen',
    shortLabel: 'MHD-Check',
    description: 'Kritische MHD-/Restbestandsfälle prüfen, loggen und Mailzusammenfassung senden.',
    workflowName: /^WF5 - MHD und niedrige Lagercharge ueberwachen$/i,
    preferredTrigger: 'webhook',
  },
];

function workflowEditorUrl(baseUrl, workflowId) {
  return workflowId ? `${baseUrl}/workflow/${workflowId}` : '';
}

function firstProductionWebhookUrl(baseUrl, workflow) {
  const webhook = (workflow.webhooks || []).find((node) => node.path);
  if (!webhook || !workflow.active) return '';
  return `${baseUrl}/webhook/${encodeURIComponent(webhook.path)}`;
}

function firstProductionWebhook(workflow) {
  // Liefert den ersten aktiven Webhook-Node inkl. method, damit der Trigger korrekt aufgerufen wird.
  if (!workflow?.active) return null;
  return (workflow.webhooks || []).find((node) => node.path) || null;
}

function firstFormUrl(baseUrl, workflow) {
  const form = (workflow.formTriggers || []).find((node) => node.formPath);
  if (!form || !workflow.active) return '';
  return `${baseUrl}/form/${encodeURIComponent(form.formPath)}`;
}

function pickWorkflowForAction(workflows, matcher) {
  const matches = workflows
    .filter((workflow) => matcher.test(workflow.name))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
  return matches[0] || null;
}

function buildWorkflowActions(n8n) {
  const baseUrl = n8n.baseUrl || dashboardConfig().n8nBaseUrl;
  return workflowActions.map((action) => {
    const workflow = pickWorkflowForAction(n8n.workflows || [], action.workflowName);
    const editorUrl = workflowEditorUrl(baseUrl, workflow?.id);
    const webhookUrl = workflow ? firstProductionWebhookUrl(baseUrl, workflow) : '';
    const webhookNode = workflow ? firstProductionWebhook(workflow) : null;
    const webhookMethod = webhookNode?.method || 'GET';
    const formUrl = workflow ? firstFormUrl(baseUrl, workflow) : '';
    const hasWebhook = Boolean(workflow?.webhooks?.length);
    const hasForm = Boolean(workflow?.formTriggers?.length);
    let triggerType = 'unavailable';
    let runnable = false;
    let status = 'Workflow nicht gefunden';
    let primaryUrl = '';
    let primaryMethod = 'POST';

    if (workflow) {
      status = workflow.active ? 'Workflow gefunden, aber kein externer Trigger konfiguriert' : 'Workflow ist in n8n inaktiv';
      if (action.preferredTrigger === 'form' && formUrl) {
        triggerType = 'form';
        runnable = true;
        primaryUrl = formUrl;
        status = 'Formular kann geöffnet werden';
      } else if (webhookUrl) {
        triggerType = 'webhook';
        runnable = true;
        primaryUrl = webhookUrl;
        primaryMethod = webhookMethod;
        status = `Webhook kann ausgelöst werden (${webhookMethod})`;
      } else if (hasForm && !workflow.active) {
        triggerType = 'form';
        status = 'Form-Trigger vorhanden, aber Workflow ist inaktiv';
      } else if (hasForm && !formUrl) {
        triggerType = 'form';
        status = 'Form-Trigger vorhanden, aber kein fester Form Path gesetzt';
      } else if (hasWebhook && !workflow.active) {
        triggerType = 'webhook';
        status = 'Webhook vorhanden, aber Workflow ist inaktiv';
      } else if (!hasWebhook && !hasForm) {
        status = 'Nur manuell/Execute-Trigger: Dashboard-Start braucht Webhook oder Dispatcher';
      }
    }

    return {
      ...action,
      workflowId: workflow?.id || '',
      workflowName: workflow?.name || '',
      workflowActive: Boolean(workflow?.active),
      triggerType,
      runnable,
      status,
      primaryUrl,
      primaryMethod,
      editorUrl,
      formTriggers: workflow?.formTriggers || [],
      webhooks: workflow?.webhooks || [],
    };
  });
}

async function fetchN8nWorkflows() {
  const config = dashboardConfig();
  const base = config.n8nBaseUrl;

  if (!config.n8nApiKey) {
    return {
      source: 'n8n_api',
      baseUrl: base,
      status: 'missing_api_key',
      message: 'n8n API ist erreichbar, aber N8N_API_KEY ist im Dashboard nicht gesetzt.',
      workflows: [],
    };
  }

  const response = await fetch(`${base}/api/v1/workflows?limit=100`, {
    headers: {
      accept: 'application/json',
      'X-N8N-API-KEY': config.n8nApiKey,
    },
  });

  if (response.status === 401 || response.status === 403) {
    return {
      source: 'n8n_api',
      baseUrl: base,
      status: 'unauthorized',
      message: 'n8n API-Key wurde abgelehnt.',
      workflows: [],
    };
  }

  if (!response.ok) {
    return {
      source: 'n8n_api',
      baseUrl: base,
      status: 'error',
      message: `n8n API antwortet mit HTTP ${response.status}.`,
      workflows: [],
    };
  }

  const payload = await response.json();
  const workflowRows = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.workflows)
      ? payload.workflows
      : Array.isArray(payload)
        ? payload
        : [];

  return {
    source: 'n8n_api',
    baseUrl: base,
    status: 'ok',
    message: `${workflowRows.length} Workflow(s) live aus n8n gelesen.`,
    workflows: workflowRows.map(summarizeN8nWorkflow),
  };
}

function decodeXml(value) {
  return clean(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
  let match;
  while ((match = re.exec(tag))) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function columnIndex(ref) {
  const letters = clean(ref).replace(/[^A-Za-z]/g, '').toUpperCase();
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('XLSX ZIP central directory not found');
}

function readZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let offset = centralOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);
    entries.set(fileName, { method, compressedSize, localOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return {
    getText(name) {
      const entry = entries.get(name);
      if (!entry) return '';
      const local = entry.localOffset;
      if (buffer.readUInt32LE(local) !== 0x04034b50) return '';
      const fileNameLength = buffer.readUInt16LE(local + 26);
      const extraLength = buffer.readUInt16LE(local + 28);
      const dataOffset = local + 30 + fileNameLength + extraLength;
      const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
      const inflated = entry.method === 8 ? zlib.inflateRawSync(compressed) : compressed;
      return inflated.toString('utf8');
    },
    has(name) {
      return entries.has(name);
    },
  };
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const values = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let si;
  while ((si = siRe.exec(xml))) {
    const parts = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(si[1]))) {
      parts.push(decodeXml(t[1]));
    }
    values.push(parts.join(''));
  }
  return values;
}

function workbookSheets(zip) {
  const workbook = zip.getText('xl/workbook.xml');
  const rels = zip.getText('xl/_rels/workbook.xml.rels');
  const relMap = {};
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rel;
  while ((rel = relRe.exec(rels))) {
    const attrs = parseAttrs(rel[1]);
    if (attrs.Id && attrs.Target) relMap[attrs.Id] = attrs.Target;
  }

  const sheets = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sheet;
  while ((sheet = sheetRe.exec(workbook))) {
    const attrs = parseAttrs(sheet[1]);
    const target = relMap[attrs['r:id']];
    if (!attrs.name || !target) continue;
    const normalizedTarget = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    sheets.push({ name: attrs.name, path: normalizedTarget.replace(/\\/g, '/') });
  }
  return sheets;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const row = [];
    const rowXml = rowMatch[1].replace(/<c\b([^>]*)\/>/g, '<c$1></c>');
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowXml))) {
      const attrs = parseAttrs(cellMatch[1]);
      const index = columnIndex(attrs.r || '');
      if (index < 0) continue;
      while (row.length <= index) row.push('');

      let value = '';
      if (attrs.t === 'inlineStr') {
        const texts = [];
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(cellMatch[2]))) texts.push(decodeXml(t[1]));
        value = texts.join('');
      } else {
        const v = cellMatch[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        value = v ? decodeXml(v[1]) : '';
        if (attrs.t === 's') value = sharedStrings[Number(value)] ?? '';
      }
      row[index] = value;
    }
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map(clean);
  return rows.slice(1).map((row, index) => {
    const out = { row_number: index + 2 };
    headers.forEach((header, i) => {
      if (header) out[header] = row[i] ?? '';
    });
    return out;
  });
}

function readWorkbook(fileName) {
  if (!fileName) return { sheets: {}, error: 'Workbook not found', source: 'local_xlsx', fileName: '' };
  const filePath = path.join(ROOT, fileName);
  if (!fs.existsSync(filePath)) return { sheets: {}, error: 'Workbook not found' };
  const zip = readZipEntries(filePath);
  const sharedStrings = parseSharedStrings(zip.getText('xl/sharedStrings.xml'));
  const sheets = {};
  for (const sheet of workbookSheets(zip)) {
    const xml = zip.getText(sheet.path);
    sheets[sheet.name] = parseSheet(xml, sharedStrings);
  }
  return {
    sheets,
    fileName,
    updatedAt: fs.statSync(filePath).mtime.toISOString(),
    source: 'local_xlsx',
    url: '',
  };
}

async function fetchLiveSheet(sheetName) {
  const endpoint = `https://docs.google.com/spreadsheets/d/${googleSheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&cacheBust=${Date.now()}`;
  const response = await fetch(endpoint, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Automatenlager-Dashboard/0.1',
    },
  });
  const text = await response.text();
  const looksLikeHtml = /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text);

  if (!response.ok || looksLikeHtml) {
    throw new Error(`${sheetName}: Google Sheets CSV nicht erreichbar. Sheet muss fuer Link-Betrachter lesbar sein oder per API angebunden werden.`);
  }

  return rowsToObjects(parseCsv(text));
}

async function readGoogleSheetsLive() {
  const sheets = {};
  const errors = [];

  for (const sheetName of liveSheetNames) {
    try {
      sheets[sheetName] = await fetchLiveSheet(sheetName);
    } catch (error) {
      sheets[sheetName] = [];
      errors.push(error.message);
    }
  }

  if (!sheets.Produkte.length || !sheets.Lagerchargen.length) {
    throw new Error(errors[0] || 'Google Sheets Live-Daten konnten nicht gelesen werden.');
  }

  return {
    sheets,
    fileName: 'Google Sheets live',
    updatedAt: new Date().toISOString(),
    source: 'google_sheets_live',
    url: googleSheetUrl,
    errors,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].map(([key, items]) => ({ key, items }));
}

function summarizeWorkbook(workbook) {
  const products = workbook.sheets.Produkte || [];
  const batches = workbook.sheets.Lagerchargen || [];
  const hints = workbook.sheets.Fehler_und_Hinweise || [];
  const productKeys = new Set(products.map((row) => clean(row.product_key)).filter(Boolean));
  const productByKey = new Map(products.map((row) => [clean(row.product_key), row]));

  const activeProducts = products.filter((row) => isActive(row.active));
  const backfillCandidates = activeProducts
    .filter((row) => clean(row.product_key) && clean(row.machine_id) && clean(row.mdb_code) && !clean(row.product_slot_id))
    .map((row) => ({
      row_number: row.row_number,
      product_key: clean(row.product_key),
      name: clean(row.nayax_product_name || row.internal_product_name || row.product_key),
      machine_id: clean(row.machine_id),
      mdb_code: mdbNorm(row.mdb_code),
      valid_from: clean(row.valid_from_datetime || row.valid_from),
      proposed_product_slot_id: productSlotId(row),
    }));

  const duplicateActiveSlots = groupBy(activeProducts, (row) => `${clean(row.machine_id)}|${mdbNorm(row.mdb_code)}`)
    .filter((group) => group.items.length > 1)
    .map((group) => ({
      slot: group.key.replace('|', ' / MDB '),
      count: group.items.length,
      product_keys: group.items.map((row) => clean(row.product_key)).join(', '),
      rows: group.items.map((row) => row.row_number),
    }));

  const duplicateProductKeys = groupBy(products, (row) => clean(row.product_key))
    .filter((group) => group.items.length > 1)
    .map((group) => ({
      product_key: group.key,
      count: group.items.length,
      rows: group.items.map((row) => row.row_number),
      active_count: group.items.filter((row) => isActive(row.active)).length,
    }));

  const activeBatches = batches.filter((row) => ['AKTIV', 'ACTIVE'].includes(clean(row.status).toUpperCase()));
  const lowBatches = activeBatches.filter((row) => {
    const remaining = normalizeNumber(row.remaining_qty);
    return Number.isFinite(remaining) && remaining < 5;
  });

  const inventoryAlerts = [];
  for (const batch of lowBatches) {
    const mhd = parseDate(batch.mhd);
    if (!mhd) continue;
    const left = daysUntil(mhd);
    if (left > 30) continue;
    const productKey = clean(batch.product_key);
    const product = productByKey.get(productKey) || {};
    inventoryAlerts.push({
      severity: left < 0 ? 'critical' : 'warning',
      batch_id: clean(batch.batch_id),
      product_key: productKey,
      name: clean(product.nayax_product_name || product.internal_product_name || productKey),
      remaining_qty: clean(batch.remaining_qty),
      mhd: mhd.toISOString().slice(0, 10),
      days_left: left,
      storage_location: clean(batch.storage_location),
    });
  }

  const orphanBatches = activeBatches
    .filter((row) => clean(row.product_key) && !productKeys.has(clean(row.product_key)))
    .map((row) => ({
      row_number: row.row_number,
      batch_id: clean(row.batch_id),
      product_key: clean(row.product_key),
      remaining_qty: clean(row.remaining_qty),
    }));

  const unresolvedHints = hints.filter((row) => !['TRUE', '1', 'JA', 'YES'].includes(clean(row.resolved).toUpperCase()));

  return {
    fileName: workbook.fileName,
    updatedAt: workbook.updatedAt,
    source: workbook.source || 'unknown',
    url: workbook.url || '',
    sourceErrors: workbook.errors || [],
    fallbackReason: workbook.fallbackReason || '',
    sheets: Object.fromEntries(Object.entries(workbook.sheets).map(([name, rows]) => [name, rows.length])),
    metrics: {
      products: products.length,
      activeProducts: activeProducts.length,
      activeBatches: activeBatches.length,
      unresolvedHints: unresolvedHints.length,
      backfillCandidates: backfillCandidates.length,
      duplicateActiveSlots: duplicateActiveSlots.length,
      duplicateProductKeys: duplicateProductKeys.length,
      lowBatches: lowBatches.length,
      inventoryAlerts: inventoryAlerts.length,
      orphanBatches: orphanBatches.length,
    },
    backfillCandidates: backfillCandidates.slice(0, 12),
    duplicateActiveSlots: duplicateActiveSlots.slice(0, 12),
    duplicateProductKeys: duplicateProductKeys.slice(0, 12),
    inventoryAlerts: inventoryAlerts.slice(0, 20),
    orphanBatches: orphanBatches.slice(0, 12),
  };
}

async function buildDashboard() {
  const workflows = workflowFiles
    .filter((fileName) => fs.existsSync(path.join(ROOT, fileName)))
    .map(summarizeWorkflow);
  let n8n;
  try {
    n8n = await fetchN8nWorkflows();
  } catch (error) {
    n8n = {
      source: 'n8n_api',
      baseUrl: dashboardConfig().n8nBaseUrl,
      status: 'unreachable',
      message: error.message,
      workflows: [],
    };
  }
  let workbookSource;
  try {
    workbookSource = await readGoogleSheetsLive();
  } catch (error) {
    workbookSource = readWorkbook(findLatestWorkbookFile());
    workbookSource.fallbackReason = error.message;
  }
  const workbook = summarizeWorkbook(workbookSource);
  const allChecks = workflows.flatMap((workflow) => workflow.checks);
  const actions = buildWorkflowActions(n8n);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot: ROOT,
    workflows,
    n8n,
    actions,
    workbook,
    overview: {
      workflowCount: workflows.length,
      n8nWorkflowCount: n8n.workflows.length,
      codeModesOk: workflows.every((workflow) => workflow.codeModesOk),
      checksOk: allChecks.filter((check) => check.ok).length,
      checksTotal: allChecks.length,
      dataSource: workbook.source,
      immediateActions: [
        workbook.fallbackReason ? `Live-Daten nicht erreichbar: lokale XLSX aktiv` : '',
        actions.some((action) => action.workflowId && !action.runnable) ? `${actions.filter((action) => action.workflowId && !action.runnable).length} Workflow-Aktion(en) brauchen Webhook/Form-Path/Aktivierung` : '',
        workbook.metrics.backfillCandidates ? `${workbook.metrics.backfillCandidates} aktive Produktzeilen ohne product_slot_id` : '',
        workbook.metrics.inventoryAlerts ? `${workbook.metrics.inventoryAlerts} MHD-/Lagerwarnungen` : '',
        workbook.metrics.duplicateActiveSlots ? `${workbook.metrics.duplicateActiveSlots} doppelte aktive Slotbelegung(en)` : '',
        workbook.metrics.orphanBatches ? `${workbook.metrics.orphanBatches} Lagercharge(n) ohne Produktstamm` : '',
      ].filter(Boolean),
    },
  };
}

async function buildGuv(query) {
  const zeitraum = clean(query.zeitraum) || 'monat';
  const maschine = clean(query.maschine);
  const { von, bis } = guvDateRange(zeitraum, clean(query.von), clean(query.bis));

  let rows, source, sourceError;
  try {
    rows = await fetchLiveSheet('GuV_Tagesposten');
    source = 'google_sheets_live';
  } catch (err) {
    const wb = readWorkbook(findLatestWorkbookFile());
    rows = (wb.sheets && wb.sheets.GuV_Tagesposten) || [];
    source = 'local_xlsx';
    sourceError = err.message;
  }

  const machineSet = new Set();
  for (const row of rows) {
    const m = clean(row.machine_id);
    if (m) machineSet.add(m);
  }

  const filtered = rows.filter((row) => {
    const d = clean(row.date);
    if (!d || d < von || d > bis) return false;
    if (maschine && clean(row.machine_id) !== maschine) return false;
    return true;
  });

  let totalUmsatz = 0;
  let totalWareneinsatz = 0;
  let totalGuv = 0;
  let totalQty = 0;
  let parseWarnings = 0;
  const productMap = new Map();

  for (const row of filtered) {
    const u = normalizeNumber(row.umsatz_brutto);
    const w = normalizeNumber(row.wareneinsatz_brutto);
    const g = normalizeNumber(row.guv);
    const q = normalizeNumber(row.quantity_sold);
    if (!Number.isFinite(u) || !Number.isFinite(w) || !Number.isFinite(g)) parseWarnings += 1;
    totalUmsatz       += Number.isFinite(u) ? u : 0;
    totalWareneinsatz += Number.isFinite(w) ? w : 0;
    totalGuv          += Number.isFinite(g) ? g : 0;
    totalQty          += Number.isFinite(q) ? q : 0;

    const pk = clean(row.product_key);
    if (!pk) continue;
    if (!productMap.has(pk)) {
      productMap.set(pk, {
        product_key: pk,
        nayax_product_name: clean(row.nayax_product_name),
        produktart: clean(row.produktart),
        quantity_sold: 0,
        umsatz_brutto: 0,
        wareneinsatz_brutto: 0,
        guv: 0,
      });
    }
    const p = productMap.get(pk);
    p.quantity_sold       += Number.isFinite(q) ? q : 0;
    p.umsatz_brutto       += Number.isFinite(u) ? u : 0;
    p.wareneinsatz_brutto += Number.isFinite(w) ? w : 0;
    p.guv                 += Number.isFinite(g) ? g : 0;
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const margePct = (g, u) => (u > 0 ? Math.round((g / u) * 1000) / 10 : null);

  const produkte = [...productMap.values()]
    .map((p) => ({
      ...p,
      umsatz_brutto: round2(p.umsatz_brutto),
      wareneinsatz_brutto: round2(p.wareneinsatz_brutto),
      guv: round2(p.guv),
      guv_marge_pct: margePct(p.guv, p.umsatz_brutto),
    }))
    .sort((a, b) => b.umsatz_brutto - a.umsatz_brutto);

  return {
    von,
    bis,
    zeitraum,
    maschine: maschine || 'alle',
    source,
    sourceError: sourceError || '',
    kpis: {
      umsatz_brutto: round2(totalUmsatz),
      wareneinsatz_brutto: round2(totalWareneinsatz),
      guv: round2(totalGuv),
      quantity_sold: Math.round(totalQty),
      guv_marge_pct: margePct(totalGuv, totalUmsatz),
    },
    maschinen: [...machineSet].sort(),
    produkte,
    rowCount: filtered.length,
    totalRows: rows.length,
    parseWarnings,
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendFile(res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  try {
    if (parsed.pathname === '/api/dashboard') {
      const viewer = getViewer(req);
      auditGuestAccess(viewer, 'dashboard_view');
      const dashboard = await buildDashboard();
      sendJson(res, 200, {
        ...dashboard,
        viewer,
      });
      return;
    }

    const v2Area = [...dashboardV2Areas.entries()]
      .find(([, config]) => parsed.pathname === config.path);
    if (v2Area && req.method === 'GET') {
      const result = await buildDashboardV2Area(v2Area[0], parsed.query);
      sendJson(res, result.status, result.body);
      return;
    }

    // ── Refill routes ─────────────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/refill/search' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      const q = clean(parsed.query.q || '');
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, results: [], error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: pgUrl });
        await client.connect();
        const { rows } = await client.query(`
          SELECT
            sa.machine_id::text AS machine_id,
            m.name AS machine_label,
            sa.mdb_code,
            sa.product_id,
            p.name AS product_name,
            sa.current_machine_qty,
            sa.target_stock,
            sa.machine_capacity AS capacity,
            l.name AS location_name
          FROM automatenlager.slot_assignments sa
          JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
          JOIN automatenlager.locations l ON l.location_id = m.location_id
          JOIN automatenlager.products p ON p.product_id = sa.product_id
          WHERE sa.active = true
          ORDER BY p.name, sa.machine_id, sa.mdb_code
        `);
        await client.end();
        const results = searchRefillTargets(q, rows);
        sendJson(res, 200, { ok: true, results });
      } catch (err) {
        sendJson(res, 503, { ok: false, results: [], error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/refill/details' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      const machineId = clean(parsed.query.machine_id || '');
      const mdbCode = parseInt(clean(parsed.query.mdb_code || ''), 10);
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      if (!machineId || !mdbCode) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_PARAMS', message: 'machine_id und mdb_code erforderlich.' } });
        return;
      }
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: pgUrl });
        await client.connect();
        const slotResult = await client.query(`
          SELECT
            sa.machine_id::text AS machine_id,
            m.name AS machine_label,
            sa.mdb_code,
            sa.product_id,
            p.name AS product_name,
            sa.current_machine_qty,
            sa.target_stock,
            sa.machine_capacity AS capacity,
            l.name AS location_name
          FROM automatenlager.slot_assignments sa
          JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
          JOIN automatenlager.locations l ON l.location_id = m.location_id
          JOIN automatenlager.products p ON p.product_id = sa.product_id
          WHERE sa.machine_id = $1 AND sa.mdb_code = $2 AND sa.active = true
          LIMIT 1
        `, [machineId, mdbCode]);
        if (!slotResult.rows.length) {
          await client.end();
          sendJson(res, 404, { ok: false, error: { code: 'SLOT_NOT_FOUND', message: 'Slot nicht gefunden.' } });
          return;
        }
        const slotRow = slotResult.rows[0];
        const batchResult = await client.query(`
          SELECT batch_key, product_id, remaining_qty, mhd_date::text AS mhd_date, status, unit_cost_net::text AS unit_cost_net
          FROM automatenlager.stock_batches
          WHERE product_id = $1 AND remaining_qty > 0 AND status = 'aktiv'
          ORDER BY mhd_date ASC NULLS LAST
        `, [slotRow.product_id]);
        await client.end();
        const data = buildRefillDetails(slotRow, batchResult.rows, new Date());
        sendJson(res, 200, { ok: true, data });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/refill/trigger' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditGuestAccess(viewer, 'refill_trigger_denied', {});
        sendJson(res, 403, {
          ok: false,
          error: { code: 'READ_ONLY_FORBIDDEN', message: 'Read-Only-Benutzer duerfen keine Nachfuellung ausloesen.' },
        });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => { try { resolve(data); } catch (e) { reject(e); } });
          req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      const { machine_id, mdb_code, product_id, qty, product_name, notes } = body || {};
      if (!machine_id || !mdb_code || !product_id || !qty) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: 'machine_id, mdb_code, product_id, qty erforderlich.' } });
        return;
      }
      const cfg = dashboardConfig();
      const n8nBase = cfg.n8nBaseUrl;
      const qs = new URLSearchParams({
        source: 'automatenlager_dashboard_v2',
        machine_id: String(machine_id),
        mdb_code: String(Number(mdb_code)),
        product_id: String(Number(product_id)),
        product_name: String(product_name || ''),
        qty: String(Number(qty)),
        notes: String(notes || ''),
        triggered_by: viewer.login,
        triggered_at: new Date().toISOString(),
      }).toString();
      const webhookUrl = `${n8nBase}/webhook/nachfuellung?${qs}`;
      let wfResult = { ok: false, status_ref: null, message: '' };
      try {
        const wfResponse = await fetch(webhookUrl, { method: 'GET' });
        const wfText = await wfResponse.text();
        wfResult = {
          ok: wfResponse.ok,
          status_ref: `nachfuellung-${Date.now()}`,
          message: wfResponse.ok ? 'WF7 gestartet.' : `WF7 antwortete mit ${wfResponse.status}: ${wfText.slice(0, 200)}`,
        };
      } catch (err) {
        wfResult = { ok: false, status_ref: null, message: `Webhook nicht erreichbar: ${err.message}` };
      }
      const auditEntry = buildRefillAuditEntry(viewer, { machine_id, mdb_code, product_id, qty }, wfResult);
      const auditPath = path.join(__dirname, 'logs', 'refill-actions.jsonl');
      try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, `${JSON.stringify(auditEntry)}\n`, 'utf8');
      } catch { /* audit write failure must not block response */ }
      sendJson(res, wfResult.ok ? 200 : 502, {
        ok: wfResult.ok,
        status_ref: auditEntry.status_ref,
        message: wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'WF7_ERROR', message: wfResult.message } }),
      });
      return;
    }

    // ── Onboarding route ──────────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/onboarding' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, data: null, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL ist für das Onboarding-Panel nicht konfiguriert.' } });
        return;
      }
      const viewer = getViewer(req);
      const isAdmin = viewer.role === 'admin';
      try {
        const rawData = await queryProductOnboardingPg(pgUrl);
        const data = buildProductOnboardingData(rawData);
        let wf2FormUrl = '';
        try {
          const n8nBaseUrl = dashboardConfig().n8nBaseUrl;
          const workflows = workflowFiles
            .filter((fn) => fn.includes('WF2'))
            .map((fn) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, fn), 'utf8')); } catch { return null; } })
            .filter(Boolean);
          const wf2 = workflows[0];
          if (wf2?.active && wf2?.formTriggers?.length) {
            wf2FormUrl = `${n8nBaseUrl}/form/${encodeURIComponent(wf2.formTriggers[0].formPath)}`;
          }
        } catch { /* wf2 url optional */ }
        sendJson(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          generatedAtDisplay: new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }),
          data: { ...data, wf2_form_url: wf2FormUrl, is_admin: isAdmin },
        });
      } catch (err) {
        sendJson(res, 503, { ok: false, data: { is_admin: isAdmin }, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Slot-Change routes ────────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/slot-change/preview' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      const slotAssignmentId = clean(parsed.query.slot_assignment_id || '');
      const machineId = clean(parsed.query.machine_id || '');
      const mdbCode = parseInt(clean(parsed.query.mdb_code || ''), 10);
      if (!slotAssignmentId && (!machineId || !mdbCode)) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_PARAMS', message: 'slot_assignment_id oder machine_id+mdb_code erforderlich.' } });
        return;
      }
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
        await client.connect();
        const whereClause = slotAssignmentId
          ? 'sa.slot_assignment_id = $1'
          : 'sa.machine_id = $1 AND sa.mdb_code = $2 AND sa.active = true';
        const queryParams = slotAssignmentId ? [slotAssignmentId] : [machineId, mdbCode];
        const slotResult = await client.query(
          `SELECT sa.slot_assignment_id, sa.machine_id::text AS machine_id,
                  m.name AS machine_label, sa.mdb_code, sa.product_id,
                  p.name AS product_name, sa.current_machine_qty,
                  sa.target_stock, sa.machine_capacity,
                  l.name AS location_name
             FROM automatenlager.slot_assignments sa
             JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
             JOIN automatenlager.locations l ON l.location_id = m.location_id
             JOIN automatenlager.products p ON p.product_id = sa.product_id
            WHERE ${whereClause}
            LIMIT 1`,
          queryParams,
        );
        if (!slotResult.rows.length) {
          await client.end();
          sendJson(res, 404, { ok: false, error: { code: 'SLOT_NOT_FOUND', message: 'Slot nicht gefunden.' } });
          return;
        }
        const productResult = await client.query(
          'SELECT product_id, name FROM automatenlager.products WHERE active = true ORDER BY name',
        );
        await client.end();
        const preview = buildSlotChangePreview(slotResult.rows[0], productResult.rows);
        sendJson(res, 200, { ok: true, ...preview });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/slot-change/confirm' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditGuestAccess(viewer, 'slot_change_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Read-Only-Benutzer dürfen keinen Produktwechsel durchführen.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => { try { resolve(data); } catch (e) { reject(e); } });
          req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON.' } });
        return;
      }
      const { slot_assignment_id, machine_id, mdb_code, new_product_id, new_qty, start_date } = body || {};
      if (!machine_id || !mdb_code || !new_product_id || !start_date) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: 'machine_id, mdb_code, new_product_id, start_date erforderlich.' } });
        return;
      }
      const validation = validateSlotChange({ new_product_id, new_qty, start_date });
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: validation.errors.map((e) => e.message).join(' '), errors: validation.errors } });
        return;
      }
      const slotRow = { slot_assignment_id, machine_id, mdb_code: Number(mdb_code), product_id: 0 };
      const payload = buildSlotChangePayload(slotRow, { new_product_id, new_qty: Number(new_qty ?? 0), start_date });
      const webhookUrl = process.env.SLOT_CHANGE_WEBHOOK_URL;
      let wfResult = { ok: true, status_ref: `sc-${Date.now()}`, message: 'Payload protokolliert.' };
      if (webhookUrl) {
        try {
          const wfResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, triggered_by: viewer.login }),
          });
          const wfText = await wfResponse.text();
          wfResult = {
            ok: wfResponse.ok,
            status_ref: `sc-${Date.now()}`,
            message: wfResponse.ok ? 'Webhook erfolgreich.' : `Webhook antwortete ${wfResponse.status}: ${wfText.slice(0, 200)}`,
          };
        } catch (err) {
          wfResult = { ok: false, status_ref: null, message: `Webhook nicht erreichbar: ${err.message}` };
        }
      }
      const auditEntry = buildSlotChangeAuditEntry(viewer, payload, wfResult);
      const auditPath = path.join(__dirname, 'logs', 'slot-change-actions.jsonl');
      try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, `${JSON.stringify(auditEntry)}\n`, 'utf8');
      } catch { /* audit write failure must not block response */ }
      sendJson(res, wfResult.ok ? 200 : 502, {
        ok: wfResult.ok,
        status_ref: auditEntry.status_ref,
        message: wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'WEBHOOK_ERROR', message: wfResult.message } }),
      });
      return;
    }

    const v2ActionMatch = parsed.pathname.match(/^\/api\/v2\/actions\/([^/]+)\/trigger$/);
    if (v2ActionMatch && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditGuestAccess(viewer, 'v2_action_trigger_denied', {
          actionId: decodeURIComponent(v2ActionMatch[1]),
        });
        sendJson(res, 403, {
          ok: false,
          viewer,
          error: {
            code: 'READ_ONLY_FORBIDDEN',
            message: 'Read-Only-Benutzer duerfen keine Dashboard-v2-Aktionen ausloesen.',
          },
        });
        return;
      }

      sendJson(res, 501, {
        ok: false,
        viewer,
        actionId: decodeURIComponent(v2ActionMatch[1]),
        error: {
          code: 'V2_ACTION_NOT_IMPLEMENTED',
          message: 'Dashboard-v2-Aktionen werden in spaeteren Slices kontrolliert angebunden.',
        },
      });
      return;
    }

    if (parsed.pathname === '/api/v2/upload-capabilities' && req.method === 'GET') {
      const viewer = getViewer(req);
      sendJson(res, 200, {
        ok: true,
        ...buildV2UploadCapabilities(viewer),
      });
      return;
    }

    const v2UploadMatch = parsed.pathname.match(/^\/api\/v2\/uploads\/([^/]+)$/);
    if (v2UploadMatch && req.method === 'POST') {
      const viewer = getViewer(req);
      const routeTarget = clean(decodeURIComponent(v2UploadMatch[1])).toLowerCase();
      const targetConfig = dashboardV2UploadTargets[routeTarget];

      if (!targetConfig) {
        sendJson(res, 400, {
          ok: false,
          viewer,
          error: {
            code: 'TARGET_INVALID',
            message: 'Unbekannter Upload-Zieltyp. Erlaubt sind invoice oder picklist.',
          },
        });
        return;
      }

      if (!viewer.canTriggerActions) {
        auditGuestAccess(viewer, 'v2_upload_denied', { target: routeTarget });
        sendJson(res, 403, {
          ok: false,
          viewer,
          error: {
            code: 'READ_ONLY_FORBIDDEN',
            message: 'Read-Only-Benutzer duerfen keine Uploads ausfuehren.',
          },
        });
        return;
      }

      let rawBody;
      try {
        rawBody = await collectRawBody(req, DASHBOARD_V2_UPLOAD_BODY_LIMIT_BYTES);
      } catch (error) {
        if (error.code === 'BODY_TOO_LARGE') {
          sendJson(res, 413, {
            ok: false,
            viewer,
            target: routeTarget,
            error: {
              code: 'FILE_TOO_LARGE',
              message: 'Die Upload-Anfrage ist zu gross.',
            },
          });
          return;
        }
        throw error;
      }

      const contentType = clean(req.headers['content-type']);
      if (!/^multipart\/form-data/i.test(contentType)) {
        sendJson(res, 415, {
          ok: false,
          viewer,
          target: routeTarget,
          error: {
            code: 'CONTENT_TYPE_INVALID',
            message: 'Upload erwartet multipart/form-data.',
          },
        });
        return;
      }

      let parsedForm;
      let validatedFile;
      try {
        parsedForm = parseMultipartFormData(rawBody, contentType);
        validatedFile = validateV2Upload(targetConfig, parsedForm, routeTarget);
      } catch (error) {
        sendJson(res, error.status || 400, {
          ok: false,
          viewer,
          target: routeTarget,
          error: {
            code: error.code || 'UPLOAD_INVALID',
            message: error.message || 'Upload konnte nicht validiert werden.',
          },
        });
        return;
      }

      let n8n;
      try {
        n8n = await fetchN8nWorkflows();
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          viewer,
          target: routeTarget,
          upload: {
            fileName: validatedFile.fileName,
            mimeType: validatedFile.mimeType,
            sizeBytes: validatedFile.sizeBytes,
          },
          error: {
            code: 'N8N_UNREACHABLE',
            message: `n8n konnte nicht geladen werden: ${error.message}`,
          },
        });
        return;
      }

      const workflow = resolveV2UploadWorkflow(targetConfig, n8n);
      if (!workflow) {
        sendJson(res, 409, {
          ok: false,
          viewer,
          target: routeTarget,
          upload: {
            fileName: validatedFile.fileName,
            mimeType: validatedFile.mimeType,
            sizeBytes: validatedFile.sizeBytes,
          },
          error: {
            code: 'WORKFLOW_NOT_READY',
            message: 'Kein aktiver POST-Webhook fuer den Upload-Workflow gefunden.',
          },
        });
        return;
      }

      let forwardResponse;
      let forwardText = '';
      try {
        forwardResponse = await fetch(workflow.url, {
          method: workflow.method,
          headers: {
            'Content-Type': req.headers['content-type'],
            'Content-Length': String(rawBody.length),
          },
          body: rawBody,
        });
        forwardText = await forwardResponse.text();
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          viewer,
          target: routeTarget,
          upload: {
            fileName: validatedFile.fileName,
            mimeType: validatedFile.mimeType,
            sizeBytes: validatedFile.sizeBytes,
          },
          workflow: {
            id: workflow.id,
            name: workflow.name,
            method: workflow.method,
            webhookPath: workflow.webhookPath,
            status: 'failed',
          },
          error: {
            code: 'WORKFLOW_FORWARD_FAILED',
            message: `Upload konnte nicht an den Workflow uebergeben werden: ${error.message}`,
          },
        });
        return;
      }

      sendJson(res, forwardResponse.ok ? 200 : 502, {
        ok: forwardResponse.ok,
        viewer,
        target: routeTarget,
        upload: {
          fileName: validatedFile.fileName,
          mimeType: validatedFile.mimeType,
          sizeBytes: validatedFile.sizeBytes,
        },
        workflow: {
          id: workflow.id,
          name: workflow.name,
          method: workflow.method,
          webhookPath: workflow.webhookPath,
          status: forwardResponse.ok ? 'accepted' : 'error',
          responseStatus: forwardResponse.status,
          responsePreview: clean(forwardText).slice(0, 400),
        },
        error: forwardResponse.ok ? null : {
          code: 'WORKFLOW_REJECTED',
          message: `Workflow antwortete mit HTTP ${forwardResponse.status}.`,
        },
      });
      return;
    }

    // GET /api/config — gibt aktuelle Einstellungen zurueck (API-Key NIEMALS im Klartext)
    if (parsed.pathname === '/api/config' && req.method === 'GET') {
      const cfg = dashboardConfig();
      sendJson(res, 200, {
        n8nBaseUrl:    cfg.n8nBaseUrl,
        hasApiKey:     cfg.hasN8nApiKey,
        apiKeyMasked:  maskApiKey(cfg.n8nApiKey),
        source:        cfg.source,
      });
      return;
    }

    // POST /api/config — speichert Einstellungen in .dashboard-config.json
    if (parsed.pathname === '/api/config' && req.method === 'POST') {
      // Kein Speichern wenn der Key per Umgebungsvariable gesetzt ist
      if (process.env.N8N_API_KEY) {
        sendJson(res, 409, { ok: false, message: 'N8N_API_KEY ist als Umgebungsvariable gesetzt und hat Vorrang. Bitte dort aendern.' });
        return;
      }
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Ungültiges JSON')); }
        });
        req.on('error', reject);
      });
      const update = {};
      if (typeof body.n8nBaseUrl === 'string' && body.n8nBaseUrl.trim()) {
        update.n8nBaseUrl = body.n8nBaseUrl.trim().replace(/\/+$/, '');
      }
      if (typeof body.n8nApiKey === 'string' && body.n8nApiKey.trim()) {
        update.n8nApiKey = body.n8nApiKey.trim();
      }
      const saved = writeConfigFile(update);
      sendJson(res, 200, {
        ok:           true,
        n8nBaseUrl:   saved.n8nBaseUrl || dashboardConfig().n8nBaseUrl,
        hasApiKey:    Boolean(saved.n8nApiKey),
        apiKeyMasked: maskApiKey(saved.n8nApiKey || ''),
        source:       'config_file',
      });
      return;
    }

    const actionMatch = parsed.pathname.match(/^\/api\/actions\/([^/]+)\/trigger$/);
    if (actionMatch && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditGuestAccess(viewer, 'action_trigger_denied', {
          actionId: decodeURIComponent(actionMatch[1]),
        });
        sendJson(res, 403, {
          ok: false,
          message: 'Read-Only-Benutzer duerfen keine Workflows ausloesen.',
          viewer,
        });
        return;
      }

      const dashboard = await buildDashboard();
      const action = dashboard.actions.find((item) => item.id === decodeURIComponent(actionMatch[1]));

      if (!action) {
        sendJson(res, 404, { ok: false, message: 'Aktion nicht gefunden.' });
        return;
      }

      if (!action.runnable) {
        sendJson(res, 409, { ok: false, action, message: action.status });
        return;
      }

      if (action.triggerType === 'form') {
        sendJson(res, 200, { ok: true, mode: 'open', url: action.primaryUrl, action });
        return;
      }

      if (action.triggerType === 'webhook') {
        const method = (action.primaryMethod || 'GET').toUpperCase();
        const payload = {
          source: 'automatenlager_dashboard',
          action_id: action.id,
          workflow_id: action.workflowId,
          triggered_at: new Date().toISOString(),
        };
        // GET: query-string statt body. POST/PUT/PATCH: body.
        let url = action.primaryUrl;
        const init = { method, headers: {} };
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          init.headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(payload);
        } else {
          const qs = new URLSearchParams(payload).toString();
          url = url + (url.includes('?') ? '&' : '?') + qs;
        }
        let response, text;
        try {
          response = await fetch(url, init);
          text = await response.text();
        } catch (err) {
          sendJson(res, 502, {
            ok: false,
            mode: 'webhook',
            method,
            message: `Webhook-Aufruf fehlgeschlagen: ${err.message}`,
            action,
          });
          return;
        }
        sendJson(res, response.ok ? 200 : 502, {
          ok: response.ok,
          mode: 'webhook',
          method,
          status: response.status,
          response: text.slice(0, 1000),
          message: response.ok ? '' : `Webhook antwortete mit ${response.status}: ${text.slice(0, 200)}`,
          action,
        });
        return;
      }

      sendJson(res, 409, { ok: false, action, message: 'Diese Aktion ist noch nicht auslösbar.' });
      return;
    }

    // ── Reports export route ──────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/reports/export' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      const from = clean(parsed.query.from) || new Date().toISOString().slice(0, 7);
      const to   = clean(parsed.query.to)   || from;
      try {
        const rawData = await queryEconomicsPg(pgUrl, { from, to });
        const economicsData = buildEconomicsData(rawData, { from, to });
        const fields = [
          { key: 'product_name',  label: 'Produkt' },
          { key: 'revenue_net',   label: 'Umsatz (netto)' },
          { key: 'db_net',        label: 'Deckungsbeitrag' },
          { key: 'margin_pct',    label: 'Marge %' },
          { key: 'qty',           label: 'Menge' },
        ];
        const csv = buildCsvExport(economicsData.byProduct, fields);
        const filename = buildCsvFilename(from, to);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(csv);
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Locations routes ──────────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/locations' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const profiles = await queryLocationsPg(pgUrl);
        const kpiRows = [];
        const comparison = buildLocationComparison(profiles, kpiRows);
        sendJson(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          data: comparison,
        });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/locations' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können Standortprofile anlegen.' } });
        return;
      }
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      await new Promise((resolve) => req.on('end', resolve));
      try {
        const raw = JSON.parse(body);
        const profile = buildLocationProfile(raw);
        const saved = await upsertLocationPg(pgUrl, profile);
        sendJson(res, 200, { ok: true, data: saved });
      } catch (err) {
        if (err.message.match(/name|status/i)) {
          sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
        } else {
          sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
        }
      }
      return;
    }

    // ── Machine profiles routes ───────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/machine-profiles' && req.method === 'GET') {
      const viewer = getViewer(req);
      const options = getMachineOptions();
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), data: [], options, is_admin: viewer.canTriggerActions });
        return;
      }
      try {
        const data = await queryMachineProfilesPg(pgUrl);
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), data, options, is_admin: viewer.canTriggerActions });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/machine-profiles' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können Automaten-Profile anlegen.' } });
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      await new Promise((resolve) => req.on('end', resolve));
      try {
        const raw = JSON.parse(body);
        const profile = buildMachineProfile(raw);
        const pgUrl = dashboardV2PgUrl();
        if (!pgUrl) {
          sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
          return;
        }
        const saved = await upsertMachineProfilePg(pgUrl, profile);
        sendJson(res, 200, { ok: true, data: saved });
      } catch (err) {
        if (err.message.includes('machine_id')) {
          sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
        } else {
          sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
        }
      }
      return;
    }

    // ── Correction cases route ────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/correction-cases' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), cases: [], counts: { mdb_proposals: 0, unknown_products: 0, correction_warnings: 0, total: 0 } });
        return;
      }
      try {
        const raw = await queryCorrectionCasesPg(pgUrl);
        const { cases, counts } = buildCorrectionCases(raw);
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), cases, counts });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/guv') {
      sendJson(res, 200, await buildGuv(parsed.query));
      return;
    }

    const requestPath = parsed.pathname === '/'
      ? '/index.html'
      : parsed.pathname === '/v2'
        ? '/v2.html'
        : parsed.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, { error: error.message, stack: error.stack });
  }
});

server.listen(PORT, () => {
  console.log(`Automatenlager dashboard running at http://localhost:${PORT}`);
});
