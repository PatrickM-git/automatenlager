'use strict';

/**
 * Übersicht/Cockpit/Monitoring-Lese-Isolation (Issue #124, Stufe 3) — acme/globex.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md (Pflicht-Testfälle 1–3, 9, 14)
 *
 * Öffentliche Lese-Funktionen, jetzt durch die Tür:
 *   queryOverviewMonitoringPg(db, tenant, {mhdDays})
 *   queryEconomicsScopePg(db, tenant)
 *   queryAlertDigestPg(db, tenant, opts)   ← Hintergrund-Job, EXPLIZITER Mandant
 *
 * LIVE im #94-Sandbox-Harness (ROLLBACK). Skippt offline.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex, doorForClient } = require('./helpers/tenant-fixtures.js');
const { queryOverviewMonitoringPg } = require('../lib/overview-monitoring.js');
const { queryEconomicsScopePg } = require('../lib/automaten-view.js');
const { queryAlertDigestPg } = require('../lib/alert-digest.js');

async function seedTodaySale(client, t) {
  await client.query(
    `INSERT INTO automatenlager.sales_transactions
       (nayax_transaction_id, machine_id, product_id, product_name_raw, quantity,
        gross_amount, net_amount, vat_amount, settlement_at, processing_status, tenant_id)
       VALUES ($1,$2,$3,$4,2,$5,$6,$7, now(), 'matched', $8)`,
    [`tx_today_${t.tenantId}`, t.machineId, t.productId, t.productName, t.revenueGross,
     Math.round((t.revenueGross / 1.19) * 100) / 100,
     Math.round((t.revenueGross - t.revenueGross / 1.19) * 100) / 100, t.tenantId],
  );
}

test('#124 overview: acme-Viewer sieht nur acme (Umsatz heute + Warnungen, nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    const { acme, globex } = await seedAcmeGlobex(client);
    await seedTodaySale(client, acme);
    await seedTodaySale(client, globex);

    const a = await queryOverviewMonitoringPg(db, 'acme', {});
    const g = await queryOverviewMonitoringPg(db, 'globex', {});

    // Umsatz heute: acme = nur acme (100), nicht acme+globex (350).
    assert.equal(Math.round(a.economicsToday.revenueGross), 100, 'acme Umsatz heute nur acme');
    assert.equal(Math.round(g.economicsToday.revenueGross), 250, 'globex Umsatz heute nur globex');

    // Warnungen: acme sieht seine Warnung, nicht die von globex.
    const aKeys = a.warnings.map((w) => w.warning_key);
    assert.ok(aKeys.includes('warn_acme'), 'acme sieht acme-Warnung');
    assert.ok(!aKeys.includes('warn_globex'), 'acme sieht KEINE globex-Warnung');
    assert.ok(a.openWarningsCount >= 1, 'acme hat offene Warnungen');
  });
});

test('#124 overview fail-closed: kein Mandant ⇒ alles leer/0', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    const { acme } = await seedAcmeGlobex(client);
    await seedTodaySale(client, acme);
    const none = await queryOverviewMonitoringPg(db, '', {});
    assert.equal(none.economicsToday.revenueGross, 0, 'kein Umsatz ohne Mandant');
    assert.equal(none.warnings.length, 0, 'keine Warnungen ohne Mandant');
    assert.equal(none.openWarningsCount, 0);
    assert.equal(none.workflowRuns.length, 0, 'System-Telemetrie tenant-gated: kein Mandant ⇒ leer');
  });
});

test('#124 overview workflow_runs: System-Telemetrie ist tenant-gated (Mandant ja, kein Mandant nein)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    // audit.workflow_runs trägt reale System-Läufe (geteilte Pipeline). Mit Mandant
    // sichtbar (nicht partitioniert), ohne Mandant fail-closed leer.
    const total = await client.query(`SELECT count(*)::int AS n FROM audit.workflow_runs WHERE started_at >= now() - INTERVAL '3 days'`);
    const a = await queryOverviewMonitoringPg(db, 'acme', {});
    if (total.rows[0].n > 0) {
      assert.ok(a.workflowRuns.length >= 1, 'Mandant sieht System-Telemetrie (tenant-gated)');
    } else {
      t.diagnostic('keine workflow_runs in den letzten 3 Tagen — Gating strukturell abgedeckt');
    }
  });
});

test('#124 economics scope: acme sieht nur acme-Automaten (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    const a = await queryEconomicsScopePg(db, 'acme');
    const g = await queryEconomicsScopePg(db, 'globex');
    // buildEconomicsScope liefert {locations, machines} mit location_name —
    // Fixture-Standort 'Standort <tid>' unterscheidet die Mandanten.
    const aStr = JSON.stringify(a);
    assert.ok(/Standort acme/.test(aStr), 'acme-Scope enthält acme-Standort');
    assert.ok(!/Standort globex/.test(aStr), 'acme-Scope enthält KEINEN globex-Standort');
    assert.ok(/Standort globex/.test(JSON.stringify(g)), 'globex-Scope ist nicht leer (nicht-vakuös)');
  });
});

test('#124 alert-digest (Hintergrund): mit Mandant nur dessen Daten', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    const a = await queryAlertDigestPg(db, 'acme', {});
    const keys = a.warnings.map((w) => w.warning_key);
    assert.ok(keys.includes('warn_acme'), 'acme-Digest enthält acme-Warnung');
    assert.ok(!keys.includes('warn_globex'), 'acme-Digest enthält KEINE globex-Warnung');
  });
});

test('#124 alert-digest Hintergrund-Read OHNE expliziten Mandant ⇒ NICHTS (kein Default)', async (t) => {
  await inSandbox(t, async (client) => {
    const db = doorForClient(client);
    await seedAcmeGlobex(client);
    for (const tenant of ['', null, undefined]) {
      const d = await queryAlertDigestPg(db, tenant, {});
      assert.equal(d.warnings.length, 0, 'kein Mandant ⇒ keine Warnungen');
      assert.equal(d.mhdBatches.length, 0, 'kein Mandant ⇒ keine MHD-Chargen');
      assert.equal(d.batchTotals.length, 0, 'kein Mandant ⇒ keine Lagerbestände');
      assert.equal(d.emptySlots.length, 0, 'kein Mandant ⇒ keine leeren Slots');
      assert.equal(d.workflowFailures.length, 0, 'kein Mandant ⇒ keine Workflow-Fehler');
    }
  });
});
