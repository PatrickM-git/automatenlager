'use strict';

// Issue #96 + #108 — Migration 0009 (tenant_id auf alle operativen Tabellen) +
// Migration 0032 (classification_settings.mandant_id → tenant_id). LIVE-Sandbox.

const assert = require('node:assert/strict');
const test = require('node:test');

const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { TENANT_REQUIRED_TABLES, tablesMissingTenantId } = require('../lib/db-schema.js');

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
    'prices', 'warnings', 'settings_thresholds', 'warehouses']) {
    assert.ok(TENANT_REQUIRED_TABLES.includes(t), `${t} ist Pflicht`);
  }
  // Ausnahmen sind NICHT in der Liste.
  assert.ok(!TENANT_REQUIRED_TABLES.includes('tenants'), 'tenants (PK=tenant_id) ausgenommen');
  assert.ok(!TENANT_REQUIRED_TABLES.includes('platform_admins'), 'platform_admins ausgenommen');
  // classification_settings ist JETZT in der Liste (Migration 0032 hat mandant_id→tenant_id umbenannt).
  assert.ok(TENANT_REQUIRED_TABLES.includes('classification_settings'),
    'classification_settings ist nach 0032 in der Pflicht-Liste (tenant_id vorhanden)');
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

test('#96 LIVE-Sandbox: nach 0009+0032 trägt jede Pflicht-Tabelle tenant_id TEXT NOT NULL', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await applyMigration(client, 8);
    await applyMigration(client, 9);
    await applyMigration(client, 32); // classification_settings: mandant_id → tenant_id (#108)

    for (const table of TENANT_REQUIRED_TABLES) {
      const meta = await tenantIdMeta(client, table);
      assert.ok(meta, `${table}.tenant_id existiert`);
      assert.equal(meta.typ, 'text', `${table}.tenant_id ist TEXT`);
      assert.equal(meta.notnull, true, `${table}.tenant_id ist NOT NULL`);
    }
  });
});

test('#108 LIVE-Sandbox: nach 0032 trägt classification_settings tenant_id (nicht mandant_id)', async (t) => {
  await inSandbox(t, async (client) => {
    await applyMigration(client, 7);
    await applyMigration(client, 8);
    await applyMigration(client, 9);
    await applyMigration(client, 32); // mandant_id → tenant_id

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='automatenlager' AND table_name='classification_settings'`);
    const names = cols.rows.map((r) => r.column_name);
    assert.ok(names.includes('tenant_id'), 'tenant_id vorhanden nach Migration 0032');
    assert.ok(!names.includes('mandant_id'), 'mandant_id wurde umbenannt (nicht mehr vorhanden)');

    // PK liegt jetzt auf tenant_id.
    const pk = await client.query(
      `SELECT a.attname FROM pg_constraint con
         JOIN pg_class c ON c.oid=con.conrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey)
        WHERE n.nspname='automatenlager' AND c.relname='classification_settings' AND con.contype='p'`);
    assert.equal(pk.rows[0].attname, 'tenant_id', 'PK ist jetzt tenant_id');
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
