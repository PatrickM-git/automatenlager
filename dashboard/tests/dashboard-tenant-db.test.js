'use strict';

/**
 * Mandanten-Tür (lib/tenant-db.js) — Issue #122, Stufe 3.
 * SPEC: docs/specs/multi-tenant-query-filter-stufe-3-v1.md
 *
 * Verhaltens-Tests über die öffentliche Schnittstelle (kein DB nötig — der
 * DB-Zugriff wird als injizierte query-Funktion gemockt, das ist die Systemgrenze).
 * Geprüft wird der VERTRAG der Tür, nicht ihre Interna:
 *   - fail-closed: kein/leerer/null Mandant ⇒ leeres Resultat, KEINE Abfrage
 *   - kein Default-Fallback (nie t_faltrix/__default__ als Ersatz)
 *   - technischer Fehler ≠ leer (propagiert)
 *   - Vertrag: explizite Zieltabelle(n) + Mandant; Mandant als $1-Parameter
 *   - Stufe-5-Haken inert (kein SET LOCAL / kein BEGIN in Stufe 3)
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb, isValidTenant } = require('../lib/tenant-db.js');

// Query-Spion: zeichnet jeden Aufruf auf und liefert ein konfigurierbares Ergebnis.
function makeQuerySpy(impl) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    if (typeof impl === 'function') return impl(sql, params);
    return { rows: [{ ok: true }], rowCount: 1 };
  };
  fn.calls = calls;
  return fn;
}

test('#122 Tür: gültiger Mandant ⇒ query mit Mandant als $1-Parameter, Tabellen explizit', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });
  const res = await db.read({
    tenant: 'acme',
    tables: ['guv_daily'],
    text: 'SELECT * FROM automatenlager.guv_daily WHERE tenant_id = $1 AND posting_date >= $2',
    params: ['2026-01-01'],
  });
  assert.equal(query.calls.length, 1, 'genau eine Abfrage');
  assert.deepEqual(query.calls[0].params, ['acme', '2026-01-01'], 'Mandant wird als $1 vorangestellt');
  assert.deepEqual(res.rows, [{ ok: true }]);
});

test('#122 Tür: KEIN Mandant ⇒ leeres Resultat und KEINE Abfrage (fail-closed)', async () => {
  for (const tenant of [undefined, null, '', '   ']) {
    const query = makeQuerySpy();
    const db = createTenantDb({ query });
    const res = await db.read({ tenant, tables: ['guv_daily'], text: 'SELECT 1' });
    assert.equal(query.calls.length, 0, `kein Mandant (${JSON.stringify(tenant)}) ⇒ keine Abfrage`);
    assert.deepEqual(res.rows, [], 'leeres Resultat');
    assert.equal(res.rowCount, 0);
  }
});

test('#122 Tür: KEIN Default-Fallback — leerer Mandant liefert nie fremde/Default-Daten', async () => {
  // Anti-Regression: selbst wenn die DB Daten hätte, darf ohne Mandant nichts kommen.
  const query = makeQuerySpy(() => ({ rows: [{ tenant_id: 't_faltrix' }], rowCount: 1 }));
  const db = createTenantDb({ query });
  const res = await db.read({ tenant: '', tables: ['guv_daily'], text: 'SELECT * FROM automatenlager.guv_daily' });
  assert.deepEqual(res.rows, [], 'kein __default__/t_faltrix-Fallback');
  assert.equal(query.calls.length, 0);
});

test('#122 Tür: technischer Fehler propagiert (≠ leer)', async () => {
  const boom = new Error('connection terminated');
  const query = makeQuerySpy(() => { throw boom; });
  const db = createTenantDb({ query });
  await assert.rejects(
    () => db.read({ tenant: 'acme', tables: ['guv_daily'], text: 'SELECT 1' }),
    /connection terminated/,
    'DB-Fehler darf nicht als leeres Resultat erscheinen',
  );
});

test('#122 Tür: explizite Zieltabelle(n) Pflicht — fehlend ⇒ Programmierfehler (wirft)', async () => {
  const db = createTenantDb({ query: makeQuerySpy() });
  await assert.rejects(() => db.read({ tenant: 'acme', text: 'SELECT 1' }), /Zieltabelle/);
  await assert.rejects(() => db.read({ tenant: 'acme', tables: [], text: 'SELECT 1' }), /Zieltabelle/);
});

test('#122 Tür: SQL-Text Pflicht', async () => {
  const db = createTenantDb({ query: makeQuerySpy() });
  await assert.rejects(() => db.read({ tenant: 'acme', tables: ['guv_daily'] }), /SQL/);
});

test('#122 Tür: Stufe-5-Haken inert — kein SET LOCAL / kein BEGIN in Stufe 3', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });
  await db.read({ tenant: 'acme', tables: ['guv_daily'], text: 'SELECT 1' });
  const issued = query.calls.map((c) => String(c.sql).toUpperCase());
  assert.ok(!issued.some((s) => s.includes('SET LOCAL')), 'kein SET LOCAL (RLS-Haken inaktiv)');
  assert.ok(!issued.some((s) => s.trim().startsWith('BEGIN')), 'keine eigene Transaktion');
  assert.equal(query.calls.length, 1, 'genau die eine Lese-Abfrage, kein Kontext-Setzen');
});

test('#122 Tür: pool statt query injizierbar (geteilter Pool)', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  const db = createTenantDb({ pool });
  await db.read({ tenant: 'acme', tables: ['guv_daily'], text: 'SELECT $1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['acme']);
});

test('#122 Tür: weder query noch pool ⇒ Konstruktionsfehler', () => {
  assert.throws(() => createTenantDb({}), /query|pool/i);
});

test('#122 forTenant: bindet Mandant; leerer Mandant ⇒ fail-closed', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });
  const acme = db.forTenant('acme');
  await acme.read({ tables: ['products'], text: 'SELECT * FROM automatenlager.products WHERE tenant_id = $1' });
  assert.deepEqual(query.calls[0].params, ['acme']);

  const nobody = db.forTenant('');
  const res = await nobody.read({ tables: ['products'], text: 'SELECT 1' });
  assert.deepEqual(res.rows, [], 'leerer Mandant ⇒ leer');
  assert.equal(query.calls.length, 1, 'fail-closed löst keine zweite Abfrage aus');
});

test('#122 forViewer: nutzt viewer.tenantId; Gast (tenantId=null) ⇒ leeres Dashboard', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });

  // Eigentümer-Viewer
  await db.forViewer({ tenantId: 't_faltrix' }).read({ tables: ['guv_daily'], text: 'SELECT 1' });
  assert.deepEqual(query.calls[0].params, ['t_faltrix']);

  // Gast/unzugeordnet (Stufe-2-resolveViewer liefert tenantId=null)
  const guest = await db.forViewer({ tenantId: null }).read({ tables: ['guv_daily'], text: 'SELECT 1' });
  assert.deepEqual(guest.rows, [], 'Gast ohne Mandant ⇒ leer');

  // Break-Glass: viewer.tenantId = Ziel-Mandant (read-only) ⇒ liest Ziel-Mandant
  await db.forViewer({ tenantId: 'acme', supportSession: { active: true } }).read({ tables: ['guv_daily'], text: 'SELECT 1' });
  assert.deepEqual(query.calls[1].params, ['acme'], 'Break-Glass liest den Ziel-Mandanten');
});

test('#122 isValidTenant: nur nicht-leere Strings', () => {
  assert.equal(isValidTenant('acme'), true);
  assert.equal(isValidTenant(''), false);
  assert.equal(isValidTenant('   '), false);
  assert.equal(isValidTenant(null), false);
  assert.equal(isValidTenant(undefined), false);
  assert.equal(isValidTenant(123), false);
});
