'use strict';

/**
 * WF5 MHD/Low-Stock-Überwachung + Versand-Abschluss — In-Process-Port
 * (Issue #162, Stufe 6 Slice 2). n8n: scheduleTrigger täglich 07:00.
 *
 * Leseseite: `alert-digest.js` (bereits portiert) für die E-Mail.
 * Neu hier: (a) zeitgesteuerter Digest-Versand via Mailer; (b) Warnungs-INSERT
 * (MHD_EXPIRED/MHD_NEAR/LOW_BATCH) + Auto-Resolve durch die Mandanten-Tür.
 *
 * Ebenen: (1) reine Logik buildWf5Warnings/formatDigestEmail; (2) Live
 * syncWf5Warnings durch die Tür (acme/globex nicht-vakuös); (3) Orchestrierung.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const wf5 = require('../lib/jobs/wf5-monitor.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T07:00:00.000Z';

// ── Ebene 1: buildWf5Warnings ────────────────────────────────────────────────
test('#162 buildWf5Warnings: Typen/Severity/Key-Format verhaltensgetreu (WARN_<type>_<pk>_<batch|NO_SLOT>)', () => {
  const warnings = wf5.buildWf5Warnings({
    mhdExpired: [{ product_key: 'kitkat', product_id: 1, batch_key: 'B1', message: 'abgelaufen' }],
    mhdNear: [{ product_key: 'cola', product_id: 2, batch_key: 'B2', message: 'bald' }],
    lowBatch: [{ product_key: 'chips', product_id: 3, message: 'wenig' }],
  });
  const byKey = Object.fromEntries(warnings.map((w) => [w.warning_key, w]));
  assert.ok(byKey.WARN_MHD_EXPIRED_KITKAT_B1, 'MHD_EXPIRED-Key');
  assert.equal(byKey.WARN_MHD_EXPIRED_KITKAT_B1.warning_type, 'MHD_EXPIRED');
  assert.equal(byKey.WARN_MHD_EXPIRED_KITKAT_B1.severity, 'critical');
  assert.ok(byKey.WARN_MHD_NEAR_COLA_B2, 'MHD_NEAR-Key');
  assert.equal(byKey.WARN_MHD_NEAR_COLA_B2.severity, 'warning');
  assert.ok(byKey.WARN_LOW_BATCH_CHIPS_NO_SLOT, 'LOW_BATCH ohne Batch ⇒ NO_SLOT');
  assert.equal(byKey.WARN_LOW_BATCH_CHIPS_NO_SLOT.warning_type, 'LOW_BATCH');
});

test('#162 buildWf5Warnings: leere Bedingungen ⇒ keine Warnungen', () => {
  assert.deepEqual(wf5.buildWf5Warnings({}), []);
});

// ── Ebene 1: formatDigestEmail ───────────────────────────────────────────────
test('#162 formatDigestEmail: Betreff + Text spiegeln die Zähler', () => {
  const mail = wf5.formatDigestEmail({
    counts: { mhdExpired: 2, mhdSoon: 1, emptyBatches: 0, lowBatches: 3, emptySlots: 1, dataIssues: 0 },
    mhdExpired: [], mhdSoon: [], lowBatches: [], emptySlots: [], dataIssues: [],
  }, 'acme');
  assert.match(mail.subject, /MHD|Bestand|Lager|Hinweis/i);
  assert.match(mail.text, /2/); // mhdExpired-Zähler
  assert.ok(mail.text.length > 0);
});

// ── Ebene 3: Orchestrierung mit Fakes ────────────────────────────────────────
test('#162 runWf5MonitorForTenant: keine Issues ⇒ kein Mail-Versand', async () => {
  let mailed = false;
  const db = {
    read: async () => ({ rows: [], rowCount: 0 }),
    tx: async (_t, fn) => fn({ write: async () => ({ rowCount: 0 }) }),
  };
  const mailer = { send: async () => { mailed = true; } };
  const res = await wf5.runWf5MonitorForTenant(db, 'acme', { mailer, env: { ALERT_EMAIL_DEFAULT: 'ops@x.test' }, nowIso: NOW });
  assert.equal(mailed, false, 'kein Versand ohne Issues');
  assert.equal(res.tenant, 'acme');
});

test('#162 createWf5MonitorJob: ohne tenantRunner ⇒ TypeError (fail-closed)', () => {
  assert.throws(() => wf5.createWf5MonitorJob({}), /tenantRunner/);
});

// ── Ebene 2: Live durch die Tür ──────────────────────────────────────────────
test('#162 syncWf5Warnings LIVE: INSERT + Auto-Resolve durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // Abgelaufene MHD-Charge je Mandant (RAW, vor RLS).
    for (const ten of [acme, globex]) {
      await client.query(
        `INSERT INTO automatenlager.stock_batches
           (batch_key, product_id, initial_qty, remaining_qty, unit_cost_net, status, received_at, mhd_date, tenant_id)
         VALUES ($1, $2, 10, 10, 1.0, 'active', '2026-01-01', CURRENT_DATE - 5, $3)`,
        [`exp_${ten.tenantId}`, ten.productId, ten.tenantId],
      );
    }
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // 1) Bedingungen lesen + Warnungen bauen + synchronisieren (nur acme)
    const cond = await wf5.readWf5Conditions(db, 'acme', {});
    assert.ok(cond.mhdExpired.length >= 1, 'abgelaufene Charge erkannt');
    const warnings = wf5.buildWf5Warnings(cond);
    const sync1 = await wf5.syncWf5Warnings(db, 'acme', warnings, { nowIso: NOW });
    assert.ok(sync1.inserted >= 1, 'mindestens 1 Warnung eingefügt');

    const acmeOpen = await db.read({
      tenant: 'acme', tables: ['warnings'],
      text: `SELECT count(*)::int AS n FROM automatenlager.warnings WHERE tenant_id = $1 AND source_workflow = 'wf5' AND resolved = FALSE AND warning_type = 'MHD_EXPIRED'`,
    });
    assert.equal(acmeOpen.rows[0].n, 1, 'acme: 1 offene MHD_EXPIRED-Warnung');

    // ISOLATION: globex hat keine VON DIESEM JOB verwaltete Warnung (MHD_EXPIRED).
    // (Die Fixture seedet je Mandant eine source_workflow='wf5'/WORKFLOW_ERROR-Warnung —
    //  die ist NICHT vom WF5-Monitor verwaltet und bleibt unangetastet.)
    const globexOpen = await db.read({
      tenant: 'globex', tables: ['warnings'],
      text: `SELECT count(*)::int AS n FROM automatenlager.warnings WHERE tenant_id = $1 AND warning_type = 'MHD_EXPIRED'`,
    });
    assert.equal(globexOpen.rows[0].n, 0, 'globex: keine MHD_EXPIRED-Warnung');

    // 2) Auto-Resolve: erneuter Sync OHNE Bedingungen ⇒ verwaltete wf5-Warnung wird resolved
    const sync2 = await wf5.syncWf5Warnings(db, 'acme', [], { nowIso: NOW });
    assert.equal(sync2.resolved, 1, '1 verwaltete Warnung auto-resolved');
    const acmeAfter = await db.read({
      tenant: 'acme', tables: ['warnings'],
      text: `SELECT count(*)::int AS n FROM automatenlager.warnings
               WHERE tenant_id = $1 AND resolved = FALSE
                 AND warning_type = ANY(ARRAY['MHD_EXPIRED','MHD_NEAR','LOW_BATCH'])`,
    });
    assert.equal(acmeAfter.rows[0].n, 0, 'acme: keine offene verwaltete Warnung mehr');
  });
});
