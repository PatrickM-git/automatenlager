'use strict';

// Issue #96 — Migration 0009 (tenant_id auf alle operativen Tabellen + Index +
// classification_settings.mandant_id -> tenant_id). LIVE-Sandbox mit ROLLBACK.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { TENANT_REQUIRED_TABLES, tablesMissingTenantId } = require('../lib/db-schema.js');
const { tenantColumn } = require('../lib/category-config.js');

// ── DB-freier Contract-Guard-Test (reine Funktion) ────────────────────────────

test('#96 tablesMissingTenantId: meldet Pflicht-Tabelle ohne tenant_id, ignoriert fehlende', () => {
  const cols = {
    machines: ['machine_id', 'tenant_id'],
    products: ['product_id'],          // existiert, aber OHNE tenant_id -> Verstoß
    // suppliers fehlt ganz -> wird separat als missingRelation gemeldet, hier ignoriert
  };
  const missing = tablesMissingTenantId(cols);
  assert.ok(missing.includes('products'), 'products ohne tenant_id wird gemeldet');
  assert.ok(!missing.includes('machines'), 'machines mit tenant_id ist sauber');
  assert.ok(!missing.includes('suppliers'), 'gar nicht existierende Tabelle wird hier nicht gemeldet');
});

test('#96 TENANT_REQUIRED_TABLES enthält die operativen Pflicht-Tabellen inkl. stock_movements', () => {
  for (const t of ['machines', 'products', 'sales_transactions', 'stock_batches', 'stock_movements',
    'prices', 'warnings', 'classification_settings', 'settings_thresholds', 'warehouses']) {
    assert.ok(TENANT_REQUIRED_TABLES.includes(t), `${t} ist Pflicht`);
  }
  // Ausnahmen sind NICHT in der Liste.
  assert.ok(!TENANT_REQUIRED_TABLES.includes('tenants'), 'tenants (PK=tenant_id) ausgenommen');
  assert.ok(!TENANT_REQUIRED_TABLES.includes('platform_admins'), 'platform_admins ausgenommen');
});

// ── LIVE-Sandbox: Migration anwenden, Vollständigkeit prüfen ──────────────────

async function tenantIdMeta(client, table) {
  const r = await client.query(
    `SELECT a.attnotnull AS notnull, format_type(a.atttypid, a.atttypmod) AS typ
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
      WHERE n.nspname='automatenlager' AND c.relname=$1`, [table]);
  return r.rows[0] || null;
}

test('#96 LIVE-Sandbox: nach 0009 trägt jede Pflicht-Tabelle tenant_id TEXT NOT NULL', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await applyMigration(client, 8);
    await applyMigration(client, 9);

    for (const table of TENANT_REQUIRED_TABLES) {
      const meta = await tenantIdMeta(client, table);
      assert.ok(meta, `${table}.tenant_id existiert`);
      assert.equal(meta.typ, 'text', `${table}.tenant_id ist TEXT`);
      assert.equal(meta.notnull, true, `${table}.tenant_id ist NOT NULL`);
    }
  });
});

test('#96 LIVE-Sandbox: classification_settings.mandant_id ist zu tenant_id angeglichen', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await applyMigration(client, 8);
    await applyMigration(client, 9);

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='automatenlager' AND table_name='classification_settings'`);
    const names = cols.rows.map((r) => r.column_name);
    assert.ok(names.includes('tenant_id'), 'tenant_id existiert');
    assert.ok(!names.includes('mandant_id'), 'mandant_id ist weg (umbenannt)');

    // Übergangsbrücke erkennt jetzt tenant_id.
    assert.equal(await tenantColumn(client), 'tenant_id', 'tenantColumn() liefert tenant_id nach 0009');

    // PK bleibt erhalten (jetzt auf tenant_id).
    const pk = await client.query(
      `SELECT a.attname FROM pg_constraint con
         JOIN pg_class c ON c.oid=con.conrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey)
        WHERE n.nspname='automatenlager' AND c.relname='classification_settings' AND con.contype='p'`);
    assert.equal(pk.rows[0].attname, 'tenant_id', 'PK steht jetzt auf tenant_id');
  });
});

test('#96 LIVE-Sandbox: ein tenant_id-Index je Pflicht-Tabelle (Stichprobe)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await applyMigration(client, 8);
    await applyMigration(client, 9);
    for (const table of ['machines', 'sales_transactions', 'stock_batches', 'prices', 'stock_movements']) {
      const r = await client.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname='automatenlager' AND tablename=$1
            AND indexname=$2`, [table, `idx_${table}_tenant`]);
      assert.equal(r.rowCount, 1, `idx_${table}_tenant existiert`);
    }
  });
});

test('#96 LIVE-Sandbox: Migration ist idempotent (zweiter Lauf bricht nicht)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await applyMigration(client, 8);
    await applyMigration(client, 9);
    await applyMigration(client, 9); // erneut
    const meta = await tenantIdMeta(client, 'products');
    assert.ok(meta && meta.notnull, 'products.tenant_id weiterhin NOT NULL nach 2. Lauf');
  });
});
