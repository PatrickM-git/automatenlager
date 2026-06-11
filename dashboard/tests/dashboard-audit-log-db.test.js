'use strict';

/**
 * Audit-/Guest-Access-Log in die DB (#213, Cloud-Migration Phase B, flüchtiges FS).
 * SPEC: docs/specs/cloud-migration-3-schichten-phase-b-v1.md §"Flüchtiges Cloud-Dateisystem"
 *
 * Auf flüchtigen Cloud-Containern (Render) überlebt die JSONL-Datei keinen
 * Neustart. MASSGEBLICHE Senke ist daher die DB-Tabelle audit.access_log
 * (Migration 0035, Pipeline-Telemetrie OHNE tenant_id — analog audit.workflow_runs);
 * die JSONL-Datei bleibt best-effort-Fallback für lokale Dev.
 *
 * Unit: splitAuditEntry/rowToAuditEvent/dbAuditEnabled/createAuditLogWriter (nie werfend).
 * LIVE (#94-Sandbox, ROLLBACK): 0035 idempotent + Spaltenvertrag; Kern-AC
 * „Eintrag überlebt simulierten Neustart" (frische Modul-/Leser-Instanz ohne
 * In-Memory-State findet den Eintrag in der DB wieder). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auditLog = require('../lib/audit-log.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

// ── Unit: dbAuditEnabled ─────────────────────────────────────────────────────
test('#213 dbAuditEnabled: Default an; unter node:test (NODE_TEST_CONTEXT) aus; explizit überschreibbar', () => {
  assert.equal(auditLog.dbAuditEnabled({}), true, 'Default (Produktion): an');
  assert.equal(auditLog.dbAuditEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false,
    'unter dem node:test-Runner aus (gespawnte Dashboard-Kinder erben NODE_TEST_CONTEXT — Tests dürfen die echte Telemetrie nicht fluten)');
  assert.equal(auditLog.dbAuditEnabled({ NODE_TEST_CONTEXT: 'child-v8', DASHBOARD_AUDIT_DB: 'on' }), true, 'explizit an gewinnt');
  assert.equal(auditLog.dbAuditEnabled({ DASHBOARD_AUDIT_DB: 'off' }), false, 'explizit aus gewinnt');
  assert.equal(auditLog.dbAuditEnabled({ DASHBOARD_AUDIT_DB: '0' }), false);
  assert.equal(auditLog.dbAuditEnabled({ DASHBOARD_AUDIT_DB: '1' }), true);
});

// ── Unit: splitAuditEntry ────────────────────────────────────────────────────
test('#213 splitAuditEntry: bekannte Felder → Spalten, Rest → details (leer ⇒ null)', () => {
  const c = auditLog.splitAuditEntry({
    timestamp: '2026-06-11T10:00:00.000Z',
    event: 'capability_denied',
    outcome: 'denied',
    login: 'gast@example.test',
    role: 'guest',
    roleKey: 'guest',
    tenantId: 't_faltrix',
    endpoint: '/api/v2/overview',
    method: 'GET',
    sourceAddress: '127.0.0.1',
    requestId: 'req-1',
    targetTenant: 't_acme',
    capability: 'workflows.starten', // unbekannt ⇒ details
    machineKey: '457107528',         // unbekannt ⇒ details
  });
  assert.equal(c.ts, '2026-06-11T10:00:00.000Z');
  assert.equal(c.event, 'capability_denied');
  assert.equal(c.outcome, 'denied');
  assert.equal(c.login, 'gast@example.test');
  assert.equal(c.role_key, 'guest');
  assert.equal(c.viewer_tenant, 't_faltrix', 'Viewer-Mandant heißt bewusst NICHT tenant_id (keine RLS-Scope-Spalte)');
  assert.equal(c.source_address, '127.0.0.1');
  assert.equal(c.request_id, 'req-1');
  assert.equal(c.target_tenant, 't_acme');
  assert.deepEqual(c.details, { capability: 'workflows.starten', machineKey: '457107528' });

  const minimal = auditLog.splitAuditEntry({ event: 'dashboard_view', outcome: 'guest_view' });
  assert.equal(minimal.details, null, 'keine Zusatzfelder ⇒ details null');
  assert.equal(minimal.login, null, 'fehlende Spaltenfelder ⇒ null');
});

// ── Unit: rowToAuditEvent ────────────────────────────────────────────────────
test('#213 rowToAuditEvent: DB-Zeile → JSONL-Eventform (Spalten gewinnen über details)', () => {
  const ev = auditLog.rowToAuditEvent({
    ts: new Date('2026-06-11T10:00:00.000Z'),
    event: 'capability_denied',
    outcome: 'denied',
    login: 'gast@example.test',
    role: 'guest',
    role_key: 'guest',
    viewer_tenant: 't_faltrix',
    endpoint: '/api/v2/overview',
    method: 'GET',
    source_address: '127.0.0.1',
    request_id: 'req-1',
    target_tenant: 't_acme',
    details: { capability: 'workflows.starten', login: 'BOESE-UEBERSCHREIBUNG' },
  });
  assert.equal(ev.timestamp, '2026-06-11T10:00:00.000Z', 'ts ⇒ ISO-timestamp (evaluateAnomalies-Form)');
  assert.equal(ev.outcome, 'denied');
  assert.equal(ev.targetTenant, 't_acme', 'target_tenant ⇒ targetTenant (isBreakGlass-Vertrag)');
  assert.equal(ev.tenantId, 't_faltrix');
  assert.equal(ev.capability, 'workflows.starten', 'details werden flach gespreizt (JSONL-Form)');
  assert.equal(ev.login, 'gast@example.test', 'explizite Spalte gewinnt über details-Spread');
});

// ── Unit: createAuditLogWriter — darf NIE werfen ─────────────────────────────
test('#213 createAuditLogWriter: schreibt DB + Datei; DB-Fehler ⇒ Datei-Fallback bleibt, kein Throw', async () => {
  const tmp = path.join(os.tmpdir(), `audit-213-${process.pid}-${Date.now()}.jsonl`);
  const calls = [];
  const exec = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
  const entry = {
    timestamp: '2026-06-11T10:00:00.000Z', event: 'capability_denied', outcome: 'denied',
    login: 'gast@example.test', role: 'guest', capability: 'workflows.starten',
  };
  try {
    const writer = auditLog.createAuditLogWriter({ exec, filePath: tmp });
    const r1 = await writer.write(entry);
    assert.deepEqual(r1, { db: true, file: true });
    assert.ok(/audit\.access_log/i.test(calls[0].sql), 'INSERT in audit.access_log');
    assert.ok(calls[0].params.includes('denied'));
    const line = JSON.parse(fs.readFileSync(tmp, 'utf8').trim());
    assert.equal(line.event, 'capability_denied', 'JSONL-Fallback enthält den vollen Eintrag');
    assert.equal(line.capability, 'workflows.starten');

    // DB kaputt ⇒ resolves (nie Throw), Datei-Senke schreibt weiter.
    const broken = auditLog.createAuditLogWriter({ exec: async () => { throw new Error('DB weg'); }, filePath: tmp });
    const r2 = await broken.write(entry);
    assert.deepEqual(r2, { db: false, file: true });

    // Ohne exec (kein PG konfiguriert) ⇒ graceful, nur Datei.
    const noDb = auditLog.createAuditLogWriter({ exec: null, filePath: tmp });
    assert.deepEqual(await noDb.write(entry), { db: false, file: true });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('#213 createAuditLogWriter: unbeschreibbare Datei (flüchtiges FS) ⇒ kein Throw', async () => {
  const tmpFile = path.join(os.tmpdir(), `audit-213-block-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpFile, 'datei, kein verzeichnis');
  try {
    // Eltern-"Verzeichnis" ist eine Datei ⇒ mkdir/append schlagen fehl ⇒ best-effort.
    const writer = auditLog.createAuditLogWriter({ exec: null, filePath: path.join(tmpFile, 'sub', 'x.jsonl') });
    const r = await writer.write({ event: 'dashboard_view', outcome: 'guest_view' });
    assert.deepEqual(r, { db: false, file: false });
  } finally { fs.rmSync(tmpFile, { force: true }); }
});

// ── LIVE (#94-Sandbox, ROLLBACK): Migration 0035 ─────────────────────────────
test('#213 0035 LIVE: idempotent + Spaltenvertrag — KEIN tenant_id (Pipeline-Telemetrie)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 35);
    await applyMigration(client, 35); // idempotent: zweite Anwendung ohne Fehler

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'audit' AND table_name = 'access_log'`);
    const names = cols.rows.map((r) => r.column_name);
    for (const want of ['ts', 'event', 'outcome', 'login', 'role', 'role_key', 'viewer_tenant',
      'endpoint', 'method', 'source_address', 'request_id', 'target_tenant', 'details']) {
      assert.ok(names.includes(want), `Spalte ${want} vorhanden`);
    }
    assert.ok(!names.includes('tenant_id'),
      'BEWUSST keine tenant_id-Spalte: geteilte Pipeline-Telemetrie (analog audit.workflow_runs), keine RLS-Scope-Spalte');

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'audit' AND tablename = 'access_log'`);
    const idxNames = idx.rows.map((r) => r.indexname);
    assert.ok(idxNames.includes('access_log_ts_idx'), 'Lese-Index auf ts');
    assert.ok(idxNames.includes('access_log_outcome_ts_idx'), 'Lese-Index outcome+ts (Anomalie-Scan)');
  });
});

test('#213 0035 LIVE Kern-AC: Audit-Eintrag überlebt simulierten Neustart (frischer Leser, kein In-Memory-State)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 35);
    const exec = (sql, params) => client.query(sql, params);
    const reqId = `req-213-restart-${Date.now()}`;

    // „Prozess vor dem Neustart": Writer-Instanz schreibt und wird verworfen.
    {
      const writer = auditLog.createAuditLogWriter({ exec, filePath: null });
      const r = await writer.write({
        timestamp: new Date().toISOString(), event: 'capability_denied', outcome: 'denied',
        login: 'gast@example.test', role: 'guest', roleKey: 'guest', tenantId: 't_faltrix',
        endpoint: '/api/v2/overview', method: 'GET', sourceAddress: '127.0.0.1',
        requestId: reqId, capability: 'workflows.starten',
      });
      assert.equal(r.db, true, 'DB-Senke (maßgeblich) hat geschrieben');
      assert.equal(r.file, false, 'ohne filePath keine Datei — der Eintrag existiert NUR in der DB');
    }

    // „Neustart": Modul-Cache leeren ⇒ frische Modul-/Leser-Instanz ohne jeden
    // In-Memory-State. (Eine echte NEUE Verbindung kann den Eintrag im ROLLBACK-
    // Sandbox-Harness prinzipbedingt nicht sehen — die Persistenz liegt in der
    // DB-Zeile, nicht in Modul-/Prozess-State; genau das beweist dieser Test.)
    delete require.cache[require.resolve('../lib/audit-log.js')];
    // eslint-disable-next-line global-require
    const freshAuditLog = require('../lib/audit-log.js');
    assert.notEqual(freshAuditLog, auditLog, 'wirklich frische Modul-Instanz');

    const events = await freshAuditLog.readAuditEventsDb(exec, { windowMin: 60, limit: 500 });
    const found = events.find((e) => e.requestId === reqId);
    assert.ok(found, 'frischer Leser findet den Eintrag in der DB wieder');
    assert.equal(found.outcome, 'denied');
    assert.equal(found.event, 'capability_denied');
    assert.equal(found.login, 'gast@example.test');
    assert.equal(found.capability, 'workflows.starten', 'details-Roundtrip (JSONB)');
  });
});

test('#213 0035 LIVE: readAuditEventsDb respektiert das Zeitfenster (windowMin)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 35);
    const exec = (sql, params) => client.query(sql, params);
    const marker = `req-213-window-${Date.now()}`;

    await auditLog.writeAuditEntryDb(exec, {
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      event: 'alt', outcome: 'denied', requestId: `${marker}-alt`,
    });
    await auditLog.writeAuditEntryDb(exec, {
      timestamp: new Date().toISOString(),
      event: 'frisch', outcome: 'denied', requestId: `${marker}-frisch`,
    });

    const events = await auditLog.readAuditEventsDb(exec, { windowMin: 60, limit: 1000 });
    assert.ok(events.find((e) => e.requestId === `${marker}-frisch`), 'frischer Eintrag im Fenster');
    assert.ok(!events.find((e) => e.requestId === `${marker}-alt`), 'alter Eintrag (2 h) außerhalb des 60-min-Fensters');
  });
});
