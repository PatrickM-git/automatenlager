'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// audit.access_log-Schreiber/-Leser (Audit-/Guest-Access-Trail) — Issue #213.
// SPEC: docs/specs/cloud-migration-3-schichten-phase-b-v1.md
//       §"Flüchtiges Cloud-Dateisystem (Render)"
//
// Auf flüchtigen Cloud-Containern überlebt die JSONL-Datei keinen Neustart.
// MASSGEBLICHE Senke ist daher die DB-Tabelle audit.access_log (Migration 0035);
// die JSONL-Datei bleibt best-effort-Fallback für lokale Dev. Der Anomalie-
// Monitor (#168) liest die Audit-Quelle über readAuditEventsDb aus der DB.
//
// audit.access_log ist PIPELINE-/Infra-Telemetrie OHNE tenant_id (geteilt, analog
// audit.workflow_runs/lib/workflow-runs.js): sie läuft über die INFRA-Verbindung
// (injizierter `exec`), NICHT durch die Mandanten-Tür — es gibt keinen Mandanten-
// Scope zu setzen. Kein rohes pg (injizierter `exec`) ⇒ #107-Wächter-sauber.
//
// Audit ist NEBENSACHE der eigentlichen Aktion: KEINE der Senken darf je den
// Request brechen — createAuditLogWriter().write() wirft NIE (beide Senken
// intern gekapselt, Fehler nur geloggt).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_ACCESS_LOG_TABLE = 'audit.access_log';

// JSONL-Eintragsfeld → DB-Spalte. Alles, was hier NICHT steht, wandert ins
// JSONB `details` (capability, machineKey, Break-Glass-Felder, …).
const ENTRY_COLUMNS = Object.freeze({
  event: 'event',
  outcome: 'outcome',
  login: 'login',
  role: 'role',
  roleKey: 'role_key',
  tenantId: 'viewer_tenant', // Mandant des VIEWERS — informativ, bewusst KEIN tenant_id (kein RLS-Scope)
  endpoint: 'endpoint',
  method: 'method',
  sourceAddress: 'source_address',
  requestId: 'request_id',
  targetTenant: 'target_tenant',
});

/** Eintrag (JSONL-Form) in DB-Spalten + Rest-`details` zerlegen (rein, testbar). */
function splitAuditEntry(entry = {}) {
  const columns = { ts: entry.timestamp != null ? entry.timestamp : null };
  const details = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'timestamp') continue;
    if (Object.prototype.hasOwnProperty.call(ENTRY_COLUMNS, key)) {
      columns[ENTRY_COLUMNS[key]] = value == null ? null : String(value);
    } else {
      details[key] = value;
    }
  }
  for (const col of Object.values(ENTRY_COLUMNS)) {
    if (!(col in columns)) columns[col] = null;
  }
  columns.details = Object.keys(details).length ? details : null;
  return columns;
}

/**
 * Einen Audit-Eintrag in audit.access_log schreiben (INSERT, append-only).
 * WIRFT bei DB-Fehlern — der nie-werfende Mantel ist createAuditLogWriter.
 * @param {(sql:string,params:any[])=>Promise<{rows:any[]}>} exec INFRA-Executor.
 */
async function writeAuditEntryDb(exec, entry) {
  if (typeof exec !== 'function') throw new TypeError('audit-log: exec (INFRA-Executor) erforderlich');
  const c = splitAuditEntry(entry);
  return exec(
    `INSERT INTO audit.access_log
       (ts, event, outcome, login, role, role_key, viewer_tenant, endpoint, method,
        source_address, request_id, target_tenant, details)
     VALUES (COALESCE($1::timestamptz, now()), COALESCE($2, 'unbekannt'), COALESCE($3, 'ok'),
             $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [c.ts, c.event, c.outcome, c.login, c.role, c.role_key, c.viewer_tenant, c.endpoint,
      c.method, c.source_address, c.request_id, c.target_tenant,
      c.details == null ? null : JSON.stringify(c.details)],
  );
}

/** DB-Zeile zurück in die JSONL-Eventform (evaluateAnomalies-/isBreakGlass-Vertrag). */
function rowToAuditEvent(row = {}) {
  let details = row.details;
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = null; } }
  const spread = (details && typeof details === 'object') ? details : {};
  return {
    ...spread, // explizite Spalten danach ⇒ gewinnen über details
    timestamp: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    event: row.event,
    outcome: row.outcome,
    login: row.login,
    role: row.role,
    roleKey: row.role_key,
    tenantId: row.viewer_tenant,
    endpoint: row.endpoint,
    method: row.method,
    sourceAddress: row.source_address,
    requestId: row.request_id,
    targetTenant: row.target_tenant,
  };
}

/**
 * Audit-Events der letzten `windowMin` Minuten aus der DB lesen (neueste zuerst,
 * max. `limit`). WIRFT bei DB-Fehlern — der Anomalie-Monitor fällt dann auf den
 * JSONL-Tail zurück.
 */
async function readAuditEventsDb(exec, { windowMin = 60, limit = 2000 } = {}) {
  if (typeof exec !== 'function') throw new TypeError('audit-log: exec (INFRA-Executor) erforderlich');
  const res = await exec(
    `SELECT ts, event, outcome, login, role, role_key, viewer_tenant, endpoint, method,
            source_address, request_id, target_tenant, details
       FROM audit.access_log
      WHERE ts > NOW() - ($1 || ' minutes')::interval
      ORDER BY ts DESC
      LIMIT $2`,
    [String(windowMin), Number(limit) || 2000],
  );
  return ((res && res.rows) || []).map(rowToAuditEvent);
}

/**
 * Ist die DB-Senke aktiv? Default: AN (DB ist maßgeblich). Ausnahmen:
 *   - DASHBOARD_AUDIT_DB=off|0|false ⇒ aus (explizit), =on|1|true ⇒ an (explizit).
 *   - Unter dem node:test-Runner (NODE_TEST_CONTEXT, wird an gespawnte Dashboard-
 *     Kindprozesse VERERBT) ⇒ aus: Test-Läufe dürfen die echte Prod-Telemetrie
 *     nicht fluten — deren denied-Events würden auf dem Mini falsche
 *     AUTH_FAIL_SPIKE-Alarme (#168) provozieren.
 */
function dbAuditEnabled(env = process.env) {
  const v = String((env && env.DASHBOARD_AUDIT_DB) || '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  if (v === 'on' || v === '1' || v === 'true') return true;
  return !(env && env.NODE_TEST_CONTEXT);
}

/**
 * Nie-werfender Audit-Schreiber: DB-Senke (maßgeblich) + JSONL-Datei (best-effort
 * Dev-Fallback). Jede Senke ist einzeln gekapselt — write() resolved IMMER.
 * @param {object} deps
 * @param {(sql:string,params:any[])=>Promise<{rows:any[]}>|null} [deps.exec]
 *        INFRA-Executor; null/fehlend ⇒ DB-Senke aus (graceful, z. B. ohne PG).
 * @param {string|(()=>string)|null} [deps.filePath]  JSONL-Pfad (oder Resolver je
 *        Aufruf, z. B. () => process.env.DASHBOARD_AUDIT_LOG || …); null ⇒ keine Datei.
 * @param {(...a:any[])=>void} [deps.logger]
 * @returns {{ write:(entry:object)=>Promise<{db:boolean,file:boolean}> }}
 */
function createAuditLogWriter({ exec = null, filePath = null, logger } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  async function write(entry) {
    const result = { db: false, file: false };
    if (typeof exec === 'function') {
      try {
        await writeAuditEntryDb(exec, entry);
        result.db = true;
      } catch (err) {
        log('audit-log: DB-Schreiben fehlgeschlagen (best-effort, Datei-Fallback bleibt):', err && err.message);
      }
    }
    let fp = null;
    try { fp = typeof filePath === 'function' ? filePath() : filePath; } catch { fp = null; }
    if (fp) {
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        // Restriktive Dateirechte (0600) — wie die bisherige Senke in server.js (#32).
        fs.appendFileSync(fp, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
        result.file = true;
      } catch (err) {
        log('audit-log: Datei-Schreiben fehlgeschlagen (best-effort):', err && err.message);
      }
    }
    return result;
  }
  return { write };
}

module.exports = {
  AUDIT_ACCESS_LOG_TABLE,
  splitAuditEntry,
  writeAuditEntryDb,
  rowToAuditEvent,
  readAuditEventsDb,
  dbAuditEnabled,
  createAuditLogWriter,
};
