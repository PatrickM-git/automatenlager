'use strict';

/**
 * RLS-Backstop Negativ-Matrix — Stufe 5, Slices 3a–3d + Abschluss (#146–#150).
 * SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md §"Testing Decisions"
 *
 * DER Beweis: verbindet REAL als die eingeengte App-Rolle (SET ROLE
 * automatenlager_app, kein BYPASSRLS) gegen die echte Mini-DB im #94-Sandbox-
 * Harness (ROLLBACK). Tests, die als Owner/Infra verbinden, bewiesen NICHTS
 * (sie umgehen RLS). Hier greift die DB-erzwungene Trennung.
 *
 * Negativ-Matrix:
 *   1. GUC=A liest NUR A (B unsichtbar) — pro Tabellengruppe, nicht-vakuös.
 *   2. Schreibversuch mit fremder tenant_id ⇒ WITH-CHECK-Abweisung.
 *   3. roher MatView-Zugriff als App-Rolle ⇒ permission denied.
 *   4. Security-View liefert nur eigenen Mandanten (Backstop unabhängig vom App-Filter).
 *   5. geteilte Config: eigener + __default__ sichtbar, fremder nie; __default__ nicht löschbar.
 *   6. unbekannter Mandant ⇒ leer (fail-closed, kein Leck).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { connectOrSkip, withRollback, applyMigration, expectReject, SANDBOX_LOCK_KEY } = require('./helpers/migration-sandbox.js');
const { seedAcmeGlobex } = require('./helpers/tenant-fixtures.js');

// Eine repräsentative Tabelle je RLS-Gruppe (alle tragen tenant_id, beide Mandanten haben Zeilen).
const GROUP_TABLES = [
  'products', 'locations', 'stock_batches',        // Kern (0023)
  'guv_daily', 'warnings',                          // Finanz (0024)
  'sales_transactions', 'nayax_devices',            // Inventory (0025)
  'settings_thresholds',                            // Config (0026)
];

async function applyAllRls(client) {
  for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
}
async function setTenant(client, tenant) {
  await client.query("SELECT set_config('automatenlager.current_tenant', $1, true)", [tenant]);
}
async function countWhereTenant(client, table, tenant) {
  const r = await client.query(`SELECT count(*)::int n FROM automatenlager.${table} WHERE tenant_id = $1`, [tenant]);
  return r.rows[0].n;
}

test('#146-149 Lese-Isolation pro Gruppe: GUC=A sieht NUR A, B unsichtbar (nicht-vakuös)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await seedAcmeGlobex(client);
      await applyAllRls(client);
      await client.query('SET ROLE automatenlager_app');
      // GUC = acme: jede Gruppentabelle zeigt acme-Zeilen, KEINE globex-Zeilen.
      await setTenant(client, 'acme');
      for (const tbl of GROUP_TABLES) {
        assert.ok(await countWhereTenant(client, tbl, 'acme') >= 1, `${tbl}: acme sieht eigene Zeilen`);
        assert.equal(await countWhereTenant(client, tbl, 'globex'), 0, `${tbl}: acme sieht KEINE globex-Zeilen (RLS)`);
      }
      // GUC = globex: spiegelbildlich.
      await setTenant(client, 'globex');
      for (const tbl of GROUP_TABLES) {
        assert.ok(await countWhereTenant(client, tbl, 'globex') >= 1, `${tbl}: globex sieht eigene Zeilen`);
        assert.equal(await countWhereTenant(client, tbl, 'acme'), 0, `${tbl}: globex sieht KEINE acme-Zeilen (RLS)`);
      }
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});

test('#146 WITH CHECK: Schreibversuch mit fremder tenant_id wird abgewiesen', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await seedAcmeGlobex(client);
      await applyAllRls(client);
      await client.query('SET ROLE automatenlager_app');
      await setTenant(client, 'acme');
      // UPDATE einer eigenen products-Zeile auf fremde tenant_id ⇒ WITH-CHECK-Verstoß.
      await expectReject(
        client,
        `UPDATE automatenlager.products SET tenant_id='globex' WHERE product_key='p_acme'`,
        /row-level security|policy/i,
        'Umschreiben auf fremde tenant_id muss die WITH-CHECK-Policy abweisen',
      );
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});

test('#149 rohe MatView verweigert, Security-View liefert nur eigenen Mandanten', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await seedAcmeGlobex(client);
      await applyAllRls(client);
      await client.query('SET ROLE automatenlager_app');
      await setTenant(client, 'acme');
      // a) Direktzugriff auf die rohe MatView ⇒ permission denied.
      await expectReject(client, 'SELECT 1 FROM automatenlager.mv_inventory_value_daily LIMIT 1',
        /permission denied/i, 'App-Rolle darf die rohe MatView nicht lesen');
      // b) Security-View ist lesbar und GUC-gefiltert (nur eigener Mandant; kein Fremdleck).
      const foreign = await client.query(
        `SELECT count(*)::int n FROM automatenlager.v_inventory_value_daily WHERE tenant_id <> 'acme'`);
      assert.equal(foreign.rows[0].n, 0, 'Security-View zeigt keine fremden Mandanten');
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});

test('#149 geteilte Config: eigener + __default__ sichtbar, fremder nie, __default__ nicht löschbar', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      // #124: Advisory-Lock VOR der DML auf classification_settings (serialisiert mit
      // parallelen Sandbox-Transaktionen, sonst DML-vs-DML-Deadlock). seedAcmeGlobex
      // nimmt ihn sonst; dieser Test seedet nicht und muss ihn selbst nehmen.
      await client.query('SELECT pg_advisory_xact_lock($1)', [SANDBOX_LOCK_KEY]);
      // sicherstellen, dass eine __default__- UND eine acme-Zeile existiert.
      await client.query(`INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
        VALUES ('__default__','{}'::jsonb, now()) ON CONFLICT (mandant_id) DO NOTHING`);
      await client.query(`INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
        VALUES ('acme','{}'::jsonb, now()) ON CONFLICT (mandant_id) DO NOTHING`);
      await client.query(`INSERT INTO automatenlager.classification_settings (mandant_id, config, updated_at)
        VALUES ('globex','{}'::jsonb, now()) ON CONFLICT (mandant_id) DO NOTHING`);
      await applyAllRls(client);
      await client.query('SET ROLE automatenlager_app');
      await setTenant(client, 'acme');
      // sichtbar: acme + __default__; NICHT globex.
      const vis = await client.query(`SELECT mandant_id FROM automatenlager.classification_settings ORDER BY 1`);
      const ids = vis.rows.map((r) => r.mandant_id);
      assert.ok(ids.includes('acme'), 'eigener Mandant sichtbar');
      assert.ok(ids.includes('__default__'), '__default__-Vorlage sichtbar');
      assert.ok(!ids.includes('globex'), 'fremder Mandant NIE sichtbar');
      // __default__ ist für die App schreibgeschützt: ein UPDATE trifft via USING
      // (mandant_id=eigener) die __default__-Zeile NICHT ⇒ 0 betroffene Zeilen.
      const upd = await client.query(`UPDATE automatenlager.classification_settings SET updated_at=now() WHERE mandant_id='__default__'`);
      assert.equal(upd.rowCount, 0, '__default__ kann von der App nicht geändert werden (USING schützt)');
      // Eigene Zeile IST änderbar (Gegenprobe: nicht-vakuös).
      const updOwn = await client.query(`UPDATE automatenlager.classification_settings SET updated_at=now() WHERE mandant_id='acme'`);
      assert.equal(updOwn.rowCount, 1, 'eigene Config-Zeile ist änderbar');
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});

test('#150 fail-closed: unbekannter Mandant ⇒ leer (kein Fremdleck)', async (t) => {
  const client = await connectOrSkip(t); if (!client) return;
  try {
    await withRollback(client, async () => {
      await seedAcmeGlobex(client);
      await applyAllRls(client);
      await client.query('SET ROLE automatenlager_app');
      await setTenant(client, 'zzz_kein_mandant');
      for (const tbl of GROUP_TABLES) {
        const r = await client.query(`SELECT count(*)::int n FROM automatenlager.${tbl}`);
        assert.equal(r.rows[0].n, 0, `${tbl}: unbekannter Mandant sieht NICHTS`);
      }
      await client.query('RESET ROLE');
    });
  } finally { await client.end(); }
});
