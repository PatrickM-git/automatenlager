'use strict';

/**
 * Schreib-Isolation Stufe 4 — Slice 0 „Fundament" (Issue #131).
 * SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Rollout-Reihenfolge → Slice 0"
 *
 * Verhaltens-Tests über die öffentliche Schnittstelle. Fünf Bausteine:
 *   1. db.write() fail-closed-WERFEND (kein stilles tenantless mehr); read() bleibt leer.
 *   2. db.tx(tenant, fn): transaktionaler Schreib-Modus (BEGIN→fn→COMMIT/ROLLBACK),
 *      tür-gebundenes read+write (Mandant als $1), Stufe-5-RLS-Haken inert.
 *   3. Body-Tenant-Reject-Helper: tenant_id/mandant_id im Body ⇒ 400 + Audit.
 *   4. #107-Guard Schreib-Melde-Modus: rohes pg auch in server.js (Endpunkt-Trx) erfasst.
 *   5. acme/globex-Schreib-Fixtures: jede Schreib-Zielrelation nicht-vakuös.
 *
 * Mock-Grenze = Systemgrenze DB. Die reinen Vertrags-Tests injizieren eine
 * query-/Pool-Attrappe; die nicht-vakuösen Tests laufen gegen das #94-Sandbox-
 * Harness (connectOrSkip/withRollback/Advisory-Lock), offline sauberes Skippen.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createTenantDb } = require('../lib/tenant-db.js');
const { detectBodyTenant, rejectBodyTenant } = require('../lib/write-guards.js');
const guard = require('../lib/query-filter-guard.js');
const { seedTenant, seedAcmeGlobex, WRITE_PATH_TABLES, sandboxTxPool } = require('./helpers/tenant-fixtures.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const SERVER_JS = path.join(__dirname, '..', 'server.js');

// ── Attrappen (Systemgrenze DB) ──────────────────────────────────────────────
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

// Ein-Client-Pool-Attrappe für tx(): connect() liefert denselben aufzeichnenden Client.
function makeFakeClient(impl) {
  const calls = [];
  const client = {
    released: false,
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (typeof impl === 'function') {
        const r = impl(sql, params);
        if (r !== undefined) return r;
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { client.released = true; },
  };
  return client;
}
function makeFakePool(client) {
  return { connect: async () => client, query: (sql, params) => client.query(sql, params) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. db.write() fail-closed-WERFEND; read() bleibt fail-closed-LEER
// ─────────────────────────────────────────────────────────────────────────────

test('#131 write(): ohne Mandant WIRFT (kein stilles {rowCount:0,tenantless})', async () => {
  const db = createTenantDb({ query: makeQuerySpy() });
  for (const tenant of [undefined, null, '', '   ']) {
    await assert.rejects(
      () => db.write({ tenant, tables: ['locations'], text: 'UPDATE automatenlager.locations SET x=1' }),
      /Mandant/i,
      `write ohne Mandant (${JSON.stringify(tenant)}) muss werfen`,
    );
  }
});

test('#131 write(): fail-closed setzt KEINE Abfrage ab (keine Teil-Schreibung)', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });
  await assert.rejects(() => db.write({ tenant: '', tables: ['locations'], text: 'UPDATE x' }));
  assert.equal(query.calls.length, 0, 'kein Mandant ⇒ keine Schreib-Query');
});

test('#131 write(): gültiger Mandant ⇒ Mandant als $1 vorangestellt, eigene Parameter ab $2', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });
  await db.write({
    tenant: 'acme',
    tables: ['locations'],
    text: 'INSERT INTO automatenlager.locations (location_key, tenant_id) VALUES ($2, $1)',
    params: ['loc_x'],
  });
  assert.equal(query.calls.length, 1);
  assert.deepEqual(query.calls[0].params, ['acme', 'loc_x']);
});

test('#131 read(): bleibt UNVERÄNDERT fail-closed-LEER (werfen nur beim Schreiben)', async () => {
  const query = makeQuerySpy();
  const db = createTenantDb({ query });
  const res = await db.read({ tenant: '', tables: ['locations'], text: 'SELECT 1' });
  assert.deepEqual(res.rows, [], 'leer ist ein gültiges Lese-Ergebnis');
  assert.equal(res.rowCount, 0);
  assert.equal(query.calls.length, 0, 'kein Mandant ⇒ keine Lese-Query');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. db.tx(tenant, fn): transaktionaler Schreib-Modus
// ─────────────────────────────────────────────────────────────────────────────

test('#131 tx(): BEGIN → tür-gebundenes read+write ($1=Mandant) → COMMIT bei Erfolg', async () => {
  const client = makeFakeClient((sql) => (/SELECT/i.test(sql) ? { rows: [{ n: 1 }], rowCount: 1 } : undefined));
  const db = createTenantDb({ pool: makeFakePool(client) });

  const result = await db.tx('acme', async (door) => {
    await door.read({ tables: ['machines'], text: 'SELECT machine_id FROM automatenlager.machines WHERE tenant_id = $1' });
    await door.write({ tables: ['machines'], text: 'INSERT INTO automatenlager.machines (machine_key, tenant_id) VALUES ($2,$1)', params: ['vm_x'] });
    return 'fertig';
  });

  assert.equal(result, 'fertig', 'Rückgabewert von fn wird durchgereicht');
  const sqls = client.calls.map((c) => String(c.sql).trim().toUpperCase());
  assert.equal(sqls[0], 'BEGIN', 'erste Anweisung ist BEGIN');
  assert.equal(sqls[sqls.length - 1], 'COMMIT', 'letzte Anweisung ist COMMIT');

  const writeCall = client.calls.find((c) => /INSERT/i.test(c.sql));
  assert.deepEqual(writeCall.params, ['acme', 'vm_x'], 'write trägt Mandant als $1');
  const readCall = client.calls.find((c) => /SELECT/i.test(c.sql));
  assert.deepEqual(readCall.params, ['acme'], 'read trägt Mandant als $1');
  assert.equal(client.released, true, 'Client wird freigegeben');
});

test('#131 tx(): Fehler in fn ⇒ ROLLBACK, KEIN COMMIT, Fehler propagiert, Client freigegeben', async () => {
  const client = makeFakeClient();
  const db = createTenantDb({ pool: makeFakePool(client) });
  const boom = new Error('fachlicher Abbruch');

  await assert.rejects(() => db.tx('acme', async (door) => {
    await door.write({ tables: ['machines'], text: 'INSERT INTO automatenlager.machines (machine_key, tenant_id) VALUES ($2,$1)', params: ['vm_x'] });
    throw boom;
  }), /fachlicher Abbruch/);

  const sqls = client.calls.map((c) => String(c.sql).trim().toUpperCase());
  assert.ok(sqls.includes('ROLLBACK'), 'ROLLBACK wurde abgesetzt');
  assert.ok(!sqls.includes('COMMIT'), 'kein COMMIT bei Fehler');
  assert.equal(client.released, true, 'Client auch im Fehlerfall freigegeben');
});

test('#131 tx(): ohne Mandant WIRFT und holt KEINEN Client (fail-closed)', async () => {
  const client = makeFakeClient();
  let connected = false;
  // Realistischer Pool (echter pg.Pool hat query UND connect); query darf hier nie laufen.
  const pool = {
    query: async () => { throw new Error('pool.query darf bei mandantenlosem tx nie laufen'); },
    connect: async () => { connected = true; return client; },
  };
  const db = createTenantDb({ pool });
  for (const tenant of [undefined, null, '', '  ']) {
    await assert.rejects(() => db.tx(tenant, async () => {}), /Mandant/i);
  }
  assert.equal(connected, false, 'fail-closed ⇒ kein Client geholt');
  assert.equal(client.calls.length, 0);
});

test('#131 tx(): Stufe-5-RLS-Haken INERT — kein SET LOCAL in Stufe 4', async () => {
  const client = makeFakeClient();
  const db = createTenantDb({ pool: makeFakePool(client) });
  await db.tx('acme', async (door) => {
    await door.write({ tables: ['machines'], text: 'INSERT INTO automatenlager.machines (machine_key, tenant_id) VALUES ($2,$1)', params: ['vm_x'] });
  });
  const issued = client.calls.map((c) => String(c.sql).toUpperCase());
  assert.ok(!issued.some((s) => s.includes('SET LOCAL')), 'kein SET LOCAL (RLS bewusst inaktiv in Stufe 4)');
  assert.ok(issued.includes('BEGIN') && issued.includes('COMMIT'), 'aber echte Transaktion (BEGIN/COMMIT)');
});

test('#131 tx(): ohne Pool mit connect() ⇒ klarer Fehler (tx braucht dedizierten Client)', async () => {
  const db = createTenantDb({ query: makeQuerySpy() }); // nur query-Funktion, kein Pool
  await assert.rejects(() => db.tx('acme', async () => {}), /pool|connect/i);
});

test('#131 tx() im bound-write: fehlende Zieltabelle ⇒ Programmierfehler (wirft)', async () => {
  const client = makeFakeClient();
  const db = createTenantDb({ pool: makeFakePool(client) });
  await assert.rejects(() => db.tx('acme', async (door) => {
    await door.write({ text: 'INSERT INTO automatenlager.machines DEFAULT VALUES' }); // tables fehlt
  }), /Zieltabelle/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Body-Tenant-Reject-Helper (gebaut + unit-getestet; Verkabelung = Slice 2/3)
// ─────────────────────────────────────────────────────────────────────────────

test('#131 Body-Reject: erkennt tenant_id und mandant_id; sauberer Body ⇒ null', () => {
  assert.equal(detectBodyTenant({ tenant_id: 'x' }), 'tenant_id');
  assert.equal(detectBodyTenant({ mandant_id: 'y' }), 'mandant_id');
  assert.equal(detectBodyTenant({ tenant_id: 'x', mandant_id: 'y' }), 'tenant_id'); // erstes Vorkommen reicht
  assert.equal(detectBodyTenant({ batch_key: 'b', qty: 3 }), null);
  assert.equal(detectBodyTenant(null), null);
  assert.equal(detectBodyTenant('nicht-objekt'), null);
});

test('#131 Body-Reject: verschmutzter Body ⇒ 400 + Audit; sauberer Body ⇒ durchlässig', () => {
  const sent = [];
  const audits = [];
  const sendJson = (res, status, payload) => sent.push({ status, payload });
  const audit = (viewer, event, details) => audits.push({ viewer, event, details });
  const viewer = { login: 'a@b', tenantId: 'acme' };

  const rejected = rejectBodyTenant({ tenant_id: 'globex', batch_key: 'b' }, { res: {}, viewer, sendJson, audit });
  assert.equal(rejected, true, 'Body mit Mandant wird abgelehnt');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 400, '400 Bad Request');
  assert.match(String(sent[0].payload.error.code), /TENANT/, 'klarer Fehlercode');
  assert.equal(audits.length, 1, 'genau ein Audit-Eintrag');
  assert.equal(audits[0].details.field, 'tenant_id', 'auditiert das verletzende Feld');

  const ok = rejectBodyTenant({ batch_key: 'b' }, { res: {}, viewer, sendJson, audit });
  assert.equal(ok, false, 'sauberer Body ist durchlässig');
  assert.equal(sent.length, 1, 'keine zweite Antwort');
  assert.equal(audits.length, 1, 'kein zweites Audit');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. #107-Guard: Schreib-Melde-Modus (erfasst rohes pg auch in server.js)
// ─────────────────────────────────────────────────────────────────────────────

test('#131 Guard Schreib-Melde-Modus: rohe pg-Schreibpfade inkl. server.js inventarisiert, bricht NICHT', () => {
  const report = guard.buildReport({ libDir: LIB_DIR, entryFiles: [SERVER_JS] });
  assert.ok(Array.isArray(report.bypass), 'Worklist ist eine Liste');
  const files = report.bypass.map((b) => b.file);
  // server.js trägt heute die rohe write-off-Transaktion (BEGIN/COMMIT/client.query).
  assert.ok(files.includes('server.js'), 'roher Schreibpfad in server.js wird erfasst');
  const serverEntry = report.bypass.find((b) => b.file === 'server.js');
  assert.ok(serverEntry.reasons.length > 0, 'server.js-Eintrag trägt Begründungen (welche Muster)');
});

test('#131 Guard: entryFiles erweitert NUR additiv — libDir-Verhalten unverändert', () => {
  const base = guard.buildReport({ libDir: LIB_DIR });
  const withServer = guard.buildReport({ libDir: LIB_DIR, entryFiles: [SERVER_JS] });
  assert.ok(!base.bypass.some((b) => b.file === 'server.js'), 'ohne entryFiles kein server.js');
  for (const b of base.bypass) {
    assert.ok(withServer.bypass.some((w) => w.file === b.file), `${b.file} bleibt erfasst (additiv)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. acme/globex-Schreib-Fixtures (nicht-vakuös) + tx-Rollback gegen die echte DB
// ─────────────────────────────────────────────────────────────────────────────

test('#131 Schreib-Fixtures: acme UND globex tragen Zeilen in JEDER Schreib-Zielrelation (nicht-vakuös)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    assert.ok(Array.isArray(WRITE_PATH_TABLES) && WRITE_PATH_TABLES.includes('settings_thresholds'),
      'WRITE_PATH_TABLES nennt die Schreib-Zielrelationen inkl. settings_thresholds');
    for (const table of WRITE_PATH_TABLES) {
      for (const tid of ['acme', 'globex']) {
        const r = await client.query(
          `SELECT COUNT(*)::int AS n FROM automatenlager.${table} WHERE tenant_id = $1`, [tid],
        );
        assert.ok(r.rows[0].n > 0, `${tid} hat Zeilen in ${table} (nicht-vakuös)`);
      }
    }
  });
});

test('#131 Schreib-Fixtures: settings_thresholds je Mandant UNTERSCHEIDBAR (kein Cross-Tenant-Leak)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client);
    const valueFor = async (tid) => {
      const r = await client.query(
        `SELECT value FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND key = 'ladenhueterDays'`, [tid]);
      assert.equal(r.rows.length, 1, `${tid} hat genau einen Schwellwert`);
      return Number(r.rows[0].value);
    };
    const acmeVal = await valueFor('acme');
    const globexVal = await valueFor('globex');
    // acme=100, globex=250 (= revenueBase) ⇒ ein Leak fiele als falscher Wert auf.
    assert.equal(acmeVal, 100, 'acme-Filter liefert acme-Wert');
    assert.equal(globexVal, 250, 'globex-Filter liefert globex-Wert');
    assert.notEqual(acmeVal, globexVal, 'Werte sind unterscheidbar (nicht-vakuös)');
  });
});

test('#131 tx() (Sandbox): Fehler rollt echte Schreibung zurück — keine Teil-Schreibung bleibt', async (t) => {
  await inSandbox(t, async (client) => {
    await seedTenant(client, 'acme');
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    const marker = 'loc_acme_tx_rollback_probe';
    await assert.rejects(() => db.tx('acme', async (door) => {
      await door.write({
        tables: ['locations'],
        text: `INSERT INTO automatenlager.locations (location_key, name, location_type, tenant_id)
               VALUES ($2, $3, 'automat', $1)`,
        params: [marker, 'TX-Rollback-Probe'],
      });
      // Beweis nötig: Zeile ist innerhalb der Transaktion sichtbar …
      const mid = await door.read({
        tables: ['locations'],
        text: `SELECT COUNT(*)::int AS n FROM automatenlager.locations WHERE tenant_id = $1 AND location_key = $2`,
        params: [marker],
      });
      assert.equal(mid.rows[0].n, 1, 'Schreibung ist in der offenen Transaktion sichtbar');
      throw new Error('abbruch nach write');
    }), /abbruch/);

    const after = await client.query(
      `SELECT COUNT(*)::int AS n FROM automatenlager.locations WHERE location_key = $1`, [marker]);
    assert.equal(after.rows[0].n, 0, '… nach ROLLBACK ist nichts geblieben');
  });
});

test('#131 tx() (Sandbox): Erfolg committet die Schreibung mandantengebunden', async (t) => {
  await inSandbox(t, async (client) => {
    await seedTenant(client, 'acme');
    const db = createTenantDb({ pool: sandboxTxPool(client) });
    const marker = 'loc_acme_tx_commit_probe';
    await db.tx('acme', async (door) => {
      await door.write({
        tables: ['locations'],
        text: `INSERT INTO automatenlager.locations (location_key, name, location_type, tenant_id)
               VALUES ($2, $3, 'automat', $1)`,
        params: [marker, 'TX-Commit-Probe'],
      });
    });
    const acme = await client.query(
      `SELECT COUNT(*)::int AS n FROM automatenlager.locations WHERE tenant_id = 'acme' AND location_key = $1`, [marker]);
    const globex = await client.query(
      `SELECT COUNT(*)::int AS n FROM automatenlager.locations WHERE tenant_id = 'globex' AND location_key = $1`, [marker]);
    assert.equal(acme.rows[0].n, 1, 'acme sieht die committete Zeile');
    assert.equal(globex.rows[0].n, 0, 'globex sieht sie nicht');
  });
});
