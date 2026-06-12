const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const { buildEconomicsData, queryEconomicsPg, queryEconomicsProvisionalPg, formatProductName } = require('./lib/economics.js');
const { buildInventoryMhdData, queryInventoryMhdPg, toIsoDate } = require('./lib/inventory-mhd.js');
const { buildAssortmentSlotsData, queryAssortmentSlotsPg } = require('./lib/assortment-slots.js');
const { buildOverviewData, buildMonitoringData, queryOverviewMonitoringPg } = require('./lib/overview-monitoring.js');
const { buildAlertDigest, queryAlertDigestPg } = require('./lib/alert-digest.js');
const { searchRefillTargets, buildRefillDetails, validateRefillQty, buildRefillAuditEntry } = require('./lib/refill.js');
const { applyRefill } = require('./lib/refill-apply.js'); // #162 (Stufe 6 Slice 2): WF7 in-process durch die Tür
const { applyProductBatch } = require('./lib/jobs/invoice-intake.js'); // #163 (Stufe 6 Slice 3): WF2-Freigabe in-process durch die Tür
const { validateCorrection, applyEkCorrection, applyVkCorrection } = require('./lib/economics-correct.js'); // #193: VK/EK-Korrektur durch die Tür
const { validateBatchEkUpdate, applyBatchEkUpdate } = require('./lib/batch-ek-correction.js'); // #209: EK-Korrektur pro Lagercharge
const { availableBatchStatusSqlList } = require('./lib/stock-status.js');
const { validateWriteOff, buildWriteOffAuditEntry, writeOffBatchPg } = require('./lib/write-off.js'); // #138: writeOffBatchPg geht durch die Tür
const { validateInventoryCount, buildInventoryCountAuditEntry, setBatchCountPg } = require('./lib/inventory-count.js'); // #152: Inline-Inventur (Chargenrest setzen)
const { buildSlotChangePreview, validateSlotChange, buildSlotChangePayload, buildSlotChangeAuditEntry } = require('./lib/slot-change.js');
const { applySlotChange, applySlotAssignmentEvents } = require('./lib/jobs/wf4-slot-write.js');
const { fetchNayaxMachineProducts, normalizeAuthValue: normalizeNayaxAuth } = require('./lib/jobs/nayax-devices-sync.js');
const { buildProductOnboardingData, queryProductOnboardingPg } = require('./lib/product-onboarding.js');
const { buildReportCsv, buildReportFilename } = require('./lib/reports.js');
const { buildGuvPdf } = require('./lib/pdf-report.js');
const { buildLocationProfile, buildLocationComparison, queryLocationsPg, upsertLocationPg, deleteLocationPg } = require('./lib/location-profiles.js');
const { buildCorrectionCases, queryCorrectionCasesPg } = require('./lib/correction-cases.js');
const { buildMachineProfile, getMachineOptions, queryMachineProfilesPg, upsertMachineProfilePg } = require('./lib/machine-profiles.js');
const { buildMachineCreatePayload, createMachinePg, setMachineActivePg } = require('./lib/machine-create.js');
const { queryNayaxDevicesPg, shapeNayaxDevices } = require('./lib/nayax-devices.js');
const { readReconcileBacklog } = require('./lib/jobs/nayax-reconcile.js'); // #221: Arbeitsvorrat nachbuchungsbedürftiger Verkäufe
const { buildProductSuggestion, validateCorrectionAction, buildCorrectionActionPayload, buildCorrectionActionAuditEntry } = require('./lib/correction-action.js');
const { buildOnboardingStartPayload, validateOnboardingStart, buildOnboardingStartAuditEntry } = require('./lib/onboarding-start.js');
const { buildSlotAssignPreview, validateSlotAssign, buildSlotAssignPayload, buildSlotAssignAuditEntry } = require('./lib/slot-assign-inline.js');
const { buildProductCatalog } = require('./lib/product-catalog.js');
const { queryEconomicsScopePg } = require('./lib/automaten-view.js');
const { queryEconomicsLivePg } = require('./lib/economics-live.js');
const { resolveViewer, objectAccessAllowed, breakGlassDecision, crossTenantAccess } = require('./lib/auth.js');
const { resolveAuthMode, extractBearerToken, identityLogin, verifySupabaseJwt } = require('./lib/supabase-auth.js'); // #215: Auth-Naht (Doppelpfad)
const { parseAllowedOrigins, corsHeadersFor, isPreflight } = require('./lib/cors.js'); // #218: CORS (Cloudflare→Render)
const { createAuditLogWriter, dbAuditEnabled } = require('./lib/audit-log.js'); // #213: Audit-Trail → DB (audit.access_log)
const { createTenantDirectory } = require('./lib/tenant-directory.js');
const { createTenantDb } = require('./lib/tenant-db.js');
const { rejectBodyTenant } = require('./lib/write-guards.js');
const { resolvePgUrl } = require('./lib/pg-url.js');
const { runSchemaCheck } = require('./lib/db-schema.js');
const { runStockCostCheck } = require('./lib/stock-cost-invariant.js');
const { SLOW_MOVER } = require('./lib/slow-mover.js');
const {
  buildEffectiveConfig,
  loadEffectiveConfig,
  writeOverride,
  sanitizeOverride,
  readOverride,
  DEFAULT_MANDANT,
} = require('./lib/category-config.js');
const {
  THRESHOLD_DEFS,
  getThresholds,
  setThreshold,
  resetThreshold,
  resetAllThresholds,
} = require('./lib/settings-thresholds.js');
const {
  normalizeNayaxItems,
  buildAliasIndex,
  buildNameIndex,
  buildNayaxIdIndex,
  buildAbgleichDiff,
  buildApplyPlan,
  buildSlotAssignmentEvents,
  validateAbgleichApply,
  buildAbgleichPreviewPayload,
  buildAbgleichApplyPayload,
  buildAbgleichAuditEntry,
  buildActiveSlotsQuery,
  buildNayaxAliasesQuery,
  buildNayaxIdAliasesQuery,
  buildProductsByIdQuery,
} = require('./lib/nayax-abgleich.js');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
// #213: per Env relozierbar (Cloud/Test-Isolation). Die Datei ist reine n8n-Legacy-
// Laufzeit-Config (UI-gespeicherte N8N_*-Werte); Env-Variablen haben IMMER Vorrang
// (siehe dashboardConfig) — auf flüchtigem Cloud-FS (Render) wird sie nicht gebraucht.
const CONFIG_FILE = process.env.DASHBOARD_CONFIG_FILE || path.join(__dirname, '.dashboard-config.json');
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
    // Optionaler direkter Upload-Webhook (Mini-n8n: legt die Datei in den
    // Drive-Ordner Rechnungseingang -> der Drive-Trigger verarbeitet sie).
    directWebhookEnv: 'INVOICE_UPLOAD_WEBHOOK_URL',
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

// Lazy gebauter Drive-Client für den Rechnungs-Upload (n8n-Ablösung). Einmal
// gebaut und gecacht, damit der OAuth-Token-Cache im Client wirkt. Prozess-Env
// hat Vorrang vor .env.local (gleiche Regel wie beim Webhook-Override).
let invoiceDriveCache = null;
function getInvoiceDrive() {
  if (!invoiceDriveCache) {
    const { buildInvoiceDriveFromEnv } = require('./lib/google-drive-client.js');
    invoiceDriveCache = buildInvoiceDriveFromEnv({ ...loadLocalEnv(), ...process.env });
  }
  return invoiceDriveCache;
}

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
  // #213: Disk-Schreiben ist BEST-EFFORT — auf flüchtigem/read-only Cloud-FS (Render)
  // darf ein Schreibfehler den Request nie brechen. Maßgebliche Quelle sind die
  // Env-Variablen (Vorrang in dashboardConfig); die Datei ist nur Dev-Komfort.
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('[config] Config-Datei nicht schreibbar (best-effort, Env bleibt maßgeblich):', err && err.message);
  }
  return merged;
}

// #30 Design-Note (Zugangsdaten je Mandant, SPEC Story 27/37): Das Credential-
// Modell (.dashboard-config.json / Env-Vorrang) ist heute SINGLE-TENANT. Sobald
// ein zweiter echter Mandant dazukommt, ist ein Secret-Vault VERBINDLICH —
// mehrere Kundenschlüssel (z. B. Nayax-API je Kunde) dürfen NICHT im Klartext an
// einem Ort liegen. Künftiges Schema trägt `tenant_id` je Credential; bis dahin
// gilt der Single-Tenant-Pfad mit system.verwalten-Guard + maskierten Rückgaben.
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
  // External URL for browser-facing links (form URLs, editor URLs). Falls back to n8nBaseUrl.
  const n8nExternalUrl = process.env.N8N_EXTERNAL_URL || fileConfig.n8nExternalUrl || localEnv.N8N_EXTERNAL_URL || n8nBaseUrl;
  const source = process.env.N8N_API_KEY ? 'env' : fileConfig.n8nApiKey ? 'config_file' : localEnv.N8N_API_KEY ? 'env_file' : 'none';
  return {
    n8nBaseUrl: n8nBaseUrl.replace(/\/+$/, ''),
    n8nExternalUrl: n8nExternalUrl.replace(/\/+$/, ''),
    n8nApiKey,
    hasN8nApiKey: Boolean(n8nApiKey),
    source,
    envFiles: LOCAL_ENV_FILES.filter((filePath) => fs.existsSync(filePath)).map((filePath) => path.relative(ROOT, filePath)),
  };
}

// Issue #27: Default-Deny + exakte Allowlist + F1-Pfadvertrauen. Logik liegt in
// lib/auth.js (rein/testbar); hier nur das Extrahieren der Request-Felder.
// req.socket.remoteAddress ist die nicht-fälschbare Quelladresse (Basis für F1
// und den Loopback-Dev-Notausgang) — bewusst NICHT der spoofbare Host-Header.
// #215 (Auth-Naht, Doppelpfad): Im supabase-Mode kommt die Identität AUSSCHLIESSLICH
// aus dem am Handler-Eingang verifizierten JWT (req._jwtEmail) — der aus dem offenen
// Internet spoofbare Tailscale-Header wird dort NIE verwendet. Im tailscale-Mode
// (Default, Mini) bleibt alles unverändert.
function getViewer(req) {
  return resolveViewer({
    login: identityLogin({
      authMode: req._authMode || 'tailscale',
      jwtEmail: req._jwtEmail || null,
      tailscaleLogin: req.headers['tailscale-user-login'],
    }),
    remoteAddress: req.socket && req.socket.remoteAddress,
    host: req.headers.host,
    env: process.env,
    directory: tenantDirectory,        // #117: reale Mandanten-Auflösung aus der Registry
    requestId: req._requestId || null, // #117: per-Request-id (Audit-Korrelation, #118)
    supportTenant: req.headers['x-support-tenant'], // #118: Break-Glass-Override (untraut)
  });
}

// #118: Break-Glass-Audit-Pflichtfelder (an die bestehende Senke andocken). auditAction
// ergänzt timestamp + login(=viewer) + outcome; hier die übrigen SPEC-Pflichtfelder.
function breakGlassAuditFields(viewer, req, parsed) {
  // #169: explizites Cross-Tenant-Audit-Schema (actingLogin, home/target, crossTenant-Marker).
  const xt = crossTenantAccess(viewer);
  return {
    actingLogin: xt.actingLogin,
    isPlatformAdmin: xt.isPlatformAdmin,
    homeTenant: xt.homeTenant,
    targetTenant: (viewer && viewer.supportSession && viewer.supportSession.targetTenant) || xt.targetTenant,
    crossTenant: xt.crossTenant, // war_mandantenuebergreifend
    endpoint: parsed && parsed.pathname,
    method: req.method,
    sourceAddress: (req.socket && req.socket.remoteAddress) || null,
    requestId: (viewer && viewer.requestId) || req._requestId || null,
    denyReason: (viewer && viewer.supportSession && viewer.supportSession.denyReason) || null,
  };
}

// Issue #28: zentrale serverseitige Fähigkeits-Durchsetzung. Liefert true, wenn
// der Viewer die Fähigkeit hat; sonst sendet sie 403 und liefert false (der
// Aufrufer beendet dann mit `return`). Das ist die Autorität — nicht die UI.
function requireCapability(viewer, capability, res) {
  if (viewer && typeof viewer.can === 'function' && viewer.can(capability)) return true;
  auditDenied(viewer, 'capability_denied', { capability }); // #32: abgewiesene Aktion protokollieren
  sendJson(res, 403, {
    ok: false,
    error: { code: 'CAPABILITY_REQUIRED', message: `Fehlende Berechtigung: ${capability}.` },
  });
  return false;
}

// Issue #33/#117 (IDOR / Objekt-Ebene): VERBINDLICHES PATTERN für jeden Endpunkt,
// der eine Objekt-ID (machine_id, Standort, Charge …) entgegennimmt — zweite Hälfte
// der Zugriffskontrolle neben requireCapability (Verb-Ebene). Prüft, dass das Objekt
// zum Mandanten des Viewers gehört; fremd/unbekannt → 404 (kein Existenz-Leak) + Audit.
// Der Mandant einer Maschine wird über requireMachineAccess (async, Registry) real
// aufgelöst; objectAccessAllowed behandelt null (unbekannte Maschine) als deny.
function requireObjectAccess(viewer, objectTenantId, res, event) {
  if (objectAccessAllowed(viewer, objectTenantId)) return true;
  auditDenied(viewer, event || 'object_access_denied', { objectTenantId });
  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Objekt nicht gefunden.' } });
  return false;
}

// Issue #29: JSON-sichere Viewer-Form fürs Frontend. `capabilities` ist intern ein
// Set (+ `can`-Funktion) — fürs Frontend als Array + roleKey liefern, damit die
// v3-Shell Reiter/Buttons je Fähigkeit ein-/ausblenden kann (Komfort; die Autorität
// bleibt serverseitig in #28).
function viewerPublic(viewer) {
  return {
    login: viewer.login,
    role: viewer.role,
    roleKey: viewer.roleKey,
    tenantId: viewer.tenantId,
    canTriggerActions: viewer.canTriggerActions,
    capabilities: [...(viewer.capabilities || [])],
  };
}

// #32 (Säule 5 — Audit-Trail) + #213 (flüchtiges Cloud-FS): zentrales append-only
// Audit für privilegierte Aktionen. Hält wer/wann/was/Ergebnis fest — für ALLE
// Rollen (auch Admin/Auffüller) und auch ABGEWIESENE Versuche (outcome='denied').
// KEINE Secret-Werte: nur die vom Aufrufer übergebenen, secret-freien `details`.
//
// MASSGEBLICHE Senke ist die DB-Tabelle audit.access_log (Migration 0035) über die
// INFRA-Verbindung — Pipeline-Telemetrie OHNE tenant_id, analog audit.workflow_runs;
// sie überlebt Container-Restarts (Render). Die JSONL-Datei (0600, Pfad via
// DASHBOARD_AUDIT_LOG) bleibt best-effort-Fallback für lokale Dev. Beide Senken
// sind im Writer gekapselt: Audit darf die Aktion NIE kippen (write() wirft nie).
// Unter node:test bzw. DASHBOARD_AUDIT_DB=off bleibt die DB-Senke aus, damit
// Test-Läufe die echte Telemetrie nicht fluten (falsche AUTH_FAIL_SPIKEs, #168).
let auditLogWriterCache = null;
function getAuditLogWriter() {
  if (!auditLogWriterCache) {
    auditLogWriterCache = createAuditLogWriter({
      exec: (infraPgQuery && dbAuditEnabled(process.env)) ? infraPgQuery : null,
      filePath: () => process.env.DASHBOARD_AUDIT_LOG || path.join(__dirname, 'logs', 'guest-access.jsonl'),
      logger: (...a) => console.error('[audit]', ...a),
    });
  }
  return auditLogWriterCache;
}

function auditAction(viewer, event, details = {}, outcome = 'ok') {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    outcome,
    login: viewer && viewer.login,
    role: viewer && viewer.role,
    roleKey: viewer && viewer.roleKey,
    tenantId: viewer && viewer.tenantId,
    ...details,
  };
  // Fire-and-forget: write() fängt intern ALLES ab (DB UND Datei best-effort) und
  // wirft nie — der Request wartet nicht auf die Telemetrie.
  getAuditLogWriter().write(entry);
}

// #32: abgewiesene privilegierte Aktion (403) — für ALLE Rollen protokollieren.
function auditDenied(viewer, event, details = {}) {
  auditAction(viewer, event, details, 'denied');
}

// Gast-VIEW-Logging (read): bleibt gast-only, damit häufige Admin-Reads den Trail
// nicht zuspammen. Privilegierte AKTIONEN nutzen auditAction (alle Rollen).
function auditGuestAccess(viewer, event, details = {}) {
  if (viewer.role !== 'guest') return;
  auditAction(viewer, event, details, 'guest_view');
}

// Onboarding-Start-Audit-Log: Schreib- (POST /onboarding/start) und Lesepfad
// (GET /onboarding/started-keys) müssen identisch sein. Via
// DASHBOARD_ONBOARDING_AUDIT_LOG überschreibbar (Test-Isolation, sonst hängt der
// started-keys-Test von akkumuliertem lokalem JSONL ab).
function onboardingAuditPath() {
  return process.env.DASHBOARD_ONBOARDING_AUDIT_LOG || path.join(__dirname, 'logs', 'onboarding-starts.jsonl');
}

function clean(value) {
  return String(value ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// Liest den Request-Body und parst ihn als JSON (leerer Body ⇒ {}). Wirft bei
// ungültigem JSON, sodass der Aufrufer mit 400 antworten kann. (Der Name wurde am
// slot-assign-inline/confirm-Endpunkt bereits verwendet, war aber nie definiert —
// der Body kam dort immer als {} an [latenter Bug]; #133 zieht ihn nach, weil das
// Autorisierungs-Tor die machine_id aus dem Body braucht.)
// Sicherheit (Audit, 2026-06-12): HARTES Größenlimit gegen Body-Flooding-DoS.
// JSON-Payloads dieser API sind klein (< einige KB) ⇒ 1 MB ist großzügig. Ohne
// Limit könnte ein riesiger Body den Speicher fluten und den Prozess killen.
// Bei Überschreitung: Verbindung kappen + ablehnen (Aufrufer fangen ab ⇒ leerer
// Body ⇒ Validierung schlägt fehl).
const JSON_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
function readJsonBody(req, maxBytes = JSON_BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        const err = new Error(`Body groesser als ${maxBytes} Bytes.`);
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (aborted) return; try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
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
  // Priorität: echte Prozess-Umgebung > .env.local (wie bei der n8n-Konfiguration).
  return resolvePgUrl(process.env, loadLocalEnv());
}

// ── #117 (Stufe 2): Mandanten-Registry verkabeln ──────────────────────────────
// Eine langlebige, Pool-gestützte Registry-Instanz ist die einzige Quelle der
// Mandanten-Auflösung (lib/tenant-directory.js). Ohne konfiguriertes PG bleibt sie
// `null` (Dev/Test): die PG-abhängigen Endpunkte liefern ohnehin ihr eigenes
// PG_UNCONFIGURED-503, und die IDOR-Hooks reagieren fail-closed (siehe
// requireMachineAccess). Initialer Load-Fehler ⇒ Instanz bleibt „nicht bereit"
// (isReady()===false) ⇒ Health-Check 503, IDOR-Hooks 503 (fail-closed) — es wird
// NIE mit leerem Verzeichnis serviert und NIE auf einen Default-Mandanten gefallen.
// EIN geteilter pg-Pool für die mandanten-bewusste Infrastruktur: Stufe-2-Registry
// (lib/tenant-directory.js) UND Stufe-3-Mandanten-Tür (lib/tenant-db.js) teilen sich
// denselben Pool (zentralisierter DB-Zugriff, SPEC §"DB-Zugriff zentralisiert").
// #144 (Stufe 5): ZWEI getrennte Verbindungen statt einer geteilten.
//  - INFRA-Pool (Owner/BYPASSRLS-Rolle): Bootstrap (Verzeichnis-Lookup, der
//    tenant_users/platform_admins liest, BEVOR ein Mandant feststeht → kein GUC
//    setzbar), Migrationen, MatView-REFRESH. Umgeht RLS bewusst.
//  - APP-Pool (RLS-unterworfene Rolle `automatenlager_app`): ALLER Mandanten-
//    Verkehr durch die Tür. Fällt auf die Infra-URL zurück, solange
//    DASHBOARD_V2_APP_PG_URL nicht gesetzt ist (Slice 1 inert; Slice 2 schaltet
//    via .env.local die App-Rolle scharf).
function buildPgPool(url) {
  if (!url) return null;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3000 });
  pool.on('error', (err) => console.error('[pg-pool] Pool-Fehler:', err && err.message));
  return pool;
}

// Separate App-Rollen-URL (RLS). Prozess-Umgebung hat Vorrang vor .env.local;
// fehlt der Schlüssel ⇒ Infra-URL (Slice-1-Verhalten: identische Rolle, inert).
function dashboardV2AppPgUrl() {
  const pe = process.env;
  if (Object.prototype.hasOwnProperty.call(pe, 'DASHBOARD_V2_APP_PG_URL')) {
    return String(pe.DASHBOARD_V2_APP_PG_URL || '').trim() || dashboardV2PgUrl();
  }
  const local = loadLocalEnv();
  const fromLocal = String((local && local.DASHBOARD_V2_APP_PG_URL) || '').trim();
  return fromLocal || dashboardV2PgUrl();
}

// #215 (Auth-Naht): Supabase-Auth-Konfiguration. Prozess-Umgebung hat Vorrang
// vor .env.local (gleiches Muster wie die PG-URLs). Der Issuer ist deterministisch
// `${SUPABASE_URL}/auth/v1`; die JWKS-URL ist daraus abgeleitet und nur für
// Tests/Sonderfälle überschreibbar. anonKey ist der ÖFFENTLICHE Browser-Key
// (kein Secret) — er geht über /api/v2/auth/config ans Login-Frontend.
function supabaseAuthSettings() {
  const pe = process.env;
  const local = loadLocalEnv();
  const pick = (key) => (Object.prototype.hasOwnProperty.call(pe, key)
    ? String(pe[key] || '').trim()
    : String((local && local[key]) || '').trim());
  const supabaseUrl = pick('SUPABASE_URL').replace(/\/+$/, '');
  return {
    // C1 (Audit 2026-06-12): Cloud-Kontext erzwingt fail-closed den supabase-
    // Modus (nie Header-Auth im offenen Internet). Das maßgebliche „wir sind in
    // der Cloud"-Signal ist die PROZESS-Umgebung `process.env.SUPABASE_URL` (von
    // Render gesetzt) — NICHT der .env.local-Fallback, der nur lokaler Dev-/Mini-
    // Komfort ist. So greift der Riegel in der echten Cloud (Render-Env), ohne
    // den Mini/lokale Tailscale-Tests fälschlich umzuschalten. Der explizite
    // `DASHBOARD_AUTH_MODE=supabase` (env ODER .env.local) wirkt unabhängig davon.
    mode: resolveAuthMode({
      DASHBOARD_AUTH_MODE: pick('DASHBOARD_AUTH_MODE'),
      SUPABASE_URL: String(process.env.SUPABASE_URL || '').trim(),
    }),
    supabaseUrl,
    anonKey: pick('SUPABASE_ANON_KEY'),
    issuer: supabaseUrl ? `${supabaseUrl}/auth/v1` : '',
    jwksUrl: pick('SUPABASE_JWKS_URL') || (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : ''),
  };
}

// #215: Identität aus dem Supabase-JWT auflösen (nur im supabase-Mode relevant).
// Läuft EINMAL pro Request am Handler-Eingang (async); getViewer bleibt synchron
// und liest das Ergebnis aus req._jwtEmail. Jeder Fehler ⇒ null (Default-Deny).
async function resolveJwtIdentity(req, auth) {
  const token = extractBearerToken(req.headers);
  if (!token || !auth.issuer) return null;
  const r = await verifySupabaseJwt(token, { issuer: auth.issuer, jwksUrl: auth.jwksUrl });
  return r.valid && r.email ? r.email : null;
}

const infraPgPool = buildPgPool(dashboardV2PgUrl());
const infraPgQuery = infraPgPool ? (sql, params) => infraPgPool.query(sql, params) : null;
const appPgPool = buildPgPool(dashboardV2AppPgUrl());

function buildTenantDirectory() {
  if (!infraPgQuery) return null; // Verzeichnis läuft über die INFRA-Verbindung (RLS-umgehend, Bootstrap)
  const ttlEnv = Number(process.env.DASHBOARD_TENANT_DIR_TTL_MS);
  return createTenantDirectory({
    query: infraPgQuery,
    ttlMs: Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : undefined,
    logger: (...a) => console.error('[tenant-directory]', ...a),
  });
}

const tenantDirectory = buildTenantDirectory();

// Stufe-3-Mandanten-Tür: die EINE Lese-Zugriffsschicht über demselben Pool. In #122
// (Fundament) absichtlich von KEINEM Endpunkt konsumiert — es wird in diesem Slice
// kein Lesepfad migriert. Steht für die Slices #123ff. bereit (fail-closed, siehe
// lib/tenant-db.js). `null` ohne konfiguriertes PG (Dev/Test).
// #135 (Stufe 4): Der Pool wird zusätzlich übergeben, damit der transaktionale
// Schreib-Modus `db.tx` einen DEDIZIERTEN Client (BEGIN/COMMIT/ROLLBACK) holen kann.
const tenantDb = appPgPool
  ? createTenantDb({ query: (sql, params) => appPgPool.query(sql, params), pool: appPgPool, log: (...a) => console.error('[tenant-db]', ...a) })
  : null;

// Initialer Snapshot (non-blocking, wie die übrigen Startup-Checks). Erfolg ⇒
// TTL-Auto-Refresh starten; Fehler ⇒ fail-closed (Instanz bleibt unready).
async function initTenantDirectory() {
  if (!tenantDirectory) return;
  try {
    await tenantDirectory.init();
    console.log('[tenant-directory] bereit.');
  } catch (err) {
    // Fail-closed bleibt: isReady()===false ⇒ Lese-Endpunkte liefern 503 (kein leeres
    // Dashboard, kein Default). Aber NICHT dauerhaft: der Auto-Refresh (finally) heilt
    // selbst, sobald die DB wieder erreichbar ist — sonst bliebe das Verzeichnis nach
    // einem Deploy-Fenster-Fehler (DB kurz unter Last) bis zum manuellen Container-
    // Neustart unready (Owner-Aussperrung). refreshQuietly() setzt ready=true beim
    // ersten erfolgreichen Tick.
    console.error('[tenant-directory] initialer Load fehlgeschlagen — fail-closed; Auto-Refresh heilt selbst:', err && err.message);
  } finally {
    // #Härtung: Auto-Refresh IMMER starten (idempotent), auch nach Init-Fehler.
    tenantDirectory.startAutoRefresh();
  }
}

function tenantDirectoryHealthy() {
  // Ohne konfiguriertes PG ist die Registry „nicht anwendbar" ⇒ gesund (Dev/Test).
  // Mit PG hängt die Gesundheit an der Registry-Bereitschaft (fail-closed sichtbar).
  if (!tenantDirectory) return true;
  return tenantDirectory.isReady();
}

// #117 (IDOR-Objektprüfung, async): löst den Mandanten der Maschine über die
// Registry auf und wendet die Statuscode-Taxonomie an:
//   * Registry nicht bereit / technischer Lookup-Fehler ⇒ 503 (kein Default-Fallback)
//   * Maschine unbekannt / fremder Mandant ⇒ 404 (über requireObjectAccess, kein Leak)
//   * eigener Mandant ⇒ allow
// Liefert true (Zugriff erlaubt) oder false (Antwort bereits gesendet).
async function requireMachineAccess(viewer, machineKey, res, event) {
  if (!tenantDirectory || !tenantDirectory.isReady()) {
    auditDenied(viewer, event, { machineKey, reason: 'tenant_directory_unready' });
    sendJson(res, 503, { ok: false, error: { code: 'TENANT_DIRECTORY_UNAVAILABLE', message: 'Mandanten-Verzeichnis nicht bereit. Bitte später erneut.' } });
    return false;
  }
  let objectTenantId;
  try {
    objectTenantId = await tenantDirectory.machineTenant(machineKey);
  } catch (err) {
    auditDenied(viewer, event, { machineKey, reason: 'tenant_lookup_failed' });
    sendJson(res, 503, { ok: false, error: { code: 'TENANT_LOOKUP_FAILED', message: 'Mandanten-Auflösung fehlgeschlagen. Bitte später erneut.' } });
    return false;
  }
  return requireObjectAccess(viewer, objectTenantId, res, event);
}

// #134 (Stufe 4, IDOR — NICHT-Maschinen-Parent): Korrektur-Cases sind KEINE Tabelle,
// sondern konstruiert (proposal_/unknown_/warning_) und werden tenant-gefiltert über
// queryCorrectionCasesPg gelesen. Das Tor prüft, dass die übergebene case_id in der
// tenant-gefilterten Case-Liste des Viewers liegt (exakt die Komposition des
// Lesepfads). Taxonomie:
//   * kein PG konfiguriert ⇒ Tor INAKTIV (Dev/Test: es existieren gar keine Cases;
//     Produktion hat IMMER PG, dort läuft das Tor stets). Asymmetrie zu
//     requireMachineAccess bewusst: eine machine_id ist immer client-geliefert und
//     muss fail-closed aufgelöst werden; eine Case-Mitgliedschaft ohne Datenbasis
//     ist gegenstandslos.
//   * PG da, Verzeichnis/DB nicht bereit / Lookup-Fehler ⇒ 503 (fail-closed, kein Default)
//   * case_id nicht in der Mandanten-Case-Liste ⇒ 404 (kein Existenz-Leak) + Audit
// Liefert true (Zugriff erlaubt / inaktiv) oder false (Antwort bereits gesendet).
async function requireCaseAccess(viewer, caseId, res, event) {
  if (!tenantDb) return true; // kein PG ⇒ Dev/Test, Tor inaktiv (Produktion hat immer PG)
  if (!tenantReadReady(res)) return false; // PG da, aber nicht bereit ⇒ 503
  let cases;
  try {
    ({ cases } = buildCorrectionCases(await queryCorrectionCasesPg(tenantDb, viewer.tenantId)));
  } catch (err) {
    auditDenied(viewer, event, { caseId, reason: 'case_lookup_failed' });
    sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: 'Fall-Auflösung fehlgeschlagen. Bitte später erneut.' } });
    return false;
  }
  if (!cases.some((c) => c.case_id === caseId)) {
    auditDenied(viewer, event, { caseId });
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Fall nicht gefunden.' } });
    return false;
  }
  return true;
}

// #123 (Stufe 3): technische Bereitschaft der mandanten-getrennten Lesepfade.
// Ist PG konfiguriert, aber das Mandanten-Verzeichnis NICHT bereit (z. B. DB
// unerreichbar), kann der effektive Mandant nicht aufgelöst werden ⇒ die Tür würde
// fail-closed LEER liefern und damit einen TECHNISCHEN Fehler als „keine Daten"
// maskieren. SPEC-Taxonomie: technischer Fehler ≠ leer ⇒ hier 503 (kein leeres
// Resultat). Liefert true (bereit) oder false (503 bereits gesendet).
function tenantReadReady(res) {
  if (tenantDirectory && !tenantDirectory.isReady()) {
    sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: 'Mandanten-Verzeichnis nicht bereit (DB nicht erreichbar).' } });
    return false;
  }
  return true;
}

// Effektive Kategorie-/Schwellwert-Config (#63) für /einstellungen. Ohne erreichbare
// DB fallen wir auf die Branchen-Anker-Defaults zurück (die Seite bleibt nutzbar).
async function loadClassificationConfig(mandantId = DEFAULT_MANDANT) {
  // #125: durch die Mandanten-Tür (geteilter Pool). Config liegt unter mandantId
  // (Default __default__) — per-Mandant-Config ist Stufe 6. Fehler ⇒ Defaults
  // (das Dashboard bleibt nutzbar).
  if (!tenantDb) return buildEffectiveConfig({});
  try {
    return await loadEffectiveConfig(tenantDb, mandantId);
  } catch {
    return buildEffectiveConfig({});
  }
}

// Merge zweier bereits sanitierter Override-Objekte: skalare Felder von `incoming`
// überschreiben, Kategorien werden je key tief gemerged — so verwirft ein
// Teil-Speichern (z. B. nur eine Marge) nicht die übrigen Kategorien/Werte.
function mergeSettingsOverride(current = {}, incoming = {}) {
  const out = { ...current, ...incoming };
  if (current.categories || incoming.categories) {
    out.categories = { ...(current.categories || {}) };
    for (const [key, val] of Object.entries(incoming.categories || {})) {
      out.categories[key] = { ...(out.categories[key] || {}), ...val };
    }
  }
  return out;
}

// Nayax-API-Zugang für den Vollabgleich (n8n-Ablösung 2026-06-11): Token/Basis
// direkt aus der Env — die n8n-Credential-Indirektion (NAYAX_ABGLEICH_WEBHOOK_URL)
// ist abgelöst. Prozess-Env hat Vorrang vor .env.local.
function nayaxApiSettings() {
  const fileEnv = loadLocalEnv();
  const pick = (k) => clean(process.env[k] !== undefined ? process.env[k] : fileEnv[k]);
  return {
    token: normalizeNayaxAuth(pick('NAYAX_API_TOKEN')),
    baseUrl: pick('NAYAX_BASE_URL') || 'https://lynx.nayax.com',
    headerName: pick('NAYAX_HEADER_NAME') || 'Authorization',
  };
}

// Vollabgleich-Diff (Slotbelegung + Füllstand) Nayax -> PG, read-only.
// Holt die Nayax-Items DIREKT von der Nayax-API (machineProducts + Namens-
// Anreicherung; früher via Mini-WF-Webhook), liest PG (aktive Slots + Nayax-
// Aliase + Produktnamen) und baut den Diff über die getestete reine Logik in
// lib/nayax-abgleich.js. Wirft bei Nayax-/PG-Fehlern (mit err.code).
async function computeNayaxAbgleichDiff(db, tenant, machineKey) {
  const { token, baseUrl, headerName } = nayaxApiSettings();
  if (!token) {
    const err = new Error('NAYAX_API_TOKEN nicht gesetzt.');
    err.code = 'NAYAX_UNCONFIGURED';
    throw err;
  }
  let rawItems;
  try {
    rawItems = await fetchNayaxMachineProducts({ token, headerName, baseUrl, machineId: machineKey });
  } catch (e) {
    const err = new Error(`Nayax-API: ${e.message}`);
    err.code = 'NAYAX_API_ERROR';
    throw err;
  }
  const nayaxItems = normalizeNayaxItems(Array.isArray(rawItems) ? rawItems : []);

  // #127: 4 Reads durch die Mandanten-Tür (tenant_id-Filter in den Buildern, Mandant=$1).
  const slotsQ = buildActiveSlotsQuery({ machineKey });
  const aliasQ = buildNayaxAliasesQuery();
  const idAliasQ = buildNayaxIdAliasesQuery();
  const prodQ = buildProductsByIdQuery();
  const [sRes, aRes, idRes, pRes] = await Promise.all([
    db.read({ tenant, tables: ['slot_assignments', 'products', 'machines'], text: slotsQ.text, params: slotsQ.values }),
    db.read({ tenant, tables: ['product_aliases'], text: aliasQ.text, params: aliasQ.values }),
    db.read({ tenant, tables: ['product_aliases'], text: idAliasQ.text, params: idAliasQ.values }),
    db.read({ tenant, tables: ['products'], text: prodQ.text, params: prodQ.values }),
  ]);
  const pgSlots = sRes.rows; const aliasRows = aRes.rows; const idAliasRows = idRes.rows; const productRows = pRes.rows;
  const aliasIndex = buildAliasIndex(aliasRows);
  const idIndex = buildNayaxIdIndex(idAliasRows);
  // Fallback-Match ueber products.name (Produkte ohne gepflegten nayax-Alias).
  const nameIndex = buildNameIndex(productRows);
  const productsById = {};
  const productKeyById = {};
  for (const r of productRows) {
    productsById[Number(r.product_id)] = formatProductName(r.name) ?? r.name;
    if (r.product_key) productKeyById[Number(r.product_id)] = r.product_key;
  }
  // Alte/Slot-Produktnamen ebenfalls als Klartext anzeigen (sonst rohe SKU im
  // Diff, vgl. Issue #5); neue Namen kommen bereits formatiert aus productsById.
  for (const s of pgSlots) { s.product_name = formatProductName(s.product_name) ?? s.product_name; }
  const diff = buildAbgleichDiff(pgSlots, nayaxItems, aliasIndex, { machineId: machineKey, productsById, idIndex, nameIndex });
  return { diff, productKeyById };
}

// Beim Start einmalig prüfen, ob der Dashboard-Code zum echten DB-Schema passt.
// Nicht-blockierend, wirft nie: bei fehlender/unerreichbarer DB still überspringen.
async function logStartupSchemaCheck() {
  const pgUrl = dashboardV2PgUrl();
  if (!pgUrl) return; // PG nicht konfiguriert → nichts zu prüfen
  let client;
  try {
    const { Client } = require('pg');
    client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 4000 });
    await client.connect();
  } catch (err) {
    console.log(`ℹ Schema-Check übersprungen (PG nicht erreichbar: ${err.code || err.message}).`);
    if (client) { try { await client.end(); } catch { /* egal */ } }
    return;
  }
  try {
    const report = await runSchemaCheck(client, __dirname);
    if (report.healthy) {
      console.log(`✓ Schema-Contract erfüllt (${report.checkedColumnRefs} Spalten-Refs, ${report.checkedRelations} Relationen gegen DB geprüft).`);
    } else {
      console.warn('⚠ Schema-Drift erkannt — der Dashboard-Code erwartet etwas, das die DB nicht hat:');
      if (report.missingRelations.length) console.warn(`  fehlende Relationen: ${report.missingRelations.join(', ')}`);
      if (report.missingReferencedRelations.length) console.warn(`  benutzte, aber fehlende Relationen: ${report.missingReferencedRelations.join(', ')}`);
      for (const v of report.missingColumns) console.warn(`  fehlende Spalte: ${v.relation}.${v.column}`);
      console.warn('  → Details: GET /api/v2/_diagnostics/schema');
    }
  } catch (err) {
    console.log(`ℹ Schema-Check fehlgeschlagen: ${err.message}`);
  } finally {
    try { await client.end(); } catch { /* egal */ }
  }
}

// Startup-Warnung: bestandswirksame Chargen ohne Einkaufspreis (siehe
// lib/stock-cost-invariant.js). Reine Detektion, keine Datenänderung.
async function logStartupStockCostCheck() {
  const pgUrl = dashboardV2PgUrl();
  if (!pgUrl) return;
  let client;
  try {
    const { Client } = require('pg');
    client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 4000 });
    await client.connect();
  } catch (err) {
    if (client) { try { await client.end(); } catch { /* egal */ } }
    return; // PG nicht erreichbar → bereits vom Schema-Check geloggt
  }
  try {
    const report = await runStockCostCheck(client);
    if (report.healthy) {
      console.log('✓ EK-Invariant erfüllt (keine bestandswirksame Charge ohne Einkaufspreis).');
    } else {
      console.warn(`⚠ ${report.offenders.length} bestandswirksame Charge(n) ohne Einkaufspreis (unit_cost_net <= 0) — FIFO-Verkäufe buchen Wareneinsatz 0:`);
      for (const o of report.offenders) console.warn(`  batch ${o.batchId} (product ${o.productId}, ${o.batchKey})`);
      console.warn('  → Details: GET /api/v2/_diagnostics/stock-cost');
    }
  } catch (err) {
    console.log(`ℹ EK-Invariant-Check fehlgeschlagen: ${err.message}`);
  } finally {
    try { await client.end(); } catch { /* egal */ }
  }
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

// Sicherheit (Audit L1): echten Dateityp aus den Magic Bytes erkennen
// (inhaltsbasiert, nicht aus dem fälschbaren Header/Namen). Nur die in dieser
// App erlaubten Typen — alles andere ⇒ null ⇒ Upload abgelehnt. KEIN SVG/HTML/JS.
function detectFileType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'; // %PDF
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';       // \x89PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';                          // JPEG SOI
  return null;
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

  // Sicherheit (Audit L1, 2026-06-12): INHALTSBASIERTER Typ-Check (Magic Bytes) —
  // ZULETZT (nach den billigen Größen-Checks). Dateiname-Endung UND Content-Type-
  // Header sind beide client-fälschbar; ein Angreifer könnte eine Schaddatei als
  // „rechnung.pdf, application/pdf" deklarieren. Der echte Dateianfang muss zu
  // einem erlaubten Typ passen (PDF/PNG/JPEG) — kein SVG/HTML/JS/Skript.
  const sniffed = detectFileType(file.data);
  if (!sniffed || !targetConfig.allowedMimeTypes.includes(sniffed)) {
    const error = new Error(`${targetConfig.label}-Upload: Dateiinhalt passt zu keinem erlaubten Typ (erwartet ${targetConfig.allowedMimeTypes.join('/')}).`);
    error.code = 'FILE_CONTENT_MISMATCH';
    error.status = 422;
    throw error;
  }

  return file;
}

function resolveV2UploadWorkflow(targetConfig, n8n) {
  const workflow = pickWorkflowForAction(n8n.workflows || [], targetConfig.workflowName);
  if (!workflow || !workflow.active) return null;

  // Gezielt den POST-Webhook waehlen: ein Workflow kann zusaetzlich einen
  // GET-Trigger-Webhook (z. B. Ordner-Scan) haben, der nicht fuer Uploads taugt.
  const webhook = (workflow.webhooks || []).find(
    (node) => node.path && clean(node.method || 'GET').toUpperCase() === 'POST'
  );
  if (!webhook?.path) return null;

  const webhookUrl = `${n8n.baseUrl || dashboardConfig().n8nBaseUrl}/webhook/${encodeURIComponent(webhook.path)}`;
  return {
    id: workflow.id,
    name: workflow.name,
    webhookPath: webhook.path,
    method: 'POST',
    url: webhookUrl,
  };
}

function buildV2UploadCapabilities(viewer) {
  return {
    viewer: viewerPublic(viewer),
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

async function buildDashboardV2Area(area, query = {}, viewer = null) {
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
    // #124: technischer Ausfall (Verzeichnis nicht bereit) ⇒ 503, nicht leer.
    if (tenantDirectory && !tenantDirectory.isReady()) {
      return buildDashboardV2Error(area, 'PG_ERROR', 'Mandanten-Verzeichnis nicht bereit (DB nicht erreichbar).');
    }
    try {
      // #124: mandantengetrennt durch die Tür; Mandant aus dem Viewer, MHD-Fenster aus der Config.
      const tenant = viewer && viewer.tenantId;
      const cfg = await loadClassificationConfig(DEFAULT_MANDANT);
      const raw = await queryOverviewMonitoringPg(tenantDb, tenant, { mhdDays: cfg.mhdRiskDays });
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
                warnings: monitoring.warnings,
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
    // #123: technischer Ausfall (Verzeichnis nicht bereit) ⇒ 503, nicht leer.
    if (tenantDirectory && !tenantDirectory.isReady()) {
      return buildDashboardV2Error(area, 'PG_ERROR', 'Mandanten-Verzeichnis nicht bereit (DB nicht erreichbar).');
    }
    try {
      // #123: mandantengetrennt durch die Tür; effektiver Mandant aus dem Viewer.
      const tenant = viewer && viewer.tenantId;
      const pgRows = await queryEconomicsPg(tenantDb, tenant, query);
      // #40: laufender Tag (noch nicht von WF8 aggregiert) als vorläufige
      // Position ergänzen — Fehler hier dürfen die GuV nie kippen.
      try {
        // Tax-Config (#56) des Mandanten laden und in den Live-Pfad reichen
        // (kein DB-Zugriff in economics.js; classification_settings-Migration = #125).
        const taxConfig = await loadClassificationConfig(DEFAULT_MANDANT);
        pgRows.provisional = await queryEconomicsProvisionalPg(tenantDb, tenant, query, taxConfig);
      } catch (_) {
        pgRows.provisional = null;
      }
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
    // #126: technischer Ausfall (Verzeichnis nicht bereit) ⇒ 503, nicht leer.
    if (tenantDirectory && !tenantDirectory.isReady()) {
      return buildDashboardV2Error(area, 'PG_ERROR', 'Mandanten-Verzeichnis nicht bereit (DB nicht erreichbar).');
    }
    try {
      // #126: mandantengetrennt durch die Tür; effektiver Mandant aus dem Viewer.
      const tenant = viewer && viewer.tenantId;
      const pgRows = await queryInventoryMhdPg(tenantDb, tenant, query);
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
          data: {
            ...data,
            allBatches: (pgRows.allBatches || []).map((r) => ({
              batch_key:      String(r.batch_key || ''),
              batch_count:    Number(r.batch_count) || 1,
              product_id:     Number(r.product_id),
              product_name:   formatProductName(String(r.product_name || '')),
              mhd_date:       toIsoDate(r.mhd_date),
              remaining_qty:  Number(r.remaining_qty) || 0,
              machine_qty:    Number(r.machine_qty)   || 0, // #87: Nayax-Abgleich-Wert
              days_until_mhd: r.days_until_mhd != null ? Number(r.days_until_mhd) : null,
              purchase_date:  r.purchase_date ? toIsoDate(r.purchase_date) : null,
            })),
          },
          error: null,
        },
      };
    } catch (err) {
      return buildDashboardV2Error(area, 'PG_ERROR', `PostgreSQL-Abfrage fehlgeschlagen: ${err.message}`);
    }
  }

  if (area === 'assortment-slots') {
    // #125: technischer Ausfall (Verzeichnis nicht bereit) ⇒ 503, nicht leer.
    if (tenantDirectory && !tenantDirectory.isReady()) {
      return buildDashboardV2Error(area, 'PG_ERROR', 'Mandanten-Verzeichnis nicht bereit (DB nicht erreichbar).');
    }
    try {
      // #125: mandantengetrennt durch die Tür; effektiver Mandant aus dem Viewer.
      const tenant = viewer && viewer.tenantId;
      const pgRows = await queryAssortmentSlotsPg(tenantDb, tenant, query);
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
  const config = dashboardConfig();
  const baseUrl = n8n.baseUrl || config.n8nBaseUrl;
  const externalUrl = config.n8nExternalUrl;
  return workflowActions.map((action) => {
    const workflow = pickWorkflowForAction(n8n.workflows || [], action.workflowName);
    const editorUrl = workflowEditorUrl(baseUrl, workflow?.id);
    const webhookUrl = workflow ? firstProductionWebhookUrl(baseUrl, workflow) : '';
    const webhookNode = workflow ? firstProductionWebhook(workflow) : null;
    const webhookMethod = webhookNode?.method || 'GET';
    const formUrl = workflow ? firstFormUrl(externalUrl, workflow) : '';
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

// A1-Performance: gzip nur, wenn der Client es anbietet (res._acceptsGzip) und der
// Inhalt komprimierbar + groß genug ist. Transparent — ohne Accept-Encoding identisch
// zu vorher. In-Memory-Cache der gzippten statischen Dateien (mtime-invalidiert).
function isCompressible(type) {
  return /text\/|application\/json|javascript|image\/svg/i.test(type);
}
const STATIC_GZIP_CACHE = new Map(); // filePath -> { mtimeMs, size, gz }

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (res._acceptsGzip && body.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
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
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  const type = types[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  // Conditional GET: unveränderte Datei ⇒ 304 (kein Body-Neudownload). no-cache =
  // immer revalidieren ⇒ nie veraltet (kein Stale nach Deploy), aber 304 spart Transfer.
  if (res._ifNoneMatch && res._ifNoneMatch === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'ETag': etag };
  if (res._acceptsGzip && isCompressible(type)) {
    let c = STATIC_GZIP_CACHE.get(filePath);
    if (!c || c.mtimeMs !== stat.mtimeMs || c.size !== stat.size) {
      c = { mtimeMs: stat.mtimeMs, size: stat.size, gz: zlib.gzipSync(fs.readFileSync(filePath)) };
      STATIC_GZIP_CACHE.set(filePath, c);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(c.gz);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// #217: Trigger-Verdrahtung. Die Worker-Verkabelung (Pools, Tür, Jobs, Telemetrie)
// wird LAZY und genau EINMAL gebaut (buildWorker OHNE start() — kein Scheduler,
// nur runJobNow). So bleibt der Web-Prozess ohne Trigger-Nutzung unverändert.
let internalJobTrigger = null;
function handleInternalJobTrigger(req, res, jobKey) {
  if (!internalJobTrigger) {
    const pe = process.env;
    const local = loadLocalEnv();
    const secret = Object.prototype.hasOwnProperty.call(pe, 'WORKER_TRIGGER_SECRET')
      ? String(pe.WORKER_TRIGGER_SECRET || '').trim()
      : String((local && local.WORKER_TRIGGER_SECRET) || '').trim();
    const { createJobTriggerHandler } = require('./lib/job-triggers.js');
    let workerHandle = null;
    const getWorker = () => {
      if (!workerHandle) {
        const { buildWorker } = require('./worker.js');
        workerHandle = buildWorker(process.env).worker;
      }
      return workerHandle;
    };
    internalJobTrigger = createJobTriggerHandler({
      secret,
      runJobNow: (key) => getWorker().runJobNow(key),
      listJobs: () => getWorker().listSchedules().map((s) => s.name),
    });
  }
  return internalJobTrigger(req, res, jobKey);
}

// #218: erlaubte CORS-Origins (Cloudflare-Frontend-Domains). Prozess-Umgebung
// hat Vorrang vor .env.local; leer ⇒ CORS inert (Mini/same-origin).
function corsAllowedOrigins() {
  const pe = process.env;
  const fromEnv = Object.prototype.hasOwnProperty.call(pe, 'DASHBOARD_CORS_ORIGINS')
    ? String(pe.DASHBOARD_CORS_ORIGINS || '')
    : String((loadLocalEnv() || {}).DASHBOARD_CORS_ORIGINS || '');
  return parseAllowedOrigins(fromEnv);
}

// Sicherheit (Audit M2, 2026-06-12): Basis-Security-Header auf JEDER Antwort.
// CSP wird bewusst NICHT hart gesetzt (das v3-Frontend nutzt Inline-Skripte +
// externe Fonts; eine strikte CSP bräuchte erst ein Frontend-Refactor — als
// Folge-Härtung über Cloudflare notiert). Diese vier sind risikolos und greifen
// sofort: nosniff (kein MIME-Sniffing), DENY (kein Clickjacking via iframe),
// Referrer-Policy (kein URL-Leak an Dritte), HSTS (erzwingt HTTPS; über HTTP
// ignorieren Browser es, daher auf dem Mini harmlos).
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const server = http.createServer(async (req, res) => {
  req._requestId = crypto.randomUUID(); // #117: per-Request-id für Audit-Korrelation (#118)
  setSecurityHeaders(res); // Audit M2: vor jeder writeHead (wird gemerged)
  // #215 (Auth-Naht): Identitäts-Quelle EINMAL pro Request bestimmen, VOR jedem
  // getViewer-Aufruf (auch dem Break-Glass-Vorschritt). Im supabase-Mode wird das
  // Bearer-JWT gegen die Projekt-JWKS verifiziert; Fehler ⇒ keine Identität.
  const authSettings = supabaseAuthSettings();
  req._authMode = authSettings.mode;
  if (req._authMode === 'supabase') {
    try {
      req._jwtEmail = await resolveJwtIdentity(req, authSettings);
    } catch {
      req._jwtEmail = null; // Default-Deny — verifySupabaseJwt wirft eigentlich nie
    }
  }
  // A1-Performance: gzip-/Conditional-GET-Kontext pro Request (transparent; ändert
  // kein Verhalten — greift nur, wenn der Client Accept-Encoding/If-None-Match sendet).
  res._acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  res._ifNoneMatch = req.headers['if-none-match'] || null;
  const parsed = url.parse(req.url, true);
  try {
    // #218 (Cloud-Slice 4): CORS für das Cloudflare-Frontend → Render-Backend.
    // Header werden früh via setHeader gesetzt (writeHead merged sie); eine
    // Preflight-OPTIONS wird sofort mit 204 beantwortet. Leere Allowlist
    // (Mini/same-origin) ⇒ inert. Origin-Echo nur für erlaubte Origins.
    const corsAllow = corsAllowedOrigins();
    if (corsAllow.length) {
      const ch = corsHeadersFor(req.headers.origin, corsAllow);
      for (const [k, v] of Object.entries(ch)) res.setHeader(k, v);
      if (isPreflight(req)) { res.writeHead(Object.keys(ch).length ? 204 : 403); res.end(); return; }
    }

    // #117: Health-Check — spiegelt die Bereitschaft der Mandanten-Registry.
    // Initialer Registry-Load-Fehler ⇒ 503 (fail-closed sichtbar); ohne PG (Dev/Test)
    // gilt die Registry als „nicht anwendbar" ⇒ gesund.
    if (parsed.pathname === '/health') {
      const healthy = tenantDirectoryHealthy();
      sendJson(res, healthy ? 200 : 503, {
        ok: healthy,
        tenantDirectoryReady: !!(tenantDirectory && tenantDirectory.isReady()),
        tenantDbReady: !!tenantDb, // #122: Stufe-3-Mandanten-Tür konstruiert (noch nicht konsumiert)
        pgConfigured: !!dashboardV2PgUrl(),
      });
      return;
    }

    // #217 (Cloud-Slice 3): geschützte Job-Trigger /internal/jobs/<key> — von der
    // Cron-Quelle (Supabase pg_cron→pg_net) aufgerufen, NIE vom Frontend (kein
    // CORS, eigener Präfix). Ohne WORKER_TRIGGER_SECRET ist der Pfad tot (404).
    if (parsed.pathname.startsWith('/internal/jobs/')) {
      const jobKey = decodeURIComponent(parsed.pathname.slice('/internal/jobs/'.length));
      await handleInternalJobTrigger(req, res, jobKey);
      return;
    }

    // #118: Break-Glass-Durchsetzung — zentral VOR allen Endpunkten. Greift nur,
    // wenn der X-Support-Tenant-Header gesetzt ist; auditiert jeden Fall an die
    // bestehende Senke. Aktiver Override + Schreibmethode ⇒ 403 (read-only);
    // nicht-existenter Ziel-Mandant ⇒ 404; ungültiger Header (kein Admin / untrauter
    // Pfad) ⇒ ignoriert (Heimat-Mandant), aber auditiert.
    if (req.headers['x-support-tenant']) {
      const bgViewer = getViewer(req);
      const bg = breakGlassDecision(bgViewer, req.method);
      if (bg.kind !== 'none') {
        auditAction(bgViewer, bg.auditEvent, breakGlassAuditFields(bgViewer, req, parsed), bg.outcome);
        if (bg.kind === 'block') {
          sendJson(res, bg.status, { ok: false, error: { code: bg.code, message: bg.status === 404 ? 'Mandant nicht gefunden.' : 'Support-Sitzung ist nur-lesend.' } });
          return;
        }
        // 'allow' (lesender Override) / 'ignore' (entwerteter Header): Request läuft weiter.
      }
    }

    if (parsed.pathname === '/api/v2/viewer') {
      const viewer = getViewer(req);
      sendJson(res, 200, { ok: true, viewer: viewerPublic(viewer) });
      return;
    }

    // #219 (Cutover-Abschluss): Statusseite-Datenquelle. Aggregiert /health +
    // die letzten Job-Läufe (audit.workflow_runs, Infra-Verbindung).
    // Sicherheit (Audit M3, 2026-06-12): Die DETAILS (Job-Namen, Frische, DB-
    // Status) sind eine Architektur-Landkarte ⇒ nur für eingeloggte Betreiber.
    // Öffentlich (anonym) gibt es NUR die grobe Ampel (overall), keine Internas.
    if (parsed.pathname === '/api/v2/status') {
      const health = {
        ok: tenantDirectoryHealthy(),
        tenantDirectoryReady: !!(tenantDirectory && tenantDirectory.isReady()),
        pgConfigured: !!dashboardV2PgUrl(),
      };
      let jobRuns = [];
      if (infraPgQuery) {
        try {
          // Letzter Lauf je workflow_key (DISTINCT ON, jüngster zuerst).
          const r = await infraPgQuery(
            `SELECT DISTINCT ON (workflow_key) workflow_key, status, finished_at
               FROM audit.workflow_runs
              WHERE finished_at > NOW() - INTERVAL '3 days'
              ORDER BY workflow_key, finished_at DESC NULLS LAST`, []);
          jobRuns = r.rows;
        } catch { /* DB optional ⇒ Jobs erscheinen als unknown */ }
      }
      const { buildStatus } = require('./lib/status-page.js');
      const status = buildStatus({ health, jobRuns });
      const statusCode = status.overall === 'down' ? 503 : 200;
      const statusViewer = getViewer(req);
      const body = statusViewer.canTriggerActions
        ? { ok: true, ...status } // eingeloggter Betreiber: volle Details
        : { ok: true, overall: status.overall, generatedAt: status.generatedAt }; // öffentlich: nur Ampel
      sendJson(res, statusCode, body);
      return;
    }

    // #215 (Auth-Naht): öffentliche Login-Konfiguration fürs Frontend. Der anonKey
    // ist Supabases öffentlicher Browser-Key (by design kein Secret); mode steuert,
    // ob das Frontend die Login-Wand zeigt (supabase) oder wie bisher läuft (tailscale).
    if (parsed.pathname === '/api/v2/auth/config') {
      const auth = supabaseAuthSettings();
      sendJson(res, 200, { ok: true, mode: auth.mode, supabaseUrl: auth.supabaseUrl, anonKey: auth.anonKey });
      return;
    }

    if (parsed.pathname === '/api/dashboard') {
      const viewer = getViewer(req);
      auditGuestAccess(viewer, 'dashboard_view');
      const dashboard = await buildDashboard();
      sendJson(res, 200, {
        ...dashboard,
        viewer: viewerPublic(viewer),
      });
      return;
    }

    const v2Area = [...dashboardV2Areas.entries()]
      .find(([, config]) => parsed.pathname === config.path);
    if (v2Area && req.method === 'GET') {
      const areaViewer = getViewer(req); // #123: Mandant für die mandanten-getrennten Lesepfade
      if (v2Area[0] === 'economics') { // #80: GuV ist finanzen.lesen-Bereich
        if (!requireCapability(areaViewer, 'finanzen.lesen', res)) return;
      }
      const result = await buildDashboardV2Area(v2Area[0], parsed.query, areaViewer);
      sendJson(res, result.status, result.body);
      return;
    }

    // ── Refill routes ─────────────────────────────────────────────────────────

    // Produkt-Katalog für die Slot-Palette: ALLE Produkte (auch ohne aktiven
    // Slot), damit neue Produkte überhaupt zugewiesen werden können. Bewusst
    // getrennt von /refill/search (das nur belegte Slots liefert).
    if (parsed.pathname === '/api/v2/products/catalog' && req.method === 'GET') {
      const viewer = getViewer(req); // #141: Mandant für den tenant-gefilterten Produkt-Katalog
      const q = clean(parsed.query.q || '');
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, results: [], error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        // #141: durch die Mandanten-Tür mit tenant_id-Filter (kein Inline-Client).
        const { rows } = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['products'],
          text: `SELECT p.product_id, p.product_key, p.name
                 FROM automatenlager.products p
                 WHERE p.tenant_id = $1
                 ORDER BY p.name`,
          params: [],
        });
        sendJson(res, 200, { ok: true, results: buildProductCatalog(rows, q) });
      } catch (err) {
        sendJson(res, 503, { ok: false, results: [], error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // #221: Arbeitsvorrat — nachbuchungsbedürftige Verkäufe (gross=0) auffindbar machen.
    // Admin-only (operativer Vorrat); tenant-scoped durch die Tür.
    if (parsed.pathname === '/api/v2/reconcile/backlog' && req.method === 'GET') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditDenied(viewer, 'reconcile_backlog_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Nur Admins sehen den Nachbuch-Arbeitsvorrat.' } });
        return;
      }
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        const backlog = await readReconcileBacklog(tenantDb, viewer.tenantId);
        sendJson(res, 200, { ok: true, backlog });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/refill/search' && req.method === 'GET') {
      const viewer = getViewer(req); // #126: Mandant für die Refill-Bestands-Vorschau
      const pgUrl = dashboardV2PgUrl();
      const q = clean(parsed.query.q || '');
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, results: [], error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        // #126: durch die Mandanten-Tür mit tenant_id-Filter (kein Inline-Client).
        const { rows } = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['slot_assignments', 'machines', 'locations', 'products'],
          text: `
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
          JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
          JOIN automatenlager.locations l ON l.location_id = m.location_id AND l.tenant_id = m.tenant_id
          JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
          WHERE sa.active = true AND sa.tenant_id = $1
          ORDER BY p.name, sa.machine_id, sa.mdb_code
        `,
          params: [],
        });
        const results = searchRefillTargets(q, rows.map((r) => ({ ...r, product_name: formatProductName(r.product_name || '') })));
        sendJson(res, 200, { ok: true, results });
      } catch (err) {
        sendJson(res, 503, { ok: false, results: [], error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/refill/details' && req.method === 'GET') {
      const viewer = getViewer(req); // #126: Mandant für die Refill-Detail-Vorschau
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
      if (!tenantReadReady(res)) return;
      try {
        // #126: durch die Mandanten-Tür mit tenant_id-Filter (kein Inline-Client).
        const slotResult = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['slot_assignments', 'machines', 'locations', 'products'],
          text: `
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
          JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
          JOIN automatenlager.locations l ON l.location_id = m.location_id AND l.tenant_id = m.tenant_id
          JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
          WHERE sa.tenant_id = $1 AND sa.machine_id = $2 AND sa.mdb_code = $3 AND sa.active = true
          LIMIT 1
        `,
          params: [machineId, mdbCode],
        });
        if (!slotResult.rows.length) {
          sendJson(res, 404, { ok: false, error: { code: 'SLOT_NOT_FOUND', message: 'Slot nicht gefunden.' } });
          return;
        }
        const slotRow = slotResult.rows[0];
        const batchResult = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['stock_batches'],
          text: `
          SELECT batch_key, product_id, remaining_qty, mhd_date::text AS mhd_date, status, unit_cost_net::text AS unit_cost_net
          FROM automatenlager.stock_batches
          WHERE tenant_id = $1 AND product_id = $2 AND remaining_qty > 0 AND status IN (${availableBatchStatusSqlList()})
          ORDER BY mhd_date ASC NULLS LAST
        `,
          params: [slotRow.product_id],
        });
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
        auditDenied(viewer, 'refill_trigger_denied', {});
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
      // #133 (Stufe 4): Mandant kommt NUR aus dem Viewer — tenant_id/mandant_id im Body ⇒ 400 + Audit.
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const { machine_id, mdb_code, product_id, qty, product_name, notes } = body || {};
      if (!machine_id || !mdb_code || !product_id || !qty) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: 'machine_id, mdb_code, product_id, qty erforderlich.' } });
        return;
      }
      // #133 (Stufe 4, IDOR): Automat muss real zum Mandanten des Viewers gehören.
      // Nach der Pflichtfeld-Validierung (malformte Requests ⇒ 400, kein Lookup);
      // fremd/unbekannt ⇒ 404 + Audit, BEVOR der n8n-Webhook ausgelöst wird.
      if (!(await requireMachineAccess(viewer, machine_id, res, 'idor:refill'))) return;
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      // Stufe 6 Slice 2 (#162): WF7 in-process. Schreibpfad (slot_assignments-Update,
      // warnings-resolve, stock_movement) atomar DURCH die Tür (db.tx, tenant_id = $1) —
      // kein fetch(n8n) mehr. n8n-WF7 wird deploy-seitig deaktiviert (HANDOVER).
      let wfResult = { ok: false, status_ref: null, message: '' };
      let refill;
      try {
        refill = await applyRefill(tenantDb, viewer.tenantId, {
          machineKey: machine_id,
          mdbCode: mdb_code,
          productId: product_id,
          qty,
          notes,
        });
      } catch (err) {
        refill = null;
        wfResult = { ok: false, status_ref: null, message: `Nachfüllung fehlgeschlagen: ${err.message}` };
      }
      if (refill && refill.ok === false && refill.code === 'SLOT_NOT_FOUND') {
        sendJson(res, 404, { ok: false, error: { code: 'SLOT_NOT_FOUND', message: 'Kein aktiver Slot für diese Maschine/MDB/Produkt-Kombination.' } });
        return;
      }
      if (refill && refill.ok) {
        wfResult = {
          ok: true,
          status_ref: `nachfuellung-${Date.now()}`,
          message: `Nachfüllung erfasst: Slot ${refill.product_slot_key} = ${refill.new_qty}`
            + (refill.hints_resolved ? `, ${refill.hints_resolved} Hinweis(e) aufgelöst` : '')
            + (refill.stock_movement ? ', Umbuchung gebucht' : ''),
          summary: refill,
        };
      }
      const auditEntry = buildRefillAuditEntry(viewer, { machine_id, mdb_code, product_id, qty }, wfResult);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'refill_action', auditEntry, auditEntry.ok === false ? 'denied' : 'ok');
      sendJson(res, wfResult.ok ? 200 : 502, {
        ok: wfResult.ok,
        status_ref: auditEntry.status_ref,
        message: wfResult.message,
        ...(wfResult.ok ? { summary: refill } : { error: { code: 'WF7_ERROR', message: wfResult.message } }),
      });
      return;
    }

    // ── WF2-Freigabe (Mensch-im-Loop): Rechnungsvorschlag freigeben ────────────
    // Stufe 6 Slice 3 (#163): WF2 in-process. Freigabe einer Position legt
    // Produkt (optional) + Alias + Lagercharge an — atomar DURCH die Tür (db.tx,
    // tenant_id=$1, faithful zu pgw_write product/product_alias/stock_batch).
    if (parsed.pathname === '/api/v2/invoice-proposal/approve' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditDenied(viewer, 'invoice_proposal_approve_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Read-Only-Benutzer duerfen keine Rechnungsvorschlaege freigeben.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => { resolve(data); });
          req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const { product_key, batch_id } = body || {};
      if (!product_key || !batch_id) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: 'product_key und batch_id erforderlich.' } });
        return;
      }
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      let result; let ok = true; let message = '';
      try {
        result = await applyProductBatch(tenantDb, viewer.tenantId, { decision: body });
        message = `Freigabe erfasst: ${result.products} Produkt(e), ${result.aliases} Alias(e), ${result.batches} Charge(n)`;
      } catch (err) {
        ok = false; message = `Freigabe fehlgeschlagen: ${err.message}`;
      }
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'invoice_proposal_action', { product_key, batch_id, message }, ok ? 'ok' : 'denied');
      sendJson(res, ok ? 200 : 502, ok ? { ok, message, summary: result } : { ok, error: { code: 'WF2_ERROR', message } });
      return;
    }

    // ── G&V VK/EK-Korrektur (#193): Stammdaten go-forward durch die Tür ────────
    if ((parsed.pathname === '/api/v2/economics/correct-ek' || parsed.pathname === '/api/v2/economics/correct-vk') && req.method === 'POST') {
      const isEk = parsed.pathname.endsWith('correct-ek');
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditDenied(viewer, 'economics_correct_denied', { field: isEk ? 'ek' : 'vk' });
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Read-Only-Benutzer duerfen keine Preise korrigieren.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = ''; req.on('data', (c) => { data += c; }); req.on('end', () => { resolve(data); }); req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const productId = body && body.product_id;
      const value = isEk ? (body && body.unit_cost_net) : (body && body.sale_price_gross);
      const check = validateCorrection({ field: isEk ? 'ek' : 'vk', value, productId });
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_CORRECTION', message: check.errors.join('; ') } });
        return;
      }
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      let result; let ok = true; let message = '';
      try {
        result = isEk
          ? await applyEkCorrection(tenantDb, viewer.tenantId, { productId, unitCostNet: check.value })
          : await applyVkCorrection(tenantDb, viewer.tenantId, { productId, salePriceGross: check.value });
        const n = isEk ? result.batchesUpdated : result.pricesUpdated;
        ok = n > 0;
        message = ok ? `${isEk ? 'EK' : 'VK'} korrigiert (${n} Zeile(n), go-forward)` : `Keine aktive ${isEk ? 'Charge' : 'Preiszeile'} für Produkt ${productId} gefunden`;
      } catch (err) { ok = false; message = `Korrektur fehlgeschlagen: ${err.message}`; }
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'economics_correction_action', { field: isEk ? 'ek' : 'vk', product_id: productId, value: check.value, message }, ok ? 'ok' : 'denied');
      sendJson(res, ok ? 200 : (result ? 404 : 502), ok ? { ok, message, summary: result } : { ok, error: { code: 'CORRECTION_FAILED', message } });
      return;
    }

    // ── Inventory write-off (Aussortieren / Ausbuchen) ─────────────────────────
    // Setzt eine Charge auf status='ausgesondert' + remaining_qty=0 (PG-direkt,
    // kein Sheet-Patch). Guard per FOR UPDATE: nur verfügbare, nicht-leere
    // Chargen; optimistic lock über expected_remaining_qty. Issue #21.
    if (parsed.pathname === '/api/v2/inventory/write-off' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('bestand.schreiben')) {
        auditDenied(viewer, 'write_off_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Read-Only-Benutzer dürfen keine Charge ausbuchen.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      // #138: Mandant kommt NUR aus dem Viewer — tenant_id/mandant_id im Body ⇒ 400 + Audit.
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const check = validateWriteOff(body);
      if (!check.valid) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: check.errors.map((e) => e.message).join(' ') } });
        return;
      }
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      const expectedRemaining = body && body.expected_remaining_qty;
      let outcome;
      try {
        // #138: SELECT … FOR UPDATE + UPDATE (stock_batches/warnings) atomar DURCH die
        // Tür (tenant_id = $1). Eine fremde Charge ist im tenant-gefilterten SELECT
        // unsichtbar ⇒ NOT_FOUND, keine Änderung an fremden Daten.
        outcome = await writeOffBatchPg(tenantDb, viewer.tenantId, check.batch_key, expectedRemaining);
      } catch (err) {
        if (['NOT_FOUND', 'ALREADY_WRITTEN_OFF', 'EMPTY', 'DRIFT'].includes(err.code)) {
          const statusCode = err.code === 'NOT_FOUND' ? 404 : 409;
          const messages = {
            NOT_FOUND: 'Charge nicht gefunden.',
            ALREADY_WRITTEN_OFF: 'Charge ist bereits ausgebucht.',
            EMPTY: 'Charge hat keinen Bestand mehr.',
            DRIFT: `Bestand hat sich geändert (jetzt ${err.verdict && err.verdict.remaining_qty}). Bitte neu laden.`,
          };
          sendJson(res, statusCode, { ok: false, error: { code: err.code, message: messages[err.code] || 'Ausbuchen nicht möglich.' } });
          return;
        }
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
        return;
      }
      outcome.message = `${outcome.written_off_qty} Stk. ausgebucht (${check.reason}).`;
      const auditEntry = buildWriteOffAuditEntry(viewer, check, outcome);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'writeoff_action', auditEntry);
      sendJson(res, 200, { ok: true, data: { batch_key: check.batch_key, product_id: outcome.product_id, written_off_qty: outcome.written_off_qty }, message: outcome.message });
      return;
    }

    // ── Inline-Inventur: Chargenrest (Lager) auf gezählten Ist-Wert setzen ─────
    // #152: Setzt NUR stock_batches.remaining_qty (durch die Tür, atomar in db.tx,
    // optimistic lock). machine_qty ("Im Automaten", Nayax) bleibt unberührt.
    if (parsed.pathname === '/api/v2/inventory/set-count' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('bestand.schreiben')) {
        auditDenied(viewer, 'inventory_set_count_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Read-Only-Benutzer dürfen den Bestand nicht ändern.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      // Mandant kommt NUR aus dem Viewer — tenant_id/mandant_id im Body ⇒ 400 + Audit.
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const check = validateInventoryCount(body);
      if (!check.valid) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: check.errors.map((e) => e.message).join(' ') } });
        return;
      }
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      let outcome;
      try {
        outcome = await setBatchCountPg(tenantDb, viewer.tenantId, check.batch_key, check.new_qty, body && body.expected_remaining_qty);
      } catch (err) {
        if (['NOT_FOUND', 'ALREADY_WRITTEN_OFF', 'OUT_OF_RANGE', 'DRIFT'].includes(err.code)) {
          const statusCode = err.code === 'NOT_FOUND' ? 404 : 409;
          const messages = {
            NOT_FOUND: 'Charge nicht gefunden.',
            ALREADY_WRITTEN_OFF: 'Charge ist ausgebucht — nutze stattdessen Aussortieren.',
            OUT_OF_RANGE: `Wert muss zwischen 0 und ${err.verdict && err.verdict.initial_qty} liegen (Chargengröße).`,
            DRIFT: `Bestand hat sich geändert (jetzt ${err.verdict && err.verdict.remaining_qty}). Bitte neu laden.`,
          };
          sendJson(res, statusCode, { ok: false, error: { code: err.code, message: messages[err.code] || 'Bestand setzen nicht möglich.' } });
          return;
        }
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
        return;
      }
      outcome.message = `Chargenrest auf ${outcome.new_qty} Stk. gesetzt (war ${outcome.previous_qty}).`;
      const auditEntry = buildInventoryCountAuditEntry(viewer, body, outcome);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'inventory_count_action', auditEntry);
      sendJson(res, 200, { ok: true, data: { batch_key: check.batch_key, product_id: outcome.product_id, previous_qty: outcome.previous_qty, new_qty: outcome.new_qty }, message: outcome.message });
      return;
    }

    // ── Inventory batch search (Chargensuche nach Produktname) ───────────────

    if (parsed.pathname === '/api/v2/inventory/batch-search' && req.method === 'GET') {
      const viewer = getViewer(req);
      if (!viewer.can('betrieb.lesen')) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Kein Zugriff.' } });
        return;
      }
      const q = clean(parsed.query.q || '');
      if (q.length < 2) {
        sendJson(res, 200, { ok: true, batches: [] });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        // #141: durch die Mandanten-Tür mit tenant_id-Filter (kein Inline-Client).
        const result = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['stock_batches', 'products'],
          text: `SELECT
                   sb.batch_key,
                   sb.batch_id,
                   sb.remaining_qty,
                   sb.status,
                   sb.mhd_date::text    AS mhd_date,
                   sb.received_at::text AS received_at,
                   p.name               AS product_name,
                   p.product_id
                 FROM automatenlager.stock_batches sb
                 JOIN automatenlager.products p
                   ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
                 WHERE sb.tenant_id = $1
                   AND p.name ILIKE $2
                   AND sb.status <> 'ausgesondert'
                 ORDER BY p.name, sb.received_at ASC
                 LIMIT 50`,
          params: [`%${q}%`],
        });
        sendJson(res, 200, { ok: true, batches: result.rows });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Lagerchargen mit EK-Preis (Admin-Liste) ──────────────────────────────
    // GET /api/v2/batches — alle aktiven Chargen mit unit_cost_net, für Admin-EK-Korrektur.
    // #209: Basis für die Charge-selektive EK-Korrektur (put /api/v2/batches/unit-cost).

    if (parsed.pathname === '/api/v2/batches' && req.method === 'GET') {
      const viewer = getViewer(req);
      if (!viewer.can('betrieb.lesen')) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Kein Zugriff.' } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        const result = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['stock_batches', 'products'],
          text:
            `SELECT sb.batch_key,
                    sb.batch_id,
                    sb.product_id,
                    p.name              AS product_name,
                    sb.received_at::date::text AS received_at,
                    sb.mhd_date::text   AS mhd_date,
                    sb.remaining_qty,
                    sb.status,
                    sb.unit_cost_net::text AS unit_cost_net
               FROM automatenlager.stock_batches sb
               JOIN automatenlager.products p
                 ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
              WHERE sb.tenant_id = $1
                AND sb.status IN (${availableBatchStatusSqlList()})
                AND sb.remaining_qty > 0
              ORDER BY p.name ASC, sb.received_at ASC`,
          params: [],
        });
        sendJson(res, 200, {
          ok: true,
          is_admin: viewer.role === 'admin',
          canTriggerActions: viewer.canTriggerActions,
          batches: result.rows.map((r) => ({
            batch_key:    String(r.batch_key || ''),
            batch_id:     Number(r.batch_id),
            product_id:   Number(r.product_id),
            product_name: formatProductName(String(r.product_name || '')),
            received_at:  r.received_at || null,
            mhd_date:     r.mhd_date || null,
            remaining_qty: Number(r.remaining_qty) || 0,
            status:       String(r.status || ''),
            unit_cost_net: r.unit_cost_net != null ? Number(r.unit_cost_net) : null,
          })),
        });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── EK-Preis einer Lagercharge korrigieren + GuV restaten ─────────────────
    // PUT /api/v2/batches/unit-cost — Admin-only. Ändert unit_cost_net für EINE
    // Charge und restated betroffene guv_daily-Zeilen. #209.

    if (parsed.pathname === '/api/v2/batches/unit-cost' && req.method === 'PUT') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditDenied(viewer, 'batch_ek_correction_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Nur Admins können den EK-Preis einer Charge korrigieren.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = ''; req.on('data', (c) => { data += c; }); req.on('end', () => { resolve(data); }); req.on('error', reject);
        }));
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const check = validateBatchEkUpdate({ batchKey: body && body.batch_key, unitCostNet: body && body.unit_cost_net });
      if (!check.ok) {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_PARAMS', message: check.errors.join('; ') } });
        return;
      }
      if (!tenantDb) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      const runId = `batch-ek-${Date.now()}-${viewer.login || 'admin'}`;
      let result; let ok = true; let message = '';
      try {
        result = await applyBatchEkUpdate(tenantDb, viewer.tenantId, {
          batchKey: String(body.batch_key),
          unitCostNet: check.value,
          runId,
          executedBy: viewer.login || 'admin',
        });
        message = `EK für Charge ${result.batchKey} korrigiert (${result.oldUnitCost} → ${result.newUnitCost} €); ${result.guvRestated} GuV-Zeile(n) restated`;
      } catch (err) {
        ok = false;
        message = err.code === 'BATCH_NOT_FOUND'
          ? `Charge nicht gefunden: ${body.batch_key}`
          : `Korrektur fehlgeschlagen: ${err.message}`;
      }
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'batch_ek_correction_action', { batch_key: body.batch_key, new_unit_cost_net: check.value, run_id: runId, message }, ok ? 'ok' : 'denied');
      sendJson(res, ok ? 200 : (result ? 404 : 502), ok ? { ok, message, summary: result } : { ok: false, error: { code: 'CORRECTION_FAILED', message } });
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
      if (!tenantReadReady(res)) return;
      try {
        const rawData = await queryProductOnboardingPg(tenantDb, viewer.tenantId);
        const data = buildProductOnboardingData(rawData);
        let wf2FormUrl = '';
        try {
          const n8nExtUrl = dashboardConfig().n8nExternalUrl;
          const wf2 = workflowFiles
            .filter((fn) => fn.includes('WF2') && fs.existsSync(path.join(ROOT, fn)))
            .map((fn) => { try { return summarizeN8nWorkflow(readJson(fn)); } catch { return null; } })
            .filter(Boolean)[0];
          wf2FormUrl = firstFormUrl(n8nExtUrl, wf2 || {});
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
      const viewer = getViewer(req); // #128: Mandant für die Slot-Umbuchungs-Vorschau
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
      if (!tenantReadReady(res)) return;
      try {
        // #128: durch die Mandanten-Tür mit tenant_id-Filter (kein Inline-Client).
        const whereClause = slotAssignmentId
          ? 'sa.slot_assignment_id = $2'
          : 'sa.machine_id = $2 AND sa.mdb_code = $3 AND sa.active = true';
        const queryParams = slotAssignmentId ? [slotAssignmentId] : [machineId, mdbCode];
        const slotResult = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['slot_assignments', 'machines', 'locations', 'products'],
          text:
          `SELECT sa.slot_assignment_id, sa.machine_id::text AS machine_id,
                  m.name AS machine_label, sa.mdb_code, sa.product_id,
                  p.name AS product_name, sa.current_machine_qty,
                  sa.target_stock, sa.machine_capacity,
                  l.name AS location_name
             FROM automatenlager.slot_assignments sa
             JOIN automatenlager.machines m ON m.machine_id = sa.machine_id AND m.tenant_id = sa.tenant_id
             JOIN automatenlager.locations l ON l.location_id = m.location_id AND l.tenant_id = m.tenant_id
             JOIN automatenlager.products p ON p.product_id = sa.product_id AND p.tenant_id = sa.tenant_id
            WHERE sa.tenant_id = $1 AND ${whereClause}
            LIMIT 1`,
          params: queryParams,
        });
        if (!slotResult.rows.length) {
          sendJson(res, 404, { ok: false, error: { code: 'SLOT_NOT_FOUND', message: 'Slot nicht gefunden.' } });
          return;
        }
        const productResult = await tenantDb.read({
          tenant: viewer.tenantId,
          tables: ['products'],
          text: 'SELECT product_id, name FROM automatenlager.products WHERE active = true AND tenant_id = $1 ORDER BY name',
          params: [],
        });
        const preview = buildSlotChangePreview(slotResult.rows[0], productResult.rows);
        sendJson(res, 200, { ok: true, ...preview });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/slot-change/confirm' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('bestand.schreiben')) {
        auditDenied(viewer, 'slot_change_denied', {});
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
      // #33/#117 (IDOR): Automat muss real zum Mandanten des Viewers gehören. Nach
      // der Eingabe-Validierung (malformte Requests ⇒ 400, kein Mandanten-Lookup;
      // 400 leakt nichts über Objekt-Existenz). machine_id ist hier garantiert da.
      if (!(await requireMachineAccess(viewer, machine_id, res, 'idor:slot-change'))) return;
      if (!slot_assignment_id) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: 'slot_assignment_id erforderlich.' } });
        return;
      }
      const slotRow = { slot_assignment_id, machine_id, mdb_code: Number(mdb_code), product_id: 0 };
      const payload = buildSlotChangePayload(slotRow, { new_product_id, new_qty: Number(new_qty ?? 0), start_date });
      // n8n-Ablösung (2026-06-11): Produktwechsel läuft als close(alt)+open(neu)
      // atomar DURCH die Tür (db.tx) — der frühere SLOT_CHANGE_WEBHOOK_URL-Pfad
      // (n8n WF4) ist abgelöst.
      let wfResult;
      try {
        const r = await applySlotChange(tenantDb, viewer.tenantId, {
          slot_assignment_id, new_product_id, new_qty: Number(new_qty ?? 0), start_date,
        });
        wfResult = {
          ok: true,
          status_ref: `sc-${Date.now()}`,
          message: `Produktwechsel gebucht (geschlossen: ${r.closed}, neu: ${r.opened}).`,
        };
      } catch (err) {
        const status = err.code === 'SLOT_NOT_FOUND' || err.code === 'PRODUCT_NOT_FOUND' ? 404 : 502;
        wfResult = { ok: false, status: status, status_ref: null, message: `Produktwechsel fehlgeschlagen: ${err.message}` };
      }
      const auditEntry = buildSlotChangeAuditEntry(viewer, payload, wfResult);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'slot_change_action', auditEntry);
      sendJson(res, wfResult.ok ? 200 : (wfResult.status || 502), {
        ok: wfResult.ok,
        status_ref: auditEntry.status_ref,
        message: wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'SLOT_CHANGE_FAILED', message: wfResult.message } }),
      });
      return;
    }

    const v2ActionMatch = parsed.pathname.match(/^\/api\/v2\/actions\/([^/]+)\/trigger$/);
    if (v2ActionMatch && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        auditDenied(viewer, 'v2_action_trigger_denied', {
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
        auditDenied(viewer, 'v2_upload_denied', { target: routeTarget });
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

      // n8n-Ablösung (2026-06-11): Rechnungs-Uploads gehen DIREKT in den
      // Drive-Ordner Rechnungseingang (GOOGLE_DRIVE_INVOICE_*); der Worker-Job
      // wf1-invoice-intake pollt ihn. Der Webhook-Pfad darunter bleibt nur als
      // Fallback, solange kein Invoice-Drive konfiguriert ist.
      if (routeTarget === 'invoice') {
        const inv = getInvoiceDrive();
        if (inv && inv.drive) {
          try {
            const uploaded = await inv.drive.upload(validatedFile.fileName, validatedFile.data, validatedFile.mimeType);
            sendJson(res, 200, {
              ok: true,
              viewer,
              target: routeTarget,
              upload: {
                fileName: validatedFile.fileName,
                mimeType: validatedFile.mimeType,
                sizeBytes: validatedFile.sizeBytes,
              },
              workflow: {
                id: null,
                name: 'Rechnungseingang (Drive direkt, Worker-Intake)',
                method: 'DRIVE',
                webhookPath: '(drive)',
                status: 'accepted',
                driveFileId: uploaded.id,
              },
              error: null,
            });
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
                code: 'DRIVE_UPLOAD_FAILED',
                message: `Upload in den Drive-Ordner fehlgeschlagen: ${error.message}`,
              },
            });
          }
          return;
        }
      }

      // Optionaler gezielter Override: postet die Datei direkt an einen festen
      // Webhook (z. B. die Mini-n8n), unabhaengig von der allgemeinen n8n-Basis
      // des Dashboards. Prozess-Env hat Vorrang vor .env.local. Es zaehlt nur ein
      // echter http(s)-URL-Wert — alles andere (leer, Platzhalter) = Override aus.
      let directWebhookUrl = '';
      if (targetConfig.directWebhookEnv) {
        const fromProcess = process.env[targetConfig.directWebhookEnv];
        const fromFile = loadLocalEnv()[targetConfig.directWebhookEnv];
        const raw = clean(fromProcess !== undefined ? fromProcess : fromFile);
        if (/^https?:\/\//i.test(raw)) directWebhookUrl = raw;
      }

      let workflow;
      if (directWebhookUrl) {
        workflow = {
          id: null,
          name: `${targetConfig.label} Upload (direkter Webhook)`,
          webhookPath: '(direct)',
          method: 'POST',
          url: directWebhookUrl,
        };
      } else {
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

        workflow = resolveV2UploadWorkflow(targetConfig, n8n);
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
      // #30: Config (auch maskiert) ist System-Info → nur mit system.verwalten.
      if (!requireCapability(getViewer(req), 'system.verwalten', res)) return;
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
      // #30 (SPEC F3): Schreiben von Zugangsdaten erfordert system.verwalten.
      // VOR dem 409-Env-Check, damit Unbefugte 403 sehen (kein Info-Leak, ob ein
      // Env-Key gesetzt ist). Der Env-Vorrang ist KEINE Sicherheit für sich.
      const configViewer = getViewer(req);
      if (!requireCapability(configViewer, 'system.verwalten', res)) return;
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
      // #32: Config-Änderung protokollieren — NUR welche Felder, NIE der Key-Wert.
      auditAction(configViewer, 'config_write', { changed: Object.keys(update), apiKeyChanged: !!update.n8nApiKey }, 'ok');
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
        auditDenied(viewer, 'action_trigger_denied', {
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
        // #32: Workflow-Trigger protokollieren (actionId + Ergebnis; NICHT die
        // Webhook-Antwort, die könnte Nutzdaten enthalten).
        auditAction(viewer, 'workflow_trigger', { actionId: action.id, workflowId: action.workflowId }, response.ok ? 'ok' : 'error');
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
      const viewer = getViewer(req); // #123: Mandant für den Finanz-Export
      if (!requireCapability(viewer, 'finanzen.lesen', res)) return; // #80
      if (!tenantReadReady(res)) return; // #123: DB/Verzeichnis-Ausfall ⇒ 503, nicht leer
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      // Voller Zeitraum-Query wie die GuV-Seite (Monat/Quartal/Jahr/Eigener)
      // plus optionaler Standort-/Automaten-Filter (?machines=ID1,ID2).
      const exportQuery = {
        mode:     clean(parsed.query.mode),
        year:     clean(parsed.query.year),
        quarter:  clean(parsed.query.quarter),
        from:     clean(parsed.query.from),
        to:       clean(parsed.query.to),
        machines: clean(parsed.query.machines),
      };
      try {
        const rawData = await queryEconomicsPg(tenantDb, viewer.tenantId, exportQuery);
        const economicsData = buildEconomicsData(rawData, exportQuery);
        const { from, to } = economicsData.period;
        // Brutto-Werte wie auf der Seite, sortiert nach Brutto-Umsatz,
        // mit Summenzeile + UTF-8-BOM für sauberes Excel.
        const rows = [...economicsData.byProduct].sort((a, b) => b.revenue_gross - a.revenue_gross);
        const csv = buildReportCsv(rows);
        const filename = buildReportFilename(from, to, 'csv');
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

    // ── PDF-Export (GuV-Bericht als echte Datei) ──────────────────────────────

    if (parsed.pathname === '/api/v2/reports/pdf' && req.method === 'GET') {
      const viewer = getViewer(req); // #123: Mandant für den GuV-PDF-Report
      if (!requireCapability(viewer, 'finanzen.lesen', res)) return; // #80: viewer war undefiniert
      if (!tenantReadReady(res)) return; // #123: DB/Verzeichnis-Ausfall ⇒ 503, nicht leer
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      const exportQuery = {
        mode:     clean(parsed.query.mode),
        year:     clean(parsed.query.year),
        quarter:  clean(parsed.query.quarter),
        from:     clean(parsed.query.from),
        to:       clean(parsed.query.to),
        machines: clean(parsed.query.machines),
      };
      try {
        const rawData = await queryEconomicsPg(tenantDb, viewer.tenantId, exportQuery);
        const economicsData = buildEconomicsData(rawData, exportQuery);
        const { from, to } = economicsData.period;
        const rows = [...economicsData.byProduct].sort((a, b) => b.revenue_gross - a.revenue_gross);
        const totals = economicsData.totals || {};
        const prov = economicsData.provisional || { hasProvisional: false };
        const withProv = economicsData.totalsWithProvisional || totals;
        const sumRev = prov.hasProvisional ? withProv.revenue_gross : totals.revenue_gross;
        const sumGuv = prov.hasProvisional && prov.hasCost ? withProv.gross_profit : totals.gross_profit;
        const sumQty = prov.hasProvisional ? withProv.qty : totals.qty;
        const marge  = Number(sumRev) > 0 ? (sumGuv / sumRev) * 100 : 0;

        const fmtEur = (n) => { const v = Number(n); return Number.isFinite(v) ? v.toFixed(2).replace('.', ',') + ' €' : '–'; };
        const fmtPct = (n) => { const v = Number(n); return Number.isFinite(v) ? v.toFixed(1).replace('.', ',') + ' %' : '–'; };
        const periodLabel = `${from} – ${to}`;
        const todayStr = new Date().toLocaleDateString('de-DE');

        const pdf = buildGuvPdf({
          title:   'GuV-Bericht',
          period:  periodLabel,
          machine: clean(parsed.query.machines) || 'Alle Automaten',
          today:   todayStr,
          kpis: [
            { label: 'Umsatz (brutto)', value: fmtEur(sumRev) },
            { label: 'GuV (brutto)',    value: fmtEur(sumGuv) },
            { label: 'Marge',          value: fmtPct(marge)  },
            { label: 'Stück',          value: String(Math.round(Number(sumQty) || 0)) },
          ],
          rows,
        });
        const filename = buildReportFilename(from, to, 'pdf');
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdf.length,
          'Content-Disposition': `attachment; filename="${filename}"`,
        });
        res.end(pdf);
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Einstellungen: Definitionen/Schwellwerte (Slow-Mover etc.) ─────────────

    if (parsed.pathname === '/api/v2/settings/definitions' && req.method === 'GET') {
      // slowMover = Klassenkatalog (Single Source of Truth, Glossar). config =
      // die EFFEKTIVE, editierbare Mandant-Config (#63/#66): Margen, Latten,
      // Schon-/Ladenhüter-Tage. Ohne DB greifen die Branchen-Anker-Defaults.
      const config = await loadClassificationConfig();
      const viewer = getViewer(req);
      sendJson(res, 200, {
        ok: true,
        canEdit: viewer.can('system.verwalten'), // #29/#28: Einstellungen erfordern system.verwalten
        definitions: { slowMover: SLOW_MOVER, config },
      });
      return;
    }

    // Schreibpfad (#66, Aufsatz auf #31): Margen/Latten/Schon-/Ladenhüter-Tage +
    // Kategorien editieren. Admin-only, persistiert je Mandant (classification_settings).
    if (parsed.pathname === '/api/v2/settings/definitions' && req.method === 'POST') {
      const viewer = getViewer(req);
      // #31 (US22): Schwellwerte sind System-Einstellungen → nur system.verwalten.
      // Vorher canTriggerActions (= workflows.starten), das ein Auffüller hat — Lücke.
      if (!viewer.can('system.verwalten')) {
        auditDenied(viewer, 'settings_write_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'CAPABILITY_REQUIRED', message: 'Nur system.verwalten darf die Einstellungen ändern.' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        }) || '{}');
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        // #125: durch die Mandanten-Tür (kein Inline-Client). Config unter __default__
        // (per-Mandant-Config = Stufe 6). readOverride/writeOverride nehmen die Tür.
        const current = await readOverride(tenantDb, DEFAULT_MANDANT);
        const incoming = sanitizeOverride(body && body.config ? body.config : body);
        const mergedOverride = mergeSettingsOverride(current, incoming);
        const config = await writeOverride(tenantDb, DEFAULT_MANDANT, mergedOverride);
        // #32: Schwellwert-Änderung protokollieren — nur die geänderten Schlüssel,
        // KEINE Werte (Audit-Hygiene; Schwellwerte sind zwar keine Secrets, aber wir
        // halten den Trail bewusst schlank + secret-frei).
        auditAction(viewer, 'settings_write', { changedKeys: Object.keys(incoming || {}) }, 'ok');
        sendJson(res, 200, { ok: true, definitions: { slowMover: SLOW_MOVER, config } });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Einstellungen: Schwellwerte (#31, settings_thresholds) ─────────────────

    if (parsed.pathname === '/api/v2/settings/thresholds' && req.method === 'GET') {
      const viewer = getViewer(req);
      const machineId = parsed.query.machineId;
      const mid = machineId != null && machineId !== '' ? Number(machineId) : null;
      const { Client } = require('pg');
      const client = new Client({ connectionString: dashboardV2PgUrl(), connectionTimeoutMillis: 6000 });
      await client.connect();
      try {
        const thresholds = await getThresholds(client, DEFAULT_MANDANT, mid);
        const result = {};
        for (const [key, t] of Object.entries(thresholds)) {
          result[key] = { value: t.value, source: t.source, meta: t.meta };
        }
        sendJson(res, 200, {
          ok: true,
          canEdit: viewer.can('system.verwalten'),
          machineId: mid,
          thresholds: result,
        });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      } finally {
        await client.end();
      }
      return;
    }

    if (parsed.pathname.startsWith('/api/v2/settings/thresholds/') && req.method === 'PUT') {
      const viewer = getViewer(req);
      if (!viewer.can('system.verwalten')) {
        auditDenied(viewer, 'threshold_write_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'CAPABILITY_REQUIRED', message: 'Nur system.verwalten darf Schwellwerte ändern.' } });
        return;
      }
      const key = parsed.pathname.slice('/api/v2/settings/thresholds/'.length);
      if (!key || !Object.prototype.hasOwnProperty.call(THRESHOLD_DEFS, key)) {
        sendJson(res, 400, { ok: false, error: { code: 'UNKNOWN_KEY', message: `Unbekannter Schlüssel: "${key}"` } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        }) || '{}');
      } catch {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Ungültiges JSON im Request-Body.' } });
        return;
      }
      const machineId = body && body.machineId != null && body.machineId !== '' ? Number(body.machineId) : null;
      const value = body && body.value !== undefined ? body.value : null;
      if (!tenantDb) { sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } }); return; }
      try {
        await setThreshold(tenantDb, DEFAULT_MANDANT, machineId, key, value); // #137: durch die Tür
        auditAction(viewer, 'threshold_write', { key, machineId: machineId ?? null }, 'ok');
        const thresholds = await getThresholds(tenantDb, DEFAULT_MANDANT, machineId);
        sendJson(res, 200, { ok: true, thresholds });
      } catch (err) {
        const isValidation = err.message.startsWith('Unbekannter') || err.message.includes('muss eine Zahl');
        sendJson(res, isValidation ? 400 : 503, { ok: false, error: { code: isValidation ? 'INVALID_VALUE' : 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname.startsWith('/api/v2/settings/thresholds') && req.method === 'DELETE') {
      const viewer = getViewer(req);
      if (!viewer.can('system.verwalten')) {
        auditDenied(viewer, 'threshold_reset_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'CAPABILITY_REQUIRED', message: 'Nur system.verwalten darf Schwellwerte zurücksetzen.' } });
        return;
      }
      const key = parsed.pathname.startsWith('/api/v2/settings/thresholds/')
        ? parsed.pathname.slice('/api/v2/settings/thresholds/'.length)
        : null;
      const machineId = parsed.query.machineId;
      const mid = machineId != null && machineId !== '' ? Number(machineId) : null;
      if (!tenantDb) { sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } }); return; }
      try {
        if (key) {
          await resetThreshold(tenantDb, DEFAULT_MANDANT, mid, key); // #137: durch die Tür
          auditAction(viewer, 'threshold_reset', { key, machineId: mid ?? null }, 'ok');
        } else {
          await resetAllThresholds(tenantDb, DEFAULT_MANDANT, mid); // #137: durch die Tür
          auditAction(viewer, 'threshold_reset_all', { machineId: mid ?? null }, 'ok');
        }
        const thresholds = await getThresholds(tenantDb, DEFAULT_MANDANT, mid);
        sendJson(res, 200, { ok: true, thresholds });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Diagnostics: Schema-Contract gegen die echte DB prüfen ─────────────────

    if (parsed.pathname === '/api/v2/_diagnostics/schema' && req.method === 'GET') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können die Schema-Diagnose abrufen.' } });
        return;
      }
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: pgUrl });
        await client.connect();
        try {
          const report = await runSchemaCheck(client, __dirname);
          // Gesundes Schema → 200, Drift → 503 (so lässt es sich per Status-Code überwachen).
          sendJson(res, report.healthy ? 200 : 503, {
            ok: report.healthy,
            generatedAt: new Date().toISOString(),
            report,
          });
        } finally {
          await client.end();
        }
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/_diagnostics/stock-cost' && req.method === 'GET') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können die EK-Invariant-Diagnose abrufen.' } });
        return;
      }
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: pgUrl });
        await client.connect();
        try {
          const report = await runStockCostCheck(client);
          // Gesund → 200, Invariant-Verletzung → 503 (per Status-Code überwachbar).
          sendJson(res, report.healthy ? 200 : 503, { ok: report.healthy, report });
        } finally {
          await client.end();
        }
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── GuV-Filter: Auswahlbaum Standorte + Automaten ─────────────────────────

    if (parsed.pathname === '/api/v2/economics/scope' && req.method === 'GET') {
      const viewer = getViewer(req); // #124: Mandant für den Automaten-/Standort-Scope
      if (!requireCapability(viewer, 'finanzen.lesen', res)) return; // #28: GuV nur mit finanzen.lesen
      if (!tenantReadReady(res)) return; // #124: DB/Verzeichnis-Ausfall ⇒ 503, nicht leer
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const scope = await queryEconomicsScopePg(tenantDb, viewer.tenantId);
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), data: scope });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Live-Umsatz (quasi-live): Tagesumsatz heute + letzte Verkäufe ─────────
    // Liest nur sales_transactions (von WF3 befüllt). Auto-Refresh-Quelle der
    // v3-Live-Kachel; Filter machines=ID1,ID2 und limit wie bei /economics.

    if (parsed.pathname === '/api/v2/economics/live' && req.method === 'GET') {
      const viewer = getViewer(req); // #123: Mandant für den Live-Umsatz
      if (!requireCapability(viewer, 'finanzen.lesen', res)) return; // #28: GuV nur mit finanzen.lesen
      if (!tenantReadReady(res)) return; // #123: DB/Verzeichnis-Ausfall ⇒ 503, nicht leer
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const live = await queryEconomicsLivePg(tenantDb, viewer.tenantId, parsed.query || {});
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), data: live });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Alert-Digest: Single-Source für die tägliche WF5-Report-Mail ─────────
    // Berechnet alle Mail-Sektionen aus PG-Fakten (MHD, Lagerchargen, leere
    // Slots) + klassifiziert Daten-/Workflowfehler korrekt (kein AUTO_REFILL_
    // SLOT-Fehlalarm mehr). Löst die Sheet-basierte Bestandsanzeige der Mail ab.
    if (parsed.pathname === '/api/v2/alerts/digest' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      // #124: Hintergrund-Job ohne Viewer. Verzeichnis nicht bereit ⇒ 503 (kein Default).
      if (!tenantReadReady(res)) return;
      const q = parsed.query || {};
      const lowBatchThreshold = Number(q.lowBatchThreshold);
      const opts = Number.isFinite(lowBatchThreshold) ? { lowBatchThreshold } : {};
      // EXPLIZITE Mandanten-Quelle: ?tenant=<id> ODER alle realen Mandanten aus dem
      // Verzeichnis (pro Mandant). NIE ein Default-Mandant.
      const explicit = clean(q.tenant);
      let tenants;
      if (explicit) {
        if (!tenantDirectory || !tenantDirectory.tenantExists(explicit)) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Mandant nicht gefunden.' } });
          return;
        }
        tenants = [explicit];
      } else {
        tenants = tenantDirectory ? tenantDirectory.listTenantIds() : [];
      }
      try {
        if (tenants.length <= 1) {
          // Genau ein (oder — Randfall — kein) Mandant ⇒ bestehende Antwort-Form
          // (WF5-kompatibel; kein Mandant ⇒ leerer Digest, der Job verschickt nichts).
          const tenant = tenants[0] || null;
          const data = buildAlertDigest(await queryAlertDigestPg(tenantDb, tenant, opts));
          sendJson(res, 200, { ok: true, source: 'postgres', generatedAt: new Date().toISOString(), tenant, data });
          return;
        }
        // Mehrere Mandanten ⇒ per-Mandant (Stufe 6 verdrahtet WF5 pro Mandant/Mail).
        const perTenant = {};
        for (const tid of tenants) {
          perTenant[tid] = buildAlertDigest(await queryAlertDigestPg(tenantDb, tid, opts));
        }
        sendJson(res, 200, { ok: true, source: 'postgres', generatedAt: new Date().toISOString(), perTenant });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Locations routes ──────────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/locations' && req.method === 'GET') {
      const viewer = getViewer(req); // #127: Mandant für die Standort-Liste
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        const profiles = await queryLocationsPg(tenantDb, viewer.tenantId);
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
        const saved = await upsertLocationPg(tenantDb, viewer.tenantId, profile); // #135: durch die Tür
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
        if (!tenantReadReady(res)) return;
        const data = await queryMachineProfilesPg(tenantDb, viewer.tenantId);
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
        const saved = await upsertMachineProfilePg(tenantDb, viewer.tenantId, profile); // #136: durch die Tür
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

    if (parsed.pathname === '/api/v2/machines' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können Automaten anlegen.' } });
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      await new Promise((resolve) => req.on('end', resolve));
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      try {
        const payload = buildMachineCreatePayload(JSON.parse(body || '{}'));
        const saved = await createMachinePg(tenantDb, viewer.tenantId, payload); // #136: durch die Tür (Parent-Standort transaktional geprüft)
        sendJson(res, 200, { ok: true, data: saved });
      } catch (err) {
        if (err.code === 'NOT_FOUND') { // #136: fremder/unbekannter Standort ⇒ 404, kein Existenz-Leak
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: err.message } });
          return;
        }
        const isValidation = /erforderlich|existiert nicht|Standort/i.test(err.message);
        sendJson(res, isValidation ? 400 : 503, {
          ok: false,
          error: { code: isValidation ? 'VALIDATION_ERROR' : 'PG_ERROR', message: err.message },
        });
      }
      return;
    }

    // #2: Automat aussondern / reaktivieren (soft-delete machines.active).
    if (parsed.pathname === '/api/v2/machines/active' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können Automaten aussondern.' } });
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      await new Promise((resolve) => req.on('end', resolve));
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) { sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } }); return; }
      try {
        const raw = JSON.parse(body || '{}');
        const saved = await setMachineActivePg(tenantDb, viewer.tenantId, raw.machine_key, raw.active === true || raw.active === 'true'); // #136: durch die Tür
        sendJson(res, 200, { ok: true, data: saved });
      } catch (err) {
        const code = err.code === 'NOT_FOUND' ? 404 : (/machine_key/i.test(err.message) ? 400 : 503);
        sendJson(res, code, { ok: false, error: { code: err.code || 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // #1: Standort löschen (nur wenn kein Automat mehr dran hängt).
    if (parsed.pathname === '/api/v2/locations' && req.method === 'DELETE') {
      const viewer = getViewer(req);
      if (!viewer.canTriggerActions) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Nur Admins können Standorte löschen.' } });
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      await new Promise((resolve) => req.on('end', resolve));
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) { sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } }); return; }
      try {
        const raw = JSON.parse(body || '{}');
        const result = await deleteLocationPg(tenantDb, viewer.tenantId, raw.location_key); // #135: durch die Tür
        sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        const code = err.code === 'LOCATION_NOT_EMPTY' ? 409
          : err.code === 'NOT_FOUND' ? 404
          : (/erforderlich/i.test(err.message) ? 400 : 503);
        sendJson(res, code, { ok: false, error: { code: err.code || 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // #3: Verfügbare Nayax-Geräte fürs Anlege-Combobox (liest den DB-Spiegel,
    // markiert bereits angelegte). Leere Liste -> Frontend fällt auf Freitext.
    if (parsed.pathname === '/api/v2/nayax-devices' && req.method === 'GET') {
      const viewer = getViewer(req); // #127: Mandant für die nutzersichtbare Geräte-Liste
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) { sendJson(res, 200, { ok: true, data: [] }); return; }
      try {
        const rows = await queryNayaxDevicesPg(tenantDb, viewer.tenantId);
        sendJson(res, 200, { ok: true, data: shapeNayaxDevices(rows) });
      } catch (err) {
        sendJson(res, 200, { ok: true, data: [], error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Correction cases route ────────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/correction-cases' && req.method === 'GET') {
      const viewer = getViewer(req);
      const isAdmin = viewer.role === 'admin';
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 200, { ok: true, is_admin: isAdmin, generatedAt: new Date().toISOString(), cases: [], counts: { mdb_proposals: 0, unknown_products: 0, correction_warnings: 0, total: 0 } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        const raw = await queryCorrectionCasesPg(tenantDb, viewer.tenantId);
        const { cases, counts } = buildCorrectionCases(raw);
        sendJson(res, 200, { ok: true, is_admin: isAdmin, generatedAt: new Date().toISOString(), cases, counts });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // ── Correction action: suggest ────────────────────────────────────────────
    // WF4 ID on Mini: 6tOZnWsxBNzHaVqA

    if (parsed.pathname === '/api/v2/correction-action/suggest' && req.method === 'GET') {
      const caseId = parsed.query?.case_id;
      if (!caseId) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_CASE_ID', message: 'case_id erforderlich.' } });
        return;
      }
      const viewer = getViewer(req); // #128: Mandant für die Korrektur-Vorschau (suggest)
      const pgUrl = dashboardV2PgUrl();
      let correctionCase = null;
      let allProducts = [];
      if (pgUrl) {
        try {
          // #128: durch die Mandanten-Tür (tenant_id-Filter), kein Inline-Client.
          const [rawCases, prodRes] = await Promise.all([
            queryCorrectionCasesPg(tenantDb, viewer.tenantId).catch(() => ({ proposals: [], unknownTxGroups: [], correctionWarnings: [] })),
            tenantDb.read({ tenant: viewer.tenantId, tables: ['products'], text: 'SELECT product_id, name FROM automatenlager.products WHERE tenant_id = $1 ORDER BY name', params: [] }),
          ]);
          const { cases } = buildCorrectionCases(rawCases);
          correctionCase = cases.find((c) => c.case_id === caseId) ?? null;
          allProducts = prodRes.rows.map((r) => ({ ...r, name: formatProductName(r.name) ?? r.name }));
        } catch { /* fall through to empty response */ }
      }
      const { suggestion, products } = buildProductSuggestion(correctionCase ?? { case_id: caseId, suggested_product_id: null, suggested_product_name: null }, allProducts);
      sendJson(res, 200, { ok: true, case_id: caseId, suggestion, products });
      return;
    }

    // ── Correction action: confirm ────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/correction-action/confirm' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('bestand.schreiben')) {
        auditDenied(viewer, 'correction_action_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Nur Admins können Korrekturen bestätigen.' } });
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
      // #134 (Stufe 4): Mandant kommt NUR aus dem Viewer — tenant_id/mandant_id im Body ⇒ 400 + Audit.
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const { case_id, case_type, machine_id, mdb_code, old_product_id, slot_assignment_id, confirmed_product_id } = body || {};
      const validation = validateCorrectionAction({ confirmed_product_id });
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: validation.errors.map((e) => e.message).join(' '), errors: validation.errors } });
        return;
      }
      // #134 (Stufe 4, IDOR — Case-Parent): case_id muss in der tenant-gefilterten
      // Case-Liste des Viewers liegen; fremd/unbekannt ⇒ 404 + Audit, BEVOR n8n läuft.
      if (!(await requireCaseAccess(viewer, case_id, res, 'idor:correction-action'))) return;
      const correctionCase = { case_id, case_type, machine_id, mdb_code, product_id: old_product_id, slot_assignment_id };
      const payload = buildCorrectionActionPayload(correctionCase, { confirmed_product_id });
      const webhookUrl = process.env.CORRECTION_ACTION_WEBHOOK_URL;
      let wfResult = { ok: true, status_ref: `ca-${Date.now()}`, message: 'Payload protokolliert.' };
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
            status_ref: `ca-${Date.now()}`,
            message: wfResponse.ok ? 'Webhook erfolgreich.' : `Webhook antwortete ${wfResponse.status}: ${wfText.slice(0, 200)}`,
          };
        } catch (err) {
          wfResult = { ok: false, status_ref: null, message: `Webhook nicht erreichbar: ${err.message}` };
        }
      }
      const auditEntry = buildCorrectionActionAuditEntry(viewer, payload, wfResult);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'correction_action', auditEntry);
      sendJson(res, wfResult.ok ? 200 : 502, {
        ok: wfResult.ok,
        action_key: payload.action_key,
        status_ref: auditEntry.status_ref,
        message: wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'WEBHOOK_ERROR', message: wfResult.message } }),
      });
      return;
    }

    // ── Nayax-Abgleich routes (Vollabgleich Slotbelegung + Füllstand) ─────────

    // Vorschau (read-only, auch für Gäste): vollständiger Diff aus Slotbelegung
    // (Umbuchung alt->neu) + Menge (alt->neu) + Onboarding-Liste + PG-only-Slots.
    if (parsed.pathname === '/api/v2/nayax-abgleich/preview' && req.method === 'GET') {
      const viewer = getViewer(req); // #127: Mandant für den Nayax-Abgleich-Preview
      const machineKey = clean(parsed.query.machine || parsed.query.machine_id || '');
      if (!machineKey) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_PARAMS', message: 'machine (Nayax-Nummer) erforderlich.' } });
        return;
      }
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      if (!nayaxApiSettings().token) {
        sendJson(res, 503, { ok: false, error: { code: 'NAYAX_UNCONFIGURED', message: 'NAYAX_API_TOKEN nicht gesetzt.' } });
        return;
      }
      if (!tenantReadReady(res)) return;
      try {
        const { diff } = await computeNayaxAbgleichDiff(tenantDb, viewer.tenantId, machineKey);
        sendJson(res, 200, { ok: true, ...diff });
      } catch (err) {
        const code = err.code === 'NAYAX_API_ERROR' ? 502 : 503;
        sendJson(res, code, { ok: false, error: { code: err.code || 'PG_ERROR', message: err.message } });
      }
      return;
    }

    // Übernahme (admin-only, 403 für Gast): rechnet den Plan serverseitig aus
    // FRISCHEN Daten neu (kein Vertrauen auf Client-Operationen), prüft optional
    // den vom Nutzer gesehenen Guard (Drift-Schutz) und triggert den apply-WF.
    // Onboarding-/unmatchbare/PG-only-Slots werden NIE geschrieben (übersprungen).
    if (parsed.pathname === '/api/v2/nayax-abgleich/apply' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('nayax.schreiben')) {
        auditDenied(viewer, 'nayax_abgleich_denied', {});
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Nur Admins dürfen den Abgleich übernehmen.' } });
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
      const machineKey = clean((body && (body.machine || body.machine_id)) || '');
      if (!machineKey) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: 'machine (Nayax-Nummer) erforderlich.' } });
        return;
      }
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      // #33/#117 (IDOR): Automat muss real zum Mandanten des Viewers gehören. Nach
      // der Pflichtfeld-/PG-Prüfung; machineKey ist hier garantiert vorhanden.
      if (!(await requireMachineAccess(viewer, machineKey, res, 'idor:nayax-apply'))) return;
      if (!nayaxApiSettings().token) {
        sendJson(res, 503, { ok: false, error: { code: 'NAYAX_UNCONFIGURED', message: 'NAYAX_API_TOKEN nicht gesetzt.' } });
        return;
      }
      let plan; let diff; let events;
      try {
        const result = await computeNayaxAbgleichDiff(tenantDb, viewer.tenantId, machineKey);
        diff = result.diff;
        plan = buildApplyPlan(diff);
        const nowIso = new Date().toISOString();
        events = buildSlotAssignmentEvents(plan, {
          machineKey,
          nowIso,
          batchRunId: `abgl_${nowIso.slice(0, 10)}`,
          productKeyById: result.productKeyById,
        });
      } catch (err) {
        const code = err.code === 'NAYAX_API_ERROR' ? 502 : 503;
        sendJson(res, code, { ok: false, error: { code: err.code || 'PG_ERROR', message: err.message } });
        return;
      }
      const validation = validateAbgleichApply({ machine_id: machineKey, operations: plan.operations });
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: validation.errors.map((e) => e.message).join(' '), errors: validation.errors } });
        return;
      }
      // Drift-Schutz: bricht ab, wenn sich seit der gesehenen Vorschau die
      // Anzahl/Summe der Änderungen verschoben hat (Übernahme = was du gesehen hast).
      const expected = body.expected_guard;
      if (expected
          && (Number(expected.expected_changes) !== plan.guard.expected_changes
            || Number(expected.expected_qty_sum) !== plan.guard.expected_qty_sum)) {
        sendJson(res, 409, { ok: false, error: { code: 'PREVIEW_VERALTET', message: 'Die Daten haben sich seit der Vorschau geändert. Bitte Vorschau neu laden.' }, guard: plan.guard });
        return;
      }
      const payload = buildAbgleichApplyPayload(plan, { triggered_by: viewer.login });
      payload.events = events;
      // n8n-Ablösung (2026-06-11): die pgw_write-fertigen slot_assignment-Events
      // (close alt + open neu) werden DIREKT durch die Tür angewandt (db.tx, RLS) —
      // der frühere Umweg über den Mini-WF + WF-PGW ist abgelöst. Semantik identisch
      // (gleiche ON-CONFLICT-Upsert-Logik in lib/jobs/wf4-slot-write.js).
      let wfResult;
      try {
        const r = await applySlotAssignmentEvents(tenantDb, viewer.tenantId, { events });
        wfResult = {
          ok: true,
          status_ref: `abgl-${Date.now()}`,
          message: `Abgleich übernommen (${r.upserts} Slot-Events angewandt).`,
          wf: { upserts: r.upserts, skipped: r.skipped },
        };
      } catch (err) {
        wfResult = { ok: false, status_ref: null, message: `Abgleich fehlgeschlagen: ${err.message}` };
      }
      const auditEntry = buildAbgleichAuditEntry(viewer, payload, wfResult);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'nayax_abgleich_action', auditEntry);
      sendJson(res, wfResult.ok ? 200 : 502, {
        ok: wfResult.ok,
        status_ref: auditEntry.status_ref,
        machine_id: machineKey,
        applied: plan.operations.length,
        skipped: { onboarding: diff.onboarding.length, pg_only: diff.pg_only_slots.length },
        guard: plan.guard,
        message: wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'WEBHOOK_ERROR', message: wfResult.message } }),
      });
      return;
    }

    // ── Onboarding Start routes ───────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/onboarding/start' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('bestand.schreiben')) {
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Nur Admins können das Onboarding starten.' } });
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
      // #134 (Stufe 4): Mandant kommt NUR aus dem Viewer — tenant_id/mandant_id im Body ⇒ 400 + Audit.
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const { product_key, case_id, affected_tx_count } = body || {};
      const validation = validateOnboardingStart({ product_key });
      if (!validation.valid) {
        sendJson(res, 400, { ok: false, error: { code: 'VALIDATION_ERROR', message: validation.errors.map((e) => e.message).join(' '), errors: validation.errors } });
        return;
      }
      // #134 (Stufe 4, IDOR): Mit case_id (= unknown_<product_key>) ⇒ Mitgliedschaftsprüfung
      // in der tenant-gefilterten Case-Liste (fremd ⇒ 404). Ohne case_id gibt es KEIN
      // adressierbares fremdes Objekt (product_key ist ein noch unbekanntes Nayax-Label,
      // nicht in products) ⇒ Minimum: ein gesetzter Viewer-Mandant; der Mandant wird
      // ausschließlich aus dem Viewer bestimmt.
      if (case_id) {
        if (!(await requireCaseAccess(viewer, case_id, res, 'idor:onboarding'))) return;
      } else if (!viewer.tenantId) {
        auditDenied(viewer, 'idor:onboarding', { reason: 'no_tenant_context' });
        sendJson(res, 403, { ok: false, error: { code: 'NO_TENANT_CONTEXT', message: 'Kein Mandanten-Kontext für das Onboarding.' } });
        return;
      }
      const unknownCase = { case_id: case_id || `unknown_${product_key}`, product_key };
      const payload = buildOnboardingStartPayload(unknownCase);
      let wfResult = { ok: true, message: 'Onboarding protokolliert.' };
      const webhookUrl = process.env.ONBOARDING_WEBHOOK_URL;
      if (webhookUrl) {
        try {
          const wfResponse = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, triggered_by: viewer.login, affected_tx_count }),
          });
          const wfText = await wfResponse.text();
          wfResult = {
            ok: wfResponse.ok,
            message: wfResponse.ok ? 'Webhook erfolgreich.' : `Webhook antwortete ${wfResponse.status}: ${wfText.slice(0, 200)}`,
          };
        } catch (err) {
          wfResult = { ok: false, message: `Webhook nicht erreichbar: ${err.message}` };
        }
      }
      const auditEntry = buildOnboardingStartAuditEntry(viewer, payload, wfResult);
      // #217 (flüchtiges Render-FS): DB-Senke (#213) ist MASSGEBLICH (started-keys
      // liest sie primär); die JSONL bleibt best-effort als Dev-Fallback ohne PG
      // (Test-Isolation via DASHBOARD_ONBOARDING_AUDIT_LOG) — auf Render flüchtig
      // und unkritisch, weil der Lesepfad die DB zuerst fragt.
      auditAction(viewer, 'onboarding_start_action', auditEntry);
      try {
        const auditPath = onboardingAuditPath();
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, `${JSON.stringify(auditEntry)}\n`, 'utf8');
      } catch { /* audit write failure must not block response */ }
      sendJson(res, wfResult.ok ? 200 : 502, {
        ok: wfResult.ok,
        action_key: payload.action_key,
        product_key: payload.product_key,
        message: wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'WEBHOOK_ERROR', message: wfResult.message } }),
      });
      return;
    }

    if (parsed.pathname === '/api/v2/onboarding/started-keys' && req.method === 'GET') {
      const started_keys = [];
      // #217: DB-Senke primär (audit.access_log überlebt das flüchtige Render-FS;
      // der Schreibpfad läuft seit dieser Slice über auditAction). Historische
      // JSONL-Einträge (Mini-Ära) werden zusätzlich gemergt — gleicher Vertrag.
      try {
        if (infraPgQuery) {
          const r = await infraPgQuery(
            `SELECT DISTINCT details->>'product_key' AS pk FROM audit.access_log
              WHERE event = 'onboarding_start_action'
                AND details->>'ok' = 'true' AND details->>'product_key' IS NOT NULL`, []);
          for (const row of r.rows) if (row.pk && !started_keys.includes(row.pk)) started_keys.push(row.pk);
        }
      } catch { /* DB optional (Dev ohne PG) */ }
      try {
        const lines = fs.readFileSync(onboardingAuditPath(), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.ok && entry.product_key && !started_keys.includes(entry.product_key)) {
              started_keys.push(entry.product_key);
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* file not yet created */ }
      sendJson(res, 200, { ok: true, started_keys });
      return;
    }

    // ── Slot-Assign Inline routes ─────────────────────────────────────────────

    if (parsed.pathname === '/api/v2/slot-assign-inline/preview' && req.method === 'GET') {
      const pgUrl = dashboardV2PgUrl();
      if (!pgUrl) {
        sendJson(res, 503, { ok: false, data: null, error: { code: 'PG_UNCONFIGURED', message: 'PostgreSQL nicht konfiguriert.' } });
        return;
      }
      const productId = clean(parsed.query.product_id || '');
      if (!productId) {
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_PARAMS', message: 'product_id erforderlich.' } });
        return;
      }
      const viewer = getViewer(req); // #128: Mandant für die Slot-Zuweisungs-Vorschau
      if (!tenantReadReady(res)) return;
      try {
        // #128: durch die Mandanten-Tür mit tenant_id-Filter (kein Inline-Client).
        const [pRes, mRes] = await Promise.all([
          tenantDb.read({
            tenant: viewer.tenantId, tables: ['products'],
            text: `SELECT p.product_id, p.product_key, p.name FROM automatenlager.products p WHERE p.tenant_id = $1 AND p.product_id = $2 LIMIT 1`,
            params: [Number(productId)],
          }),
          tenantDb.read({
            tenant: viewer.tenantId, tables: ['machine_profiles'],
            text: `SELECT machine_id, area, type, position, nickname FROM automatenlager.machine_profiles WHERE tenant_id = $1 ORDER BY area NULLS LAST, machine_id`,
            params: [],
          }),
        ]);
        const productRow  = pRes.rows[0] || null;
        const machineRows = mRes.rows;
        if (!productRow) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `Produkt ${productId} nicht gefunden.` } });
          return;
        }
        const { buildMachineLabel } = require('./lib/machine-profiles.js');
        const machines = machineRows.map((m) => ({ ...m, label: buildMachineLabel(m) }));
        const preview = buildSlotAssignPreview(productRow, machines);
        sendJson(res, 200, { ok: true, ...preview });
      } catch (err) {
        sendJson(res, 503, { ok: false, error: { code: 'PG_ERROR', message: err.message } });
      }
      return;
    }

    if (parsed.pathname === '/api/v2/slot-assign-inline/confirm' && req.method === 'POST') {
      const viewer = getViewer(req);
      if (!viewer.can('bestand.schreiben')) {
        sendJson(res, 403, { ok: false, error: { code: 'READ_ONLY_FORBIDDEN', message: 'Nur Admin kann Slots zuweisen.' } });
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch { body = {}; }
      // #133 (Stufe 4): Mandant kommt NUR aus dem Viewer — tenant_id/mandant_id im Body ⇒ 400 + Audit.
      if (rejectBodyTenant(body, { res, viewer, sendJson, audit: auditDenied })) return;
      const { product_id, product_key, machine_id, mdb_code, qty, start_date } = body || {};

      const productRow = { product_id: product_id ?? null, product_key: product_key ?? null, name: '' };
      const validation = validateSlotAssign({ machine_id, mdb_code, qty, start_date });
      if (!validation.valid || !product_id) {
        const missingFields = !product_id
          ? [{ field: 'product_id', message: 'Produkt-ID erforderlich.' }, ...validation.errors]
          : validation.errors;
        sendJson(res, 400, { ok: false, error: { code: 'MISSING_FIELDS', message: missingFields.map((e) => e.message).join(' '), fields: missingFields } });
        return;
      }
      // #133 (Stufe 4, IDOR): Automat muss real zum Mandanten des Viewers gehören.
      // Nach der Validierung; fremd/unbekannt ⇒ 404 + Audit, BEVOR der n8n-Webhook läuft.
      if (!(await requireMachineAccess(viewer, machine_id, res, 'idor:slot-assign-inline'))) return;

      const payload  = buildSlotAssignPayload(productRow, { machine_id, mdb_code, qty, start_date });
      const webhookUrl = process.env.SLOT_ASSIGN_INLINE_WEBHOOK_URL || '';
      let wfResult;
      if (webhookUrl) {
        try {
          const wfRes = await fetch(webhookUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
          });
          const wfBody = await wfRes.json().catch(() => ({}));
          wfResult = { ok: wfRes.ok, status_ref: wfBody.status_ref ?? null, message: wfBody.message ?? (wfRes.ok ? 'ok' : `HTTP ${wfRes.status}`) };
        } catch (err) {
          wfResult = { ok: false, status_ref: null, message: `Webhook nicht erreichbar: ${err.message}` };
        }
      } else {
        wfResult = { ok: true, status_ref: `sa-local-${Date.now()}`, message: 'Slot-Zuweisung gespeichert (kein Webhook konfiguriert).' };
      }

      const auditEntry = buildSlotAssignAuditEntry(viewer, payload, wfResult);
      // #217 (flüchtiges Render-FS): Aktions-Audit in die DB-Senke (#213) statt JSONL.
      auditAction(viewer, 'slot_assign_action', auditEntry);

      sendJson(res, wfResult.ok ? 200 : 502, {
        ok:         wfResult.ok,
        assign_key: payload.assign_key,
        status_ref: auditEntry.status_ref,
        message:    wfResult.message,
        ...(wfResult.ok ? {} : { error: { code: 'WEBHOOK_ERROR', message: wfResult.message } }),
      });
      return;
    }

    if (parsed.pathname === '/api/guv') {
      sendJson(res, 200, await buildGuv(parsed.query));
      return;
    }

    // Root → v3 (Standard seit 2026-06-02). v3 ist die produktive Oberfläche;
    // das Legacy-v1 bleibt unter /v1 erreichbar.
    if (parsed.pathname === '/') {
      res.writeHead(302, { Location: '/v3' });
      res.end();
      return;
    }

    // v2 abgeschaltet (Issue #9, 2026-06-03): v3 deckt alle v2-Funktionen ab.
    // Alte /v2-Links/Bookmarks dauerhaft auf v3 umleiten.
    if (parsed.pathname === '/v2' || parsed.pathname === '/v2/' || parsed.pathname.indexOf('/v2/') === 0) {
      res.writeHead(302, { Location: '/v3' });
      res.end();
      return;
    }

    // Dashboard v3: Einstiegspfad + Deep-Links auf die v3-Einstiegsdatei mappen
    // (SPA-Fallback, analog zur v2-Sonderroute). Statische v3-Assets mit
    // Datei-Endung (z. B. /v3.js, /v3.css) werden normal ausgeliefert.
    const isV3DeepLink = parsed.pathname === '/v3'
      || (parsed.pathname.indexOf('/v3/') === 0 && !path.extname(parsed.pathname));

    const requestPath = parsed.pathname === '/v1'
      ? '/index.html'
      : parsed.pathname === '/login' // #215: Login-Wand (Auth-Naht, supabase-Mode)
        ? '/login.html'
        : parsed.pathname === '/status' // #219: schlanke Statusseite (Cutover-Abschluss)
          ? '/status.html'
          : isV3DeepLink
            ? '/v3.html'
            : parsed.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
    sendFile(res, filePath);
  } catch (error) {
    // Sicherheit (Audit H1, 2026-06-12): NIEMALS Stack-Trace/interne Details an
    // den Client — das ist eine Architektur-Landkarte für Angreifer. Nach außen
    // nur eine generische Meldung + requestId (für Support-Korrelation). Die
    // echten Details gehen ins Server-Log + an Sentry.
    console.error(`[500] ${req.method} ${parsed && parsed.pathname} (req ${req._requestId}):`, (error && error.stack) || error);
    try { require('./lib/sentry-lite.js').getSentry().captureException(error, { endpoint: parsed && parsed.pathname, method: req.method, requestId: req._requestId }); } catch { /* nie werfen */ }
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Interner Fehler. Bitte später erneut versuchen.', requestId: req._requestId } });
    }
  }
});

// #217: Prozessweite Fehler (uncaughtException/unhandledRejection) an Sentry —
// No-op ohne SENTRY_DSN; bestehendes Log-/Crash-Verhalten bleibt unangetastet.
try { require('./lib/sentry-lite.js').getSentry().installProcessHandlers(); } catch { /* nie werfen */ }

server.listen(PORT, async () => {
  // #127: Mandanten-Registry VOR dem Ready-Signal laden. Der Server lauscht bereits;
  // nur das „running"-Log (Bereitschafts-Signal für Aufrufer/Tests) verschiebt sich,
  // bis die Registry ready/failed ist. Sonst läuft ein sofort feuernder Aufrufer in
  // das Startup-Race „Verzeichnis noch nicht bereit ⇒ 503" der tenant-getrennten
  // Lesepfade. initTenantDirectory ist fail-closed und wirft nicht (fängt intern);
  // ohne konfiguriertes PG kehrt es sofort zurück.
  await initTenantDirectory(); // #117: Mandanten-Registry laden (fail-closed)
  console.log(`Automatenlager dashboard running at http://localhost:${PORT}`);
  logStartupSchemaCheck();
  logStartupStockCostCheck();
});
