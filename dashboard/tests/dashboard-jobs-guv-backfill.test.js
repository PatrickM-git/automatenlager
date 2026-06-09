'use strict';

/**
 * GuV-Backfill-Job (Issue #172) — wartbares, idempotentes Lücken-Füllen.
 * SPEC-Kontext: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
 *
 *  (1) Reiner Nayax-CSV-Reader (quoted, eingebettete Zeilenumbrüche) + Mapper.
 *  (2) LIVE durch die Tür unter RLS: füllt fehlende guv_daily-Posten aus dem
 *      Roh-Export, byte-genau wie der Nacht-Job (brutto + cost_basis), idempotent,
 *      dedup gegen vorhandene Keys, source='guv_backfill' (sichtbar).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const bf = require('../lib/jobs/guv-backfill.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// Nayax-Roh-Export-Fixture (Header + 2 Records; einer mit eingebettetem Zeilenumbruch
// in der Produktauswahl wie im echten Export).
const NAYAX_CSV = [
  '"Standort-ID","Transaktions-ID","Zu begleichender Wert","Produktauswahl-Informationen","Produktcode in Karte","Maschinen-Begleichszeit"',
  '6,111,"2,0","Cola acme(10  2.00)\n",10,01.12.2025 09:37:09',
  '6,112,"2,0","Cola acme(10  2.00)",10,02.12.2025 12:54:45',
].join('\n');

test('#172 parseNayaxExportCsv: parst Records inkl. quoted Zeilenumbruch + DE-Datum', () => {
  const sales = bf.parseNayaxExportCsv(NAYAX_CSV, { machineKey: 'vm_acme' });
  assert.equal(sales.length, 2);
  assert.deepEqual(sales[0], { date: '2025-12-01', machineKey: 'vm_acme', name: 'Cola acme', mdb: '10', gross: 2 });
  assert.equal(sales[1].date, '2025-12-02');
});

test('#172 parseGermanDate: DD.MM.YYYY → YYYY-MM-DD', () => {
  assert.equal(bf.parseGermanDate('19.12.2025 09:37:09'), '2025-12-19');
  assert.equal(bf.parseGermanDate('keine'), '');
});

test('#172 buildComputeInputs: mappt via Alias/MDB + EK; meldet noMap/noEK', () => {
  const rawSales = [
    { date: '2025-12-01', machineKey: 'vm', name: 'Cola', mdb: '10', gross: 2 },
    { date: '2025-12-02', machineKey: 'vm', name: 'Unbekannt', mdb: '99', gross: 1 }, // noMap
    { date: '2025-12-03', machineKey: 'vm', name: 'Wasser', mdb: '11', gross: 1 },     // noEK
  ];
  const aliasMap = new Map([['cola', 'p_cola'], ['wasser', 'p_wasser']]);
  const mdbMap = new Map([['10', 'p_cola'], ['11', 'p_wasser']]);
  const ekMap = new Map([['p_cola', { unitCostNet: 1, vatRatePct: 7 }]]); // p_wasser fehlt ⇒ noEK
  const categoryMap = new Map([['p_cola', 'snack']]);
  const out = bf.buildComputeInputs(rawSales, { aliasMap, mdbMap, ekMap, categoryMap });
  assert.equal(out.transactions.length, 1, 'nur p_cola auflösbar');
  assert.equal(out.transactions[0].product_key, 'p_cola');
  assert.equal(out.batches.length, 1);
  assert.equal(out.unresolved.noMap.length, 1);
  assert.equal(out.unresolved.noEK.length, 1);
});

// ── LIVE durch die Tür unter RLS ─────────────────────────────────────────────

test('#172 LIVE: Backfill füllt fehlende Posten (brutto, cost_basis, source guv_backfill), idempotent + dedup', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await client.query(`DELETE FROM automatenlager.guv_daily WHERE tenant_id IN ('acme','globex')`);
    await applyMigration(client, 28);

    // Einen der beiden CSV-Tage bereits abgedeckt (Dedup-Beweis): 2025-12-02 | p_acme.
    await client.query(
      `INSERT INTO automatenlager.guv_daily
         (tenant_id, guv_key, posting_date, machine_id, product_id, quantity_sold,
          revenue_gross, revenue_net, cost_of_goods, gross_profit, source, cost_basis)
       VALUES ('acme','2025-12-02|vm_acme|p_acme','2025-12-02',$1,$2,1,2,2,0.5,1.5,'guv_backfill','netto')`,
      [acme.machineId, acme.productId]);

    await client.query(
      `INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (mandant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: true })]);

    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });

      const res = await bf.runGuvBackfillForTenant(db, 'acme', { csvText: NAYAX_CSV, machineKey: 'vm_acme' });
      assert.equal(res.mapped, 2, 'beide CSV-Verkäufe gemappt (Cola acme → p_acme)');
      assert.equal(res.noMap, 0);
      assert.equal(res.noEK, 0);
      assert.equal(res.inserted, 1, 'nur der fehlende Tag (2025-12-01) wird gebucht — 2025-12-02 ist dedupt');

      const row = (await db.read({
        tenant: 'acme', tables: ['guv_daily'],
        text: `SELECT cost_of_goods, revenue_net, revenue_gross, cost_basis, source
                 FROM automatenlager.guv_daily WHERE tenant_id=$1 AND guv_key='2025-12-01|vm_acme|p_acme'`,
      })).rows[0];
      assert.ok(row, 'fehlender Posten gebucht');
      assert.equal(row.source, 'guv_backfill', 'sichtbare Quelle (nicht historic_backfill)');
      assert.equal(row.cost_basis, 'brutto', 'KU ⇒ brutto wie Nacht-Job');
      assert.equal(Number(row.revenue_net), Number(row.revenue_gross), 'KU ⇒ revenue_net = revenue_gross');
      // Snack 7 %: qty1 × ekNetto5 × 1,07 = 5,35.
      assert.equal(Number(row.cost_of_goods), 5.35, 'EK 5 × 1,07 (Kategorie-MwSt, byte-genau wie Nacht-Job)');

      // Idempotenz: zweiter Lauf bucht nichts mehr.
      const re = await bf.runGuvBackfillForTenant(db, 'acme', { csvText: NAYAX_CSV, machineKey: 'vm_acme' });
      assert.equal(re.inserted, 0, 'zweiter Lauf ist No-op (idempotent)');
    } finally { await client.query('RESET ROLE'); }
  });
});

test('#172 LIVE: dryRun rechnet, schreibt NICHT', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await client.query(`DELETE FROM automatenlager.guv_daily WHERE tenant_id IN ('acme','globex')`);
    await applyMigration(client, 28);
    await client.query(
      `INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (mandant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: true })]);
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      const res = await bf.runGuvBackfillForTenant(db, 'acme', { csvText: NAYAX_CSV, machineKey: 'vm_acme', dryRun: true });
      assert.equal(res.dryRun, true);
      assert.ok(res.rows.length >= 1, 'Vorschau-Zeilen berechnet');
      const n = (await db.read({ tenant: 'acme', tables: ['guv_daily'], text: `SELECT count(*)::int n FROM automatenlager.guv_daily WHERE tenant_id=$1 AND source='guv_backfill'` })).rows[0].n;
      assert.equal(n, 0, 'dryRun schreibt nichts');
    } finally { await client.query('RESET ROLE'); }
  });
});
