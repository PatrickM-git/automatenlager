'use strict';

/**
 * DB-Validierung (Issue #161, Stufe 6 Slice 1) — Ersatz für WF-Val (nur DB-Checks).
 * Reiner Report-Bau (faithful zum n8n-Mailformat) + LIVE-Isolation durch die Tür:
 * jeder Mandant sieht NUR seine Inkonsistenzen; Alert geht an die Mandanten-Adresse.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const dv = require('../lib/jobs/db-validation.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── Unit: Report-Bau ─────────────────────────────────────────────────────────

test('#161 buildValidationReport: leer ⇒ keine Issues', () => {
  const r = dv.buildValidationReport({});
  assert.equal(r.hasIssues, false);
  assert.equal(r.count, 0);
  assert.equal(r.subject, null);
});

test('#161 buildValidationReport: zählt Zeilen, Betreff/HTML faithful, Singular/Plural', () => {
  const r = dv.buildValidationReport({
    alte_warnungen: [{ message: '2 ungeloeste Warnungen (Typ: WORKFLOW_ERROR) aelter 7 Tage' }, { message: '1 ungeloeste Warnungen (Typ: UNKNOWN_PRODUCT) aelter 7 Tage' }],
    negative_qty: [{ message: 'Negative Menge (-2) fuer: Snickers' }],
  }, '2026-06-08T00:00:00Z');
  assert.equal(r.count, 3, '3 Zeilen über 2 Typen');
  assert.equal(r.subject, '[DB-Check] 3 Probleme - Automatenlager');
  assert.match(r.html, /WF-Val Pruefung: 3 Probleme/);
  assert.match(r.html, /Alte ungeloeste Warnungen \(>7 Tage\) \(2\)/);
  assert.match(r.html, /Negative Lagermengen \(1\)/);
  assert.match(r.html, /<li>Negative Menge \(-2\) fuer: Snickers<\/li>/);

  const one = dv.buildValidationReport({ negative_qty: [{ message: 'x' }] });
  assert.equal(one.subject, '[DB-Check] 1 Problem - Automatenlager', 'Singular');
});

test('#161 Eingedampfter Scope: kein keine_preise; Bestands-/MHD-Typen ausgenommen', () => {
  assert.ok(!dv.CHECK_ORDER.includes('keine_preise'), 'keine_preise ist entfernt (Rauschen)');
  for (const t of ['LOW_BATCH', 'LOW_STOCK', 'MHD_NEAR']) {
    assert.ok(dv.NON_ISSUE_WARNING_TYPES.includes(t), `${t} ist von "alte Warnungen" ausgenommen`);
  }
});

test('#161 createDbValidationJob: ohne tenantRunner ⇒ TypeError', () => {
  assert.throws(() => dv.createDbValidationJob({}), /tenantRunner/);
});

// ── LIVE: Isolation durch die Tür + Mandanten-Alert ──────────────────────────
test('#161 DB-Validierung LIVE: Isolation + LOW_BATCH ausgenommen, WORKFLOW_ERROR drin', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    // (a) negative Menge je Mandant (unterscheidbar über den Produktnamen) ⇒ negative_qty
    await client.query(`UPDATE automatenlager.stock_batches SET remaining_qty = -3 WHERE batch_key IN ('b_acme','b_globex')`);
    // (b) die WORKFLOW_ERROR-Fixture-Warnung alt + severity setzen ⇒ echter Fehler, bleibt drin
    await client.query(`UPDATE automatenlager.warnings SET created_at = now() - INTERVAL '10 days', severity = 'warning' WHERE warning_key IN ('warn_acme','warn_globex')`);
    // (c) alte LOW_BATCH-Warnung je Mandant ⇒ MUSS ausgenommen werden (Ladenhüter-Fix)
    for (const tid of ['acme', 'globex']) {
      await client.query(
        `INSERT INTO automatenlager.warnings (warning_key, warning_type, message, severity, source_workflow, tenant_id, created_at, resolved)
         VALUES ($1, 'LOW_BATCH', $2, 'warning', 'wf5', $3, now() - INTERVAL '10 days', FALSE)`,
        [`lowbatch_${tid}`, `Skittles ${tid}: nur noch 4`, tid]);
    }
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      const mk = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); return { id: 'x' }; } }; };

      const mAcme = mk();
      const rA = await dv.validateTenant(db, 'acme', { mailer: mAcme, env: { ALERT_EMAIL_DEFAULT: 'ops@x', ALERT_EMAIL_acme: 'acme-ops@x' } });
      assert.equal(rA.hasIssues, true);
      assert.equal(rA.mailed, true);
      assert.equal(rA.recipient, 'acme-ops@x', 'per-Mandant-Adresse bevorzugt');
      const html = mAcme.sent[0].html;
      assert.match(html, /Cola acme/, 'negative Menge nennt acme-Produkt (nicht-vakuös)');
      assert.match(html, /WORKFLOW_ERROR/, 'echter Workflow-Fehler bleibt drin');
      assert.ok(!/LOW_BATCH/.test(html), 'Bestands-Warnung LOW_BATCH ist AUSGENOMMEN (Ladenhüter-Fix)');
      assert.ok(!/Skittles/.test(html), 'kein Skittles-Bestands-Rauschen');
      assert.ok(!/Cola globex/.test(html), 'Isolation: kein globex-Produkt');

      const mGlobex = mk();
      const rG = await dv.validateTenant(db, 'globex', { mailer: mGlobex, env: { ALERT_EMAIL_DEFAULT: 'ops@x' } });
      assert.equal(rG.recipient, 'ops@x', 'Fallback-Default ohne per-Mandant-Adresse');
      assert.match(mGlobex.sent[0].html, /Cola globex/);
      assert.ok(!/Cola acme/.test(mGlobex.sent[0].html), 'Isolation: kein acme-Produkt');
      assert.ok(!/LOW_BATCH/.test(mGlobex.sent[0].html), 'LOW_BATCH auch bei globex ausgenommen');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
