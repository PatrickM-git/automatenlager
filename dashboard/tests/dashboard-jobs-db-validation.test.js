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
    keine_preise: [{ message: 'Aktiver Slot ohne Preis: Cola' }, { message: 'Aktiver Slot ohne Preis: Fanta' }],
    negative_qty: [{ message: 'Negative Menge (-2) fuer: Snickers' }],
  }, '2026-06-08T00:00:00Z');
  assert.equal(r.count, 3, '3 Zeilen über 2 Typen');
  assert.equal(r.subject, '[DB-Check] 3 Probleme - Automatenlager');
  assert.match(r.html, /WF-Val Pruefung: 3 Probleme/);
  assert.match(r.html, /Aktive Slots ohne Preis \(2\)/);
  assert.match(r.html, /Negative Lagermengen \(1\)/);
  assert.match(r.html, /<li>Negative Menge \(-2\) fuer: Snickers<\/li>/);

  const one = dv.buildValidationReport({ negative_qty: [{ message: 'x' }] });
  assert.equal(one.subject, '[DB-Check] 1 Problem - Automatenlager', 'Singular');
});

test('#161 createDbValidationJob: ohne tenantRunner ⇒ TypeError', () => {
  assert.throws(() => dv.createDbValidationJob({}), /tenantRunner/);
});

// ── LIVE: Isolation durch die Tür + Mandanten-Alert ──────────────────────────
test('#161 DB-Validierung LIVE: jeder Mandant nur eigene Inkonsistenzen, Alert an Mandanten-Adresse', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client); // jeder Mandant hat 1 AKTIVEN Slot OHNE Preis ⇒ keine_preise feuert
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      const mk = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); return { id: 'x' }; } }; };

      const mAcme = mk();
      const rA = await dv.validateTenant(db, 'acme', { mailer: mAcme, env: { ALERT_EMAIL_DEFAULT: 'ops@x', ALERT_EMAIL_acme: 'acme-ops@x' } });
      assert.ok(rA.count >= 1, 'acme hat mind. 1 Inkonsistenz (preisloser Slot, nicht-vakuös)');
      assert.equal(rA.hasIssues, true);
      assert.equal(rA.mailed, true);
      assert.equal(rA.recipient, 'acme-ops@x', 'per-Mandant-Adresse bevorzugt');
      assert.equal(mAcme.sent.length, 1);
      assert.match(mAcme.sent[0].html, /Cola acme/, 'acme-Alert nennt acme-Produkt (nicht-vakuös)');
      assert.ok(!/Cola globex/.test(mAcme.sent[0].html), 'acme-Alert nennt KEIN globex-Produkt (Isolation)');

      const mGlobex = mk();
      const rG = await dv.validateTenant(db, 'globex', { mailer: mGlobex, env: { ALERT_EMAIL_DEFAULT: 'ops@x' } });
      assert.equal(rG.recipient, 'ops@x', 'Fallback-Default, wenn keine per-Mandant-Adresse');
      assert.match(mGlobex.sent[0].html, /Cola globex/);
      assert.ok(!/Cola acme/.test(mGlobex.sent[0].html), 'globex-Alert nennt KEIN acme-Produkt (Isolation)');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
