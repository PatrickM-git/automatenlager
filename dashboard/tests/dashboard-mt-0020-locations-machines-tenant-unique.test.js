'use strict';

/**
 * Migration 0020 — locations + machines mandantengetrennte Uniques (Stufe 4, #132).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"DDL-Migration (Slice 1)"
 *
 * DDL VOR Code: ersetzt für locations/machines (+ machine_profiles) die GLOBALE
 * (key)-Unique durch UNIQUE NULLS NOT DISTINCT (tenant_id, key). Damit kann ein
 * Mandant beim Upsert NIE die Zeile eines anderen überschreiben, und gleicher
 * Schlüssel bei zwei Mandanten = ZWEI Zeilen (kein roher Kollisionsfehler).
 *
 * Gegen die ECHTE (bereits 0007–0019 migrierte) Mini-DB im #94-Sandbox-Harness,
 * in einer Rollback-Transaktion; offline sauberes Skippen.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { connectOrSkip, withRollback, applyMigration, readMigration } = require('./helpers/migration-sandbox.js');

// Constraint-Definitionen einer Tabelle (UNIQUE/PK) als Map name→def.
async function uniqueConstraints(client, table) {
  const r = await client.query(
    `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'automatenlager' AND rel.relname = $1 AND con.contype IN ('u','p')`,
    [table],
  );
  const map = new Map();
  for (const row of r.rows) map.set(row.conname, row.def);
  return map;
}

async function columnNotNull(client, table, column) {
  const r = await client.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='automatenlager' AND table_name=$1 AND column_name=$2`, [table, column]);
  return r.rows.length > 0 && r.rows[0].is_nullable === 'NO';
}

test('#132 Migration 0020: idempotent (zweimal anwenden ohne Fehler)', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    await withRollback(client, async () => {
      await assert.doesNotReject(() => applyMigration(client, 20), 'erste Anwendung ok');
      await assert.doesNotReject(() => applyMigration(client, 20), 'zweite Anwendung ok (idempotent)');
    });
  } finally {
    await client.end();
  }
});

test('#132 Migration 0020: globale (key)-Uniques weg, (tenant_id, key) NULLS NOT DISTINCT da', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 20);

      const loc = await uniqueConstraints(client, 'locations');
      assert.ok(![...loc.values()].some((d) => d === 'UNIQUE (location_key)'),
        'globale UNIQUE (location_key) ist gedroppt');
      assert.ok([...loc.values()].some((d) => /UNIQUE NULLS NOT DISTINCT \(tenant_id, location_key\)/.test(d)),
        'neue UNIQUE NULLS NOT DISTINCT (tenant_id, location_key) existiert');

      const mch = await uniqueConstraints(client, 'machines');
      assert.ok(![...mch.values()].some((d) => d === 'UNIQUE (machine_key)'),
        'globale UNIQUE (machine_key) ist gedroppt');
      assert.ok([...mch.values()].some((d) => /UNIQUE NULLS NOT DISTINCT \(tenant_id, machine_key\)/.test(d)),
        'neue UNIQUE NULLS NOT DISTINCT (tenant_id, machine_key) existiert');

      const mp = await uniqueConstraints(client, 'machine_profiles');
      assert.ok(![...mp.values()].some((d) => d === 'UNIQUE (machine_id)'),
        'globale UNIQUE (machine_id) auf machine_profiles ist gedroppt');
      assert.ok([...mp.values()].some((d) => /UNIQUE NULLS NOT DISTINCT \(tenant_id, machine_id\)/.test(d)),
        'neue UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id) existiert');
    });
  } finally {
    await client.end();
  }
});

test('#132 Migration 0020: tenant_id ist NOT NULL auf locations/machines/machine_profiles', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 20);
      for (const table of ['locations', 'machines', 'machine_profiles']) {
        assert.equal(await columnNotNull(client, table, 'tenant_id'), true, `${table}.tenant_id NOT NULL`);
      }
    });
  } finally {
    await client.end();
  }
});

test('#132 Migration 0020: Upsert ON CONFLICT (tenant_id, location_key) — gleicher Key, zwei Mandanten = zwei Zeilen', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 20);
      await client.query(`INSERT INTO automatenlager.tenants (tenant_id, name) VALUES ('acme','A'),('globex','G') ON CONFLICT (tenant_id) DO NOTHING`);

      const upsert = (tid) => client.query(
        `INSERT INTO automatenlager.locations (location_key, name, location_type, tenant_id)
           VALUES ('shared_loc', $2, 'automat', $1)
         ON CONFLICT (tenant_id, location_key) DO UPDATE SET name = EXCLUDED.name`,
        [tid, `Standort ${tid}`]);

      // Kein 42P10 ("no unique constraint matching ON CONFLICT") und kein Cross-Tenant-Überschreiben.
      await assert.doesNotReject(() => upsert('acme'));
      await assert.doesNotReject(() => upsert('globex'));
      const rows = await client.query(
        `SELECT tenant_id, name FROM automatenlager.locations WHERE location_key = 'shared_loc' ORDER BY tenant_id`);
      assert.equal(rows.rows.length, 2, 'gleicher location_key bei zwei Mandanten = ZWEI getrennte Zeilen');
      assert.equal(rows.rows[0].name, 'Standort acme', 'acme-Zeile unangetastet von globex-Upsert');
      assert.equal(rows.rows[1].name, 'Standort globex');
    });
  } finally {
    await client.end();
  }
});

test('#132 Migration 0020: Upsert ON CONFLICT (tenant_id, machine_key) funktioniert (kein 42P10)', async (t) => {
  const client = await connectOrSkip(t);
  if (!client) return;
  try {
    await withRollback(client, async () => {
      await applyMigration(client, 20);
      await client.query(`INSERT INTO automatenlager.tenants (tenant_id, name) VALUES ('acme','A'),('globex','G') ON CONFLICT (tenant_id) DO NOTHING`);
      const loc = await client.query(
        `INSERT INTO automatenlager.locations (location_key, name, location_type, tenant_id)
           VALUES ('l_acme','LA','automat','acme') RETURNING location_id`);
      const locId = loc.rows[0].location_id;
      const upsert = (tid, lid) => client.query(
        `INSERT INTO automatenlager.machines (machine_key, name, location_id, tenant_id)
           VALUES ('shared_vm', $2, $3, $1)
         ON CONFLICT (tenant_id, machine_key) DO UPDATE SET name = EXCLUDED.name`,
        [tid, `Automat ${tid}`, lid]);
      await assert.doesNotReject(() => upsert('acme', locId));
      const locG = await client.query(
        `INSERT INTO automatenlager.locations (location_key, name, location_type, tenant_id)
           VALUES ('l_globex','LG','automat','globex') RETURNING location_id`);
      await assert.doesNotReject(() => upsert('globex', locG.rows[0].location_id));
      const rows = await client.query(
        `SELECT count(*)::int AS n FROM automatenlager.machines WHERE machine_key = 'shared_vm'`);
      assert.equal(rows.rows[0].n, 2, 'gleicher machine_key bei zwei Mandanten = zwei Zeilen');
    });
  } finally {
    await client.end();
  }
});
