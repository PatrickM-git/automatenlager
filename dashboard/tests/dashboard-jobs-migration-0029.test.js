'use strict';

/**
 * Migration 0029 — beweisgestützte cost_basis-Klassifizierung (Issue #179).
 * SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
 *       §"cost_basis-Marker & Klassifizierung"
 *
 * Beweist gegen die ECHTE Mini-DB im #94-Sandbox-Harness (ROLLBACK):
 *   - eindeutig-netto NULL-Zeilen (revenue_net < revenue_gross) → 'netto';
 *   - vom Nacht-Job gestempelte Zeilen ('brutto'/'netto') bleiben unberührt;
 *   - brutto-implizierende NULL-Zeile (revenue_net == revenue_gross, Umsatz > 0)
 *     ⇒ Migration BRICHT AB (RAISE EXCEPTION), setzt NICHTS;
 *   - idempotent (zweiter Lauf = No-op).
 * Erste Datenmutation auf guv_daily — daher streng verhaltensgetrieben. Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration, readMigration, expectReject } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex } = require('./helpers/tenant-fixtures.js');

// Minimal-Insert einer guv_daily-Zeile mit kontrollierten Werten (Owner-Rolle, vor RLS).
async function insertGuv(client, tenant, machineId, productId, key, { gross, net, cost, costBasis = null, source = 'wf8_guv_aggregator' }) {
  await client.query(
    `INSERT INTO automatenlager.guv_daily
       (tenant_id, guv_key, posting_date, machine_id, product_id, quantity_sold,
        revenue_gross, revenue_net, cost_of_goods, gross_profit, source, cost_basis)
     VALUES ($1,$2,'2026-06-08',$3,$4,1,$5,$6,$7,$8,$9,$10)`,
    [tenant, key, machineId, productId, gross, net, cost, gross - cost, source, costBasis]);
}

test('#179 0029 LIVE: eindeutig-netto NULL-Zeilen → netto; gestempelte Zeilen unberührt', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);
    const { acme } = await seedAcmeGlobex(client);

    // (a) NULL + USt abgezogen (100 brutto, 93.46 netto) ⇒ eindeutig netto.
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_netto_null', { gross: 100, net: 93.46, cost: 10, costBasis: null });
    // (b) NULL + revenue_gross 0 ⇒ degeneriert, netto-sicher.
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_zero', { gross: 0, net: 0, cost: 0, costBasis: null });
    // (c) bereits 'brutto' gestempelt (Nacht-Job #176) ⇒ außerhalb des Scope.
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_brutto', { gross: 100, net: 100, cost: 10, costBasis: 'brutto' });
    // (d) bereits 'netto' gestempelt ⇒ unberührt.
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_netto_marked', { gross: 100, net: 93.46, cost: 10, costBasis: 'netto' });

    await applyMigration(client, 29);

    const cb = async (key) => (await client.query(
      `SELECT cost_basis FROM automatenlager.guv_daily WHERE guv_key = $1`, [key])).rows[0].cost_basis;
    assert.equal(await cb('k_netto_null'), 'netto', 'eindeutig-netto NULL → netto');
    assert.equal(await cb('k_zero'), 'netto', 'degenerierte 0-Umsatz-Zeile → netto');
    assert.equal(await cb('k_brutto'), 'brutto', 'gestempelte brutto-Zeile unberührt');
    assert.equal(await cb('k_netto_marked'), 'netto', 'gestempelte netto-Zeile unberührt');
  });
});

test('#179 0029 LIVE: brutto-implizierende NULL-Zeile ⇒ Migration bricht ab, setzt nichts', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);
    const { acme } = await seedAcmeGlobex(client);

    // Eine eindeutige netto-NULL-Zeile + eine brutto-implizierende NULL-Zeile
    // (revenue_net == revenue_gross trotz Umsatz > 0).
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_ok', { gross: 100, net: 93.46, cost: 10, costBasis: null });
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_anom', { gross: 50, net: 50, cost: 5, costBasis: null });

    // Migration MUSS abbrechen (SAVEPOINT isoliert den erwarteten Fehler).
    await expectReject(client, readMigration(29), /abgebrochen|brutto-implizier/i, '0029 bricht bei Anomalie ab');

    // Nichts gesetzt: beide NULL-Zeilen bleiben NULL.
    const nulls = await client.query(
      `SELECT count(*)::int AS n FROM automatenlager.guv_daily
        WHERE guv_key IN ('k_ok','k_anom') AND cost_basis IS NULL`);
    assert.equal(nulls.rows[0].n, 2, 'keine Zeile klassifiziert (all-or-nothing)');
  });
});

test('#179 0029 LIVE: idempotent — zweiter Lauf ändert nichts', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 28);
    const { acme } = await seedAcmeGlobex(client);
    await insertGuv(client, 'acme', acme.machineId, acme.productId, 'k_idem', { gross: 100, net: 93.46, cost: 10, costBasis: null });

    await applyMigration(client, 29);
    const after1 = await client.query(
      `SELECT count(*)::int AS n FROM automatenlager.guv_daily WHERE cost_basis = 'netto'`);
    await applyMigration(client, 29); // zweiter Lauf
    const after2 = await client.query(
      `SELECT count(*)::int AS n FROM automatenlager.guv_daily WHERE cost_basis = 'netto'`);
    assert.equal(after2.rows[0].n, after1.rows[0].n, 'zweiter Lauf ändert die netto-Zahl nicht');

    const remainingNull = await client.query(
      `SELECT count(*)::int AS n FROM automatenlager.guv_daily WHERE cost_basis IS NULL`);
    assert.equal(remainingNull.rows[0].n, 0, 'nach sauberem Lauf keine NULL mehr (keine Anomalie)');
  });
});
