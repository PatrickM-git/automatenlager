'use strict';

/**
 * GuV-Restatement-Run 0030 (Issue #180) — Historie in-place auf brutto, auditiert,
 * rollbackfähig. SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
 *
 *  (1) Reine Formel computeRestatedRow (byte-genau wie der Nacht-Job, #176).
 *  (2) LIVE durch die Mandanten-Tür unter RLS (automatenlager_app, #94-Sandbox):
 *      Restatement, Audit-Logbuch, Idempotenz, Mandanten-Tor (regelbesteuert),
 *      acme/globex-Isolation, historic_backfill über cost_basis, Schutzbedingung,
 *      Rollback (exakte Wiederherstellung) + erneutes Restatement == identisch.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeRestatedRow, restateTenant, rollbackRun } = require('../lib/guv-restatement.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');
const { buildEffectiveConfig, sanitizeOverride } = require('../lib/category-config.js');

const eff = buildEffectiveConfig(sanitizeOverride({})); // snack 7 %, getraenk 19 %, default 19 %

// ── (1) Reine Formel ─────────────────────────────────────────────────────────

test('#180 computeRestatedRow: KU-Brutto-Formel (snack 7 %) — byte-genau wie der Nacht-Job', () => {
  const r = computeRestatedRow({ category: 'snack', cost_of_goods: 10, revenue_gross: 100, revenue_net: 93.46 }, eff);
  assert.equal(r.vatRate, 7);
  assert.equal(r.factor, 1.07);
  assert.equal(r.newCogs, 10.7, '10 × 1,07');
  assert.equal(r.newGrossProfit, 89.3, '100 − 10,70');
  assert.equal(r.newRevenueNet, 100, 'KU ⇒ revenue_net = revenue_gross');
});

test('#180 computeRestatedRow: Getränk 19 % und unbekannte Kategorie (Default 19 %)', () => {
  const drink = computeRestatedRow({ category: 'getraenk', cost_of_goods: 10, revenue_gross: 100 }, eff);
  assert.equal(drink.newCogs, 11.9, '10 × 1,19');
  const unknown = computeRestatedRow({ category: 'gibtsnicht', cost_of_goods: 10, revenue_gross: 100 }, eff);
  assert.equal(unknown.vatRate, 19, 'unbekannte Kategorie ⇒ defaultMwstPct 19');
  assert.equal(unknown.newCogs, 11.9);
});

// ── (2) LIVE durch die Tür unter RLS ─────────────────────────────────────────

// guv_daily-Zeile mit kontrollierten Werten (Owner, vor SET ROLE).
async function insertGuv(client, tenant, machineId, productId, key, { gross, net, cost, costBasis, source = 'wf8_guv_aggregator' }) {
  await client.query(
    `INSERT INTO automatenlager.guv_daily
       (tenant_id, guv_key, posting_date, machine_id, product_id, quantity_sold,
        revenue_gross, revenue_net, cost_of_goods, gross_profit, source, cost_basis)
     VALUES ($1,$2,'2026-06-08',$3,$4,1,$5,$6,$7,$8,$9,$10)`,
    [tenant, key, machineId, productId, gross, net, cost, gross - cost, source, costBasis]);
}

// Gemeinsames Setup: seed + Migrationen (28 cost_basis, 22-26 RLS, 30 Grants),
// netto-Zeilen je Mandant, KU-Config, App-Rolle scharf. Liefert den Door + IDs.
async function setupRestatement(client, { acmeKu = true } = {}) {
  const { acme, globex } = await seedAcmeGlobex(client);
  // Seed-eigene guv_daily-Zeilen entfernen ⇒ deterministischer Scope (nur unsere Zeilen,
  // keine ungewollte NULL-Zeile, die die Schutzbedingung auslöst).
  await client.query(`DELETE FROM automatenlager.guv_daily WHERE tenant_id IN ('acme','globex')`);
  await applyMigration(client, 28); // cost_basis-Spalte

  // netto-Zeilen je Mandant (snack 7 %): acme COGS 10, globex COGS 20.
  await insertGuv(client, 'acme', acme.machineId, acme.productId, 'r_acme', { gross: 100, net: 93.46, cost: 10, costBasis: 'netto' });
  await insertGuv(client, 'globex', globex.machineId, globex.productId, 'r_globex', { gross: 200, net: 168.07, cost: 20, costBasis: 'netto' });
  // historic_backfill-Zeile (acme) — muss über cost_basis (nicht source) miterfasst werden.
  await insertGuv(client, 'acme', acme.machineId, acme.productId, 'r_acme_hist', { gross: 50, net: 46.73, cost: 5, costBasis: 'netto', source: 'historic_backfill' });

  // KU-Config global (__default__).
  await client.query(
    `INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
       VALUES ('__default__', $1::jsonb, now())
     ON CONFLICT (mandant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [JSON.stringify({ kleinunternehmerAktiv: true })]);

  for (const n of [22, 23, 24, 25, 26, 30]) await applyMigration(client, n); // RLS scharf + audit-Grants
  await client.query('SET ROLE automatenlager_app');
  const db = createTenantDb({ pool: sandboxTxPool(client) });
  return { db, acme, globex };
}

async function guvRow(db, tenant, key) {
  return (await db.read({
    tenant, tables: ['guv_daily'],
    text: `SELECT cost_of_goods, gross_profit, revenue_net, revenue_gross, cost_basis
             FROM automatenlager.guv_daily WHERE tenant_id=$1 AND guv_key=$2`,
    params: [key],
  })).rows[0];
}

test('#180 LIVE: KU-Restatement hebt netto→brutto exakt + Audit-Logbuch vollständig', async (t) => {
  await inSandbox(t, async (client) => {
    const { db } = await setupRestatement(client);
    try {
      const res = await restateTenant(db, 'acme', {
        runId: 'run-A', kleinunternehmer: true, effConfig: eff,
        executedContext: { operator: 'test', git_commit: 'abc123' },
      });
      assert.equal(res.restated, 2, 'acme: 2 netto-Zeilen (wf8 + historic_backfill)');
      assert.equal(res.logged, 2, 'je Zeile ein Logbuch-Eintrag');

      const a = await guvRow(db, 'acme', 'r_acme');
      assert.equal(Number(a.cost_of_goods), 10.7, '10 × 1,07');
      assert.equal(Number(a.gross_profit), 89.3, '100 − 10,70');
      assert.equal(Number(a.revenue_net), 100, 'revenue_net = revenue_gross');
      assert.equal(a.cost_basis, 'brutto');

      // historic_backfill über cost_basis miterfasst.
      const h = await guvRow(db, 'acme', 'r_acme_hist');
      assert.equal(Number(h.cost_of_goods), 5.35, '5 × 1,07 (historic_backfill restated)');
      assert.equal(h.cost_basis, 'brutto');

      // Audit-Logbuch vollständig (run_id, Alt/Neu, vat_rate, factor, executed_by, context).
      const log = (await db.read({
        tenant: 'acme', tables: ['guv_restatement_log'],
        text: `SELECT guv_key, old_cost_of_goods, new_cost_of_goods, old_gross_profit, new_gross_profit,
                      old_revenue_net, new_revenue_net, vat_rate, factor, executed_by, executed_context
                 FROM audit.guv_restatement_log WHERE tenant_id=$1 AND restatement_run_id=$2 ORDER BY guv_key`,
        params: ['run-A'],
      })).rows;
      assert.equal(log.length, 2);
      const wf8 = log.find((r) => r.guv_key === 'r_acme');
      assert.equal(Number(wf8.old_cost_of_goods), 10);
      assert.equal(Number(wf8.new_cost_of_goods), 10.7);
      assert.equal(Number(wf8.vat_rate), 7);
      assert.equal(Number(wf8.factor), 1.07);
      assert.equal(wf8.executed_by, 'restatement-0030');
      assert.equal(wf8.executed_context.operator, 'test', 'executed_context als jsonb gespeichert');
    } finally { await client.query('RESET ROLE'); }
  });
});

test('#180 LIVE: idempotent — zweiter Lauf restated 0, kein zweiter Logbuch-Eintrag', async (t) => {
  await inSandbox(t, async (client) => {
    const { db } = await setupRestatement(client);
    try {
      await restateTenant(db, 'acme', { runId: 'run-1', kleinunternehmer: true, effConfig: eff });
      const second = await restateTenant(db, 'acme', { runId: 'run-2', kleinunternehmer: true, effConfig: eff });
      assert.equal(second.restated, 0, 'nichts mehr netto im Scope');
      assert.equal(second.logged, 0, 'kein zweiter Logbuch-Eintrag');
      const log2 = (await db.read({
        tenant: 'acme', tables: ['guv_restatement_log'],
        text: `SELECT count(*)::int AS n FROM audit.guv_restatement_log WHERE tenant_id=$1 AND restatement_run_id='run-2'`,
      })).rows[0];
      assert.equal(log2.n, 0);
    } finally { await client.query('RESET ROLE'); }
  });
});

test('#180 LIVE: Mandanten-Tor + Isolation — regelbesteuert bleibt netto, kein Cross-Tenant-Effekt', async (t) => {
  await inSandbox(t, async (client) => {
    const { db } = await setupRestatement(client);
    try {
      // Nur acme als KU restaten; globex NICHT angefasst.
      await restateTenant(db, 'acme', { runId: 'run-iso', kleinunternehmer: true, effConfig: eff });
      const g = await guvRow(db, 'globex', 'r_globex');
      assert.equal(g.cost_basis, 'netto', 'globex unberührt (Isolation)');
      assert.equal(Number(g.cost_of_goods), 20, 'globex-COGS unverändert');

      // Regelbesteuerter Lauf (kleinunternehmer:false) ⇒ nichts, kein Logbuch.
      const reg = await restateTenant(db, 'globex', { runId: 'run-reg', kleinunternehmer: false, effConfig: eff });
      assert.equal(reg.restated, 0);
      assert.equal(reg.skipped, 'not_kleinunternehmer');
      const g2 = await guvRow(db, 'globex', 'r_globex');
      assert.equal(g2.cost_basis, 'netto', 'regelbesteuert ⇒ bleibt netto, nie restated');
      const logReg = (await db.read({
        tenant: 'globex', tables: ['guv_restatement_log'],
        text: `SELECT count(*)::int AS n FROM audit.guv_restatement_log WHERE tenant_id=$1`,
      })).rows[0];
      assert.equal(logReg.n, 0, 'kein Logbuch-Eintrag für globex');
    } finally { await client.query('RESET ROLE'); }
  });
});

test('#180 LIVE: Schutzbedingung — NULL-Zeile im Scope ⇒ Restatement bricht ab', async (t) => {
  await inSandbox(t, async (client) => {
    const { db, acme } = await setupRestatement(client);
    try {
      // Eine NULL-Zeile in den acme-Scope einschleusen (als App-Rolle via Tür-Insert
      // würde RLS/Grant greifen; einfacher direkt — aber wir sind als app-Rolle. Daher
      // über die Tür einfügen): cost_basis NULL.
      await db.tx('acme', async (door) => {
        await door.write({
          tables: ['guv_daily'],
          text: `INSERT INTO automatenlager.guv_daily
                   (tenant_id, guv_key, posting_date, machine_id, product_id, quantity_sold,
                    revenue_gross, revenue_net, cost_of_goods, gross_profit, source, cost_basis)
                 VALUES ($1,'r_null','2026-06-08',$2,$3,1,10,9,1,9,'wf8_guv_aggregator',NULL)`,
          params: [acme.machineId, acme.productId],
        });
      });
      await assert.rejects(
        () => restateTenant(db, 'acme', { runId: 'run-x', kleinunternehmer: true, effConfig: eff }),
        /abgebrochen|cost_basis IS NULL/i,
        'Restatement bricht bei NULL-Zeile im Scope ab');
    } finally { await client.query('RESET ROLE'); }
  });
});

test('#180 LIVE: Rollback stellt Alt-Werte exakt wieder her; erneutes Restatement == identisch', async (t) => {
  await inSandbox(t, async (client) => {
    const { db } = await setupRestatement(client);
    try {
      const before = await guvRow(db, 'acme', 'r_acme');
      await restateTenant(db, 'acme', { runId: 'run-rb', kleinunternehmer: true, effConfig: eff });
      const restated = await guvRow(db, 'acme', 'r_acme');
      assert.equal(Number(restated.cost_of_goods), 10.7);

      // Rollback aus dem Logbuch.
      const rb = await rollbackRun(db, 'acme', { runId: 'run-rb' });
      assert.ok(rb.rolledBack >= 2, 'mindestens die 2 acme-Zeilen zurückgerollt');
      const after = await guvRow(db, 'acme', 'r_acme');
      assert.equal(Number(after.cost_of_goods), Number(before.cost_of_goods), 'Alt-COGS exakt wiederhergestellt');
      assert.equal(Number(after.gross_profit), Number(before.gross_profit));
      assert.equal(Number(after.revenue_net), Number(before.revenue_net));
      assert.equal(after.cost_basis, 'netto', 'cost_basis zurück auf netto');

      // Erneutes Restatement liefert wieder identische neue Werte.
      await restateTenant(db, 'acme', { runId: 'run-rb2', kleinunternehmer: true, effConfig: eff });
      const re = await guvRow(db, 'acme', 'r_acme');
      assert.equal(Number(re.cost_of_goods), 10.7, 'reproduzierbar nach Rollback');
      assert.equal(re.cost_basis, 'brutto');
    } finally { await client.query('RESET ROLE'); }
  });
});
