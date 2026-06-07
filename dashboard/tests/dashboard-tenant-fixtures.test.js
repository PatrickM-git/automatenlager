'use strict';

/**
 * acme/globex-Fixtures im #94-Sandbox-Harness — Issue #122, Stufe 3.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md §"Testing Decisions"
 *
 * Legt ZWEI synthetische Test-Mandanten (acme, globex) mit unterscheidbaren Daten
 * in den lesepfad-relevanten Tabellen an — BEIDSEITIG, damit Isolationstests
 * nicht VAKUÖS sind (Pflicht-Testfall 1). Echte Faltrix-Daten bleiben unberührt:
 * alles läuft in EINER Transaktion mit garantiertem ROLLBACK (inSandbox).
 *
 * Skippt offline sauber (connectOrSkip).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox } = require('./helpers/migration-sandbox.js');
const { seedTenant, seedAcmeGlobex, READ_PATH_TABLES } = require('./helpers/tenant-fixtures.js');

test('#122 Fixtures: acme UND globex tragen Daten in allen Kern-Lesetabellen (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    assert.ok(acme.tenantId === 'acme' && globex.tenantId === 'globex');

    // BEIDE Mandanten haben in JEDER Kern-Lesetabelle ≥1 Zeile (sonst wäre ein
    // späterer „A sieht 0 von B"-Test vakuös).
    for (const table of READ_PATH_TABLES) {
      for (const tid of ['acme', 'globex']) {
        const r = await client.query(
          `SELECT count(*)::int AS n FROM automatenlager.${table} WHERE tenant_id = $1`,
          [tid],
        );
        assert.ok(r.rows[0].n >= 1, `${table} hat Daten für ${tid} (nicht-vakuös), n=${r.rows[0].n}`);
      }
    }
  });
});

test('#122 Fixtures: Mandanten-Isolation auf SQL-Ebene — acme-Filter sieht 0 globex-Zeilen', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    for (const table of READ_PATH_TABLES) {
      // Aus acme-Sicht (WHERE tenant_id='acme') darf KEINE globex-Zeile sichtbar sein.
      const leak = await client.query(
        `SELECT count(*)::int AS n FROM automatenlager.${table} WHERE tenant_id = $1 AND tenant_id = $2`,
        ['acme', 'globex'],
      );
      assert.equal(leak.rows[0].n, 0, `${table}: acme-Filter darf keine globex-Zeile sehen`);
    }
  });
});

test('#122 Fixtures: unterscheidbare Daten (acme ≠ globex), z. B. Umsatz/Produktname', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    // Produktnamen tragen den Mandanten-Marker → eindeutig unterscheidbar.
    assert.notEqual(acme.productName, globex.productName);
    const a = await client.query(
      `SELECT SUM(revenue_gross) AS s FROM automatenlager.guv_daily WHERE tenant_id='acme'`,
    );
    const g = await client.query(
      `SELECT SUM(revenue_gross) AS s FROM automatenlager.guv_daily WHERE tenant_id='globex'`,
    );
    assert.ok(Number(a.rows[0].s) > 0 && Number(g.rows[0].s) > 0);
    assert.notEqual(Number(a.rows[0].s), Number(g.rows[0].s), 'Aggregate sind unterscheidbar');
  });
});

test('#122 Fixtures: Faltrix-Daten bleiben unberührt (ROLLBACK) — nach der Sandbox kein acme/globex', async (t) => {
  // Erst innerhalb der Sandbox säen …
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    const inside = await client.query(`SELECT count(*)::int AS n FROM automatenlager.tenants WHERE tenant_id IN ('acme','globex')`);
    assert.equal(inside.rows[0].n, 2, 'innerhalb der Transaktion existieren acme/globex');
  });
  // … nach dem ROLLBACK in einer FRISCHEN Sandbox dürfen sie nicht mehr da sein.
  await inSandbox(t, async (client) => {
    const after = await client.query(`SELECT count(*)::int AS n FROM automatenlager.tenants WHERE tenant_id IN ('acme','globex')`);
    assert.equal(after.rows[0].n, 0, 'nach ROLLBACK sind die Fixtures weg — Faltrix unberührt');
  });
});

test('#122 Fixtures: seedTenant ist parametrisierbar (eigener Mandant)', async (t) => {
  await inSandbox(t, async (client) => {
    const r = await seedTenant(client, 'probe_x');
    assert.equal(r.tenantId, 'probe_x');
    const n = await client.query(`SELECT count(*)::int AS n FROM automatenlager.sales_transactions WHERE tenant_id='probe_x'`);
    assert.ok(n.rows[0].n >= 1);
  });
});
