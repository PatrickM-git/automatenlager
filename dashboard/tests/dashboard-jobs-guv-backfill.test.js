'use strict';

/**
 * GuV-Backfill-Job (Issue #172) — wartbares, idempotentes Lücken-Füllen.
 * SPEC-Kontext: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
 *
 *  (1) Reiner Nayax-CSV-Reader (quoted, eingebettete Zeilenumbrüche) + Mapper.
 *  (2) LIVE durch die Tür unter RLS: füllt fehlende guv_daily-Posten aus dem
 *      Roh-Export, byte-genau wie der Nacht-Job (brutto + cost_basis), idempotent,
 *      dedup gegen vorhandene Keys, source='guv_backfill' (sichtbar).
 *  (3) Wiederkehrender Worker-Job createGuvBackfillJob: Factory (offline, Quelle
 *      injiziert) + LIVE über den echten tenant-runner durch die Tür unter RLS.
 *      Unfüllbares (noMap/noEK) als Telemetrie/Warnung statt Pflege-Tabelle.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const bf = require('../lib/jobs/guv-backfill.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { createTenantJobRunner } = require('../lib/jobs/tenant-runner.js');
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

    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
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
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
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

// ── (3) Worker-Job-Factory createGuvBackfillJob ──────────────────────────────

test('#172 createGuvBackfillJob: ohne tenantRunner ⇒ TypeError (fail-closed)', () => {
  assert.throws(() => bf.createGuvBackfillJob({}), /tenantRunner/);
});

test('#172 createGuvBackfillJob: Quelle EINMAL geholt, aggregiert über Mandanten (continueOnError); Unfüllbares als Telemetrie/Warnung', async () => {
  // Kanned per-Mandant-Ergebnisse (wie sie runGuvBackfillForTenant liefert), damit
  // die Factory OFFLINE prüfbar ist (kein pg, kein Netz) — der echte Tür-/RLS-Pfad
  // steht im LIVE-Test unten.
  const fakeRunner = {
    listTenants: () => ['acme', 'globex'],
    runForAll: async (jobFn, opts) => {
      assert.equal(typeof jobFn, 'function', 'Factory übergibt eine jobFn(db, tenant)');
      assert.equal(opts.continueOnError, true, 'ein fehlschlagender Mandant stoppt die anderen nicht');
      return {
        tenants: ['acme', 'globex'],
        perTenant: {
          acme: { tenant: 'acme', rawSales: 5, mapped: 3, noMap: 1, noEK: 1, inserted: 2, conflictSkipped: 1, attempted: 3,
            unresolved: { noMap: [{ name: 'Geist', mdb: '99', date: '2025-12-01' }], noEK: [{ product_key: 'p_y', date: '2025-12-02' }] } },
          globex: { tenant: 'globex', rawSales: 0, mapped: 0, noMap: 0, noEK: 0, inserted: 0, conflictSkipped: 0, attempted: 0,
            unresolved: { noMap: [], noEK: [] } },
        },
        skipped: [], errors: [],
      };
    },
  };
  let calls = 0;
  const warns = [];
  const job = bf.createGuvBackfillJob({
    tenantRunner: fakeRunner,
    fetchSource: async () => { calls++; return 'CSV'; },
    logger: (m) => warns.push(m),
  });
  assert.equal(job.key, 'wf-guv-backfill');

  const res = await job.run();
  assert.equal(calls, 1, 'die Quelle wird genau EINMAL geholt (über alle Mandanten geteilt)');
  assert.equal(res.tenants, 2);
  assert.equal(res.inserted, 2, '2 + 0 inserted aufsummiert');
  assert.equal(res.conflictSkipped, 1);
  assert.equal(res.noMap, 1);
  assert.equal(res.noEK, 1);
  // Unfüllbares gebündelt (nur acme), mit beschränkter Stichprobe.
  assert.equal(res.unfillable.length, 1, 'nur acme hat Unfüllbares');
  assert.equal(res.unfillable[0].tenant, 'acme');
  assert.equal(res.unfillable[0].noMap, 1);
  assert.equal(res.unfillable[0].noMapSamples[0].name, 'Geist');
  assert.equal(res.unfillable[0].noEKSamples[0].product_key, 'p_y');
  assert.ok(warns.some((m) => /unmappbare/.test(m)), 'Warnung geloggt (statt Pflege-Tabelle)');
  // Kompakte Telemetrie: die schweren unresolved-Arrays sind aus perTenant entfernt.
  assert.ok(!('unresolved' in res.perTenant.acme), 'unresolved nicht in der Lauf-Telemetrie');
  assert.equal(res.perTenant.acme.inserted, 2, 'Zähler bleiben in perTenant erhalten');
});

test('#172 createGuvBackfillJob: keine Mandanten ⇒ skip, Quelle NICHT geholt (fail-closed, schont das Sheet)', async () => {
  let calls = 0;
  const job = bf.createGuvBackfillJob({
    tenantRunner: { listTenants: () => [], runForAll: async () => { throw new Error('darf nicht laufen'); } },
    fetchSource: async () => { calls++; return 'CSV'; },
  });
  const res = await job.run();
  assert.equal(res.skipped, 'keine Mandanten in der Registry');
  assert.equal(res.inserted, 0);
  assert.equal(calls, 0, 'ohne Mandanten kein Sheet-Abruf');
});

test('#172 LIVE: createGuvBackfillJob füllt Lücken über den tenant-runner durch die Tür (RLS), idempotent + Unfüllbar-Telemetrie', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client); // Produkt 'Cola acme' (snack), EK 5
    await client.query(`DELETE FROM automatenlager.guv_daily WHERE tenant_id IN ('acme','globex')`);
    // KU-Konfig (camelCase, wie der reale __default__-Wert) ⇒ brutto wie der Nacht-Job.
    await client.query(
      `INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
         VALUES ('__default__', $1::jsonb, now())
       ON CONFLICT (mandant_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
      [JSON.stringify({ kleinunternehmerAktiv: true })]);

    for (const n of [22, 23, 24, 25, 26, 28]) await applyMigration(client, n); // RLS scharf + cost_basis
    await client.query('SET ROLE automatenlager_app');
    try {
      const db = createTenantDb({ pool: sandboxTxPool(client) });
      // Echter Per-Mandant-Runner über NUR acme (deterministisch) — fake Verzeichnis.
      const tenantRunner = createTenantJobRunner({ db, directory: { listTenantIds: () => ['acme'] } });

      // CSV: ein mappbarer Verkauf (Cola acme → p_acme, mdb 10) + ein unmappbarer (mdb 99).
      const JOB_CSV = [
        '"Standort-ID","Transaktions-ID","Zu begleichender Wert","Produktauswahl-Informationen","Produktcode in Karte","Maschinen-Begleichszeit"',
        '6,301,"2,0","Cola acme(10  2.00)",10,01.12.2025 09:37:09',
        '6,302,"1,0","Geisterprodukt(99  1.00)",99,03.12.2025 12:00:00',
      ].join('\n');
      const warns = [];
      const job = bf.createGuvBackfillJob({
        tenantRunner,
        fetchSource: async () => JOB_CSV,            // injizierte Quelle ⇒ kein Netz
        env: { GUV_BACKFILL_MACHINE_KEY: 'vm_acme' }, // Ziel-Automat des Fixtures
        logger: (m) => warns.push(m),
      });

      const res = await job.run();
      assert.equal(res.tenants, 1);
      assert.equal(res.inserted, 1, 'der mappbare Tag (2025-12-01) wird gefüllt');
      assert.equal(res.noMap, 1, 'der unmappbare Verkauf wird gemeldet, NICHT gebucht');
      assert.equal(res.unfillable.length, 1);
      assert.equal(res.unfillable[0].tenant, 'acme');
      assert.equal(res.unfillable[0].noMapSamples[0].mdb, '99');
      assert.ok(warns.some((m) => /unmappbare/.test(m)), 'Warnung geloggt (keine Pflege-Tabelle)');

      // Durch die Tür gegenlesen: gebuchte Zeile trägt source/cost_basis wie der Nacht-Job.
      const row = (await db.read({
        tenant: 'acme', tables: ['guv_daily'],
        text: `SELECT source, cost_basis, cost_of_goods, revenue_gross, revenue_net
                 FROM automatenlager.guv_daily WHERE tenant_id=$1 AND guv_key='2025-12-01|vm_acme|p_acme'`,
      })).rows[0];
      assert.ok(row, 'fehlender Posten gebucht');
      assert.equal(row.source, 'guv_backfill', 'sichtbare Quelle (nicht historic_backfill)');
      assert.equal(row.cost_basis, 'brutto', 'KU ⇒ brutto wie Nacht-Job');
      assert.equal(Number(row.cost_of_goods), 5.35, 'EK 5 × 1,07 (Kategorie-MwSt, byte-genau wie Nacht-Job)');
      assert.equal(Number(row.revenue_net), Number(row.revenue_gross), 'KU ⇒ revenue_net = revenue_gross');

      // Idempotenz: zweiter Lauf bucht nichts mehr (existingKeys-Skip + ON CONFLICT).
      const re = await job.run();
      assert.equal(re.inserted, 0, 'zweiter Lauf ist No-op (idempotent)');
    } finally { await client.query('RESET ROLE'); }
  });
});
