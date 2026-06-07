'use strict';

/**
 * Mandanten-Tür (lib/tenant-db.js) — Issue #122 (Stufe 3) · #144 (Stufe 5 RLS-GUC).
 * SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md
 *
 * Verhaltens-Tests über die öffentliche Schnittstelle (kein echtes DB nötig — der
 * DB-Zugriff wird als injizierte query/Pool-Attrappe gemockt, das ist die System-
 * grenze). Geprüft wird der VERTRAG der Tür, nicht ihre Interna:
 *   - fail-closed: kein/leerer Mandant ⇒ read leer (KEINE Transaktion), write/tx werfen
 *   - kein Default-Fallback (nie t_faltrix/__default__ als Ersatz)
 *   - technischer Fehler ≠ leer (propagiert, ROLLBACK)
 *   - Vertrag: explizite Zieltabelle(n) + Mandant; Mandant als $1-Parameter
 *   - Stufe-5-RLS-GUC GEZÜNDET: managed read() öffnet BEGIN READ ONLY + parametri-
 *     siertes set_config; read()/write() ohne Pool und ohne ambient ⇒ wirft
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb, isValidTenant, SET_TENANT_SQL } = require('../lib/tenant-db.js');

// Client-Spion: zeichnet jede Query auf. Steuer-Statements (BEGIN/COMMIT/ROLLBACK/
// set_config) liefern OK; die eigentliche Daten-Query liefert das impl-Resultat.
function makeClientSpy(impl) {
  const calls = [];
  let released = 0;
  const isControl = (sql) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql) || sql === SET_TENANT_SQL;
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (isControl(String(sql))) return { rows: [], rowCount: 0 };
      if (typeof impl === 'function') return impl(sql, params);
      return { rows: [{ ok: true }], rowCount: 1 };
    },
    release: () => { released++; },
  };
  return { client, calls, released: () => released };
}

// MANAGED-Pool-Attrappe (Produktionsmodus): connect() liefert den Spion-Client.
function makeManagedPool(impl) {
  const spy = makeClientSpy(impl);
  const pool = {
    connect: async () => spy.client,
    query: (sql, params) => spy.client.query(sql, params),
  };
  return { pool, calls: spy.calls, released: spy.released };
}

// Hilfen zum Auslesen der aufgezeichneten Steuer-/Datenqueries.
const sqlOf = (c) => String(c.sql).trim().toUpperCase();
const dataCalls = (calls) =>
  calls.filter((c) => !/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(String(c.sql).trim()) && c.sql !== SET_TENANT_SQL);

test('#144 managed read: BEGIN READ ONLY → set_config($1) → Query($1) → COMMIT, Client freigegeben', async () => {
  const { pool, calls, released } = makeManagedPool();
  const db = createTenantDb({ pool });
  await db.read({
    tenant: 'acme',
    tables: ['guv_daily'],
    text: 'SELECT * FROM automatenlager.guv_daily WHERE tenant_id = $1 AND posting_date >= $2',
    params: ['2026-01-01'],
  });
  const seq = calls.map((c) => c.sql);
  assert.equal(sqlOf(calls[0]), 'BEGIN READ ONLY', 'erste Anweisung = BEGIN READ ONLY');
  assert.equal(calls[1].sql, SET_TENANT_SQL, 'zweite Anweisung = parametrisiertes set_config');
  assert.deepEqual(calls[1].params, ['acme'], 'GUC-Mandant als $1-Bind (keine String-Interpolation)');
  assert.deepEqual(calls[2].params, ['acme', '2026-01-01'], 'Daten-Query: Mandant als $1, eigene Parameter ab $2');
  assert.equal(sqlOf(calls[calls.length - 1]), 'COMMIT', 'letzte Anweisung = COMMIT');
  assert.equal(released(), 1, 'Client wird freigegeben');
});

test('#144 GUC niemals string-interpoliert (kein SET LOCAL <wert>) — nur set_config-Bind', async () => {
  const { pool, calls } = makeManagedPool();
  const db = createTenantDb({ pool });
  await db.read({ tenant: 'acme', tables: ['products'], text: 'SELECT 1' });
  const issued = calls.map((c) => sqlOf(c));
  assert.ok(!issued.some((s) => s.includes('SET LOCAL')), 'kein SET LOCAL (Injection-Korridor vermeiden)');
  assert.ok(issued.some((s) => s.includes('SET_CONFIG')), 'GUC via set_config()');
  // Der Mandant darf NUR als Bind-Parameter erscheinen, nie im SQL-Text.
  assert.ok(!calls.some((c) => String(c.sql).includes('acme')), 'Mandanten-Wert nie im SQL-Text');
});

test('#144 read ohne Mandant ⇒ leeres Resultat, KEINE Transaktion/Query (fail-closed)', async () => {
  for (const tenant of [undefined, null, '', '   ']) {
    const { pool, calls } = makeManagedPool();
    const db = createTenantDb({ pool });
    const res = await db.read({ tenant, tables: ['guv_daily'], text: 'SELECT 1' });
    assert.equal(calls.length, 0, `kein Mandant (${JSON.stringify(tenant)}) ⇒ kein connect/BEGIN/Query`);
    assert.deepEqual(res.rows, []);
    assert.equal(res.rowCount, 0);
  }
});

test('#144 kein Default-Fallback — leerer Mandant liefert nie fremde/Default-Daten', async () => {
  const { pool, calls } = makeManagedPool(() => ({ rows: [{ tenant_id: 't_faltrix' }], rowCount: 1 }));
  const db = createTenantDb({ pool });
  const res = await db.read({ tenant: '', tables: ['guv_daily'], text: 'SELECT * FROM automatenlager.guv_daily' });
  assert.deepEqual(res.rows, [], 'kein __default__/t_faltrix-Fallback');
  assert.equal(calls.length, 0);
});

test('#144 technischer Fehler propagiert (≠ leer) + ROLLBACK + Client-Freigabe', async () => {
  const boom = new Error('connection terminated');
  const { pool, calls, released } = makeManagedPool(() => { throw boom; });
  const db = createTenantDb({ pool });
  await assert.rejects(
    () => db.read({ tenant: 'acme', tables: ['guv_daily'], text: 'SELECT 1' }),
    /connection terminated/,
  );
  assert.ok(calls.some((c) => sqlOf(c) === 'ROLLBACK'), 'ROLLBACK nach Fehler');
  assert.equal(released(), 1, 'Client auch im Fehlerfall freigegeben');
});

test('#144 explizite Zieltabelle(n) Pflicht — fehlend ⇒ Programmierfehler (wirft)', async () => {
  const { pool } = makeManagedPool();
  const db = createTenantDb({ pool });
  await assert.rejects(() => db.read({ tenant: 'acme', text: 'SELECT 1' }), /Zieltabelle/);
  await assert.rejects(() => db.read({ tenant: 'acme', tables: [], text: 'SELECT 1' }), /Zieltabelle/);
});

test('#144 SQL-Text Pflicht', async () => {
  const { pool } = makeManagedPool();
  const db = createTenantDb({ pool });
  await assert.rejects(() => db.read({ tenant: 'acme', tables: ['guv_daily'] }), /SQL/);
});

test('#144 read()/write() OHNE Pool und OHNE ambient ⇒ wirft (kein stiller RLS-Bypass)', async () => {
  const db = createTenantDb({ query: async () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(() => db.read({ tenant: 'acme', tables: ['products'], text: 'SELECT 1' }), /Pool|ambient/i);
  await assert.rejects(() => db.write({ tenant: 'acme', tables: ['products'], text: 'UPDATE x' }), /Pool|ambient/i);
});

test('#144 ambient-Modus: set_config + Query auf demselben Client, KEIN eigenes BEGIN/COMMIT', async () => {
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; };
  const db = createTenantDb({ query, ambient: true });
  await db.read({ tenant: 'acme', tables: ['products'], text: 'SELECT * FROM automatenlager.products WHERE tenant_id = $1' });
  assert.equal(calls[0].sql, SET_TENANT_SQL, 'zuerst set_config (GUC)');
  assert.deepEqual(calls[0].params, ['acme']);
  assert.deepEqual(calls[1].params, ['acme'], 'dann die Daten-Query mit Mandant $1');
  assert.ok(!calls.some((c) => /^\s*(BEGIN|COMMIT)\b/i.test(String(c.sql))), 'kein eigenes BEGIN/COMMIT (Aufrufer-Transaktion)');
});

test('#144 managed write: BEGIN (nicht READ ONLY) → set_config → Write → COMMIT', async () => {
  const { pool, calls } = makeManagedPool();
  const db = createTenantDb({ pool });
  await db.write({ tenant: 'acme', tables: ['settings_thresholds'], text: 'UPDATE automatenlager.settings_thresholds SET value=$2 WHERE tenant_id=$1', params: ['{}'] });
  assert.equal(sqlOf(calls[0]), 'BEGIN', 'write nutzt BEGIN (read-write)');
  assert.equal(calls[1].sql, SET_TENANT_SQL);
  assert.deepEqual(calls[1].params, ['acme']);
  assert.equal(sqlOf(calls[calls.length - 1]), 'COMMIT');
});

test('#144 write ohne Mandant ⇒ FEHLER (fail-closed-werfend)', async () => {
  const { pool, calls } = makeManagedPool();
  const db = createTenantDb({ pool });
  await assert.rejects(() => db.write({ tenant: '', tables: ['products'], text: 'UPDATE x' }), /kein Mandant/);
  assert.equal(calls.length, 0, 'keine Transaktion ohne Mandant');
});

test('#144 tx(): BEGIN → set_config(GUC) → fn(boundDoor) → COMMIT', async () => {
  const { pool, calls } = makeManagedPool();
  const db = createTenantDb({ pool });
  const out = await db.tx('acme', async (door) => {
    await door.read({ tables: ['locations'], text: 'SELECT * FROM automatenlager.locations WHERE tenant_id=$1' });
    await door.write({ tables: ['machines'], text: 'INSERT INTO automatenlager.machines ...' });
    return 'done';
  });
  assert.equal(out, 'done');
  assert.equal(sqlOf(calls[0]), 'BEGIN');
  assert.equal(calls[1].sql, SET_TENANT_SQL, 'GUC einmal nach BEGIN');
  assert.deepEqual(calls[1].params, ['acme']);
  assert.equal(sqlOf(calls[calls.length - 1]), 'COMMIT');
  // boundDoor read/write tragen den Mandanten als $1 (GUC schon gesetzt → kein erneutes set_config)
  const guc = calls.filter((c) => c.sql === SET_TENANT_SQL);
  assert.equal(guc.length, 1, 'GUC genau einmal pro Transaktion');
});

test('#144 tx() ohne Mandant ⇒ wirft', async () => {
  const { pool } = makeManagedPool();
  const db = createTenantDb({ pool });
  await assert.rejects(() => db.tx('', async () => {}), /kein Mandant/);
});

test('#144 forTenant/forViewer: bindet Mandant; leerer/Gast-Mandant ⇒ read leer', async () => {
  const { pool, calls } = makeManagedPool();
  const db = createTenantDb({ pool });
  await db.forTenant('acme').read({ tables: ['products'], text: 'SELECT * FROM automatenlager.products WHERE tenant_id=$1' });
  assert.deepEqual(dataCalls(calls)[0].params, ['acme']);

  const guest = await db.forViewer({ tenantId: null }).read({ tables: ['products'], text: 'SELECT 1' });
  assert.deepEqual(guest.rows, [], 'Gast ohne Mandant ⇒ leer');
});

test('#150 Break-Glass (Support-Sitzung) ist read-only an der Tür: write/tx werfen, read liest Ziel', async () => {
  const { pool, calls } = makeManagedPool();
  const db = createTenantDb({ pool });
  const support = db.forViewer({ tenantId: 'acme', supportSession: { active: true } });
  // read funktioniert (liest den Ziel-Mandanten der Break-Glass-Sitzung)
  await support.read({ tables: ['guv_daily'], text: 'SELECT 1' });
  assert.ok(calls.some((c) => c.sql === SET_TENANT_SQL && c.params[0] === 'acme'), 'GUC auf Ziel-Mandant');
  // write/tx sind verboten (read-only, auch an der Tür erzwungen)
  await assert.rejects(() => support.write({ tables: ['guv_daily'], text: 'UPDATE x' }), /read-only|Break-Glass/i);
  await assert.rejects(() => support.tx(async () => {}), /read-only|Break-Glass/i);
});

test('#144 weder query noch pool ⇒ Konstruktionsfehler', () => {
  assert.throws(() => createTenantDb({}), /query|pool/i);
});

test('#122 isValidTenant: nur nicht-leere Strings', () => {
  assert.equal(isValidTenant('acme'), true);
  assert.equal(isValidTenant(''), false);
  assert.equal(isValidTenant('   '), false);
  assert.equal(isValidTenant(null), false);
  assert.equal(isValidTenant(undefined), false);
  assert.equal(isValidTenant(123), false);
});
