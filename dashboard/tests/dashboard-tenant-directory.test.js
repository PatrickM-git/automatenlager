'use strict';

// Issue #116 — Mandanten-Registry (lib/tenant-directory.js), Stufe 2.
// Zwei Test-Ebenen:
//   A) Logik-Tests mit Fake-query (synthetische Mandanten acme/globex in-memory):
//      Negative-Caching, Fehler-Propagierung, fail-closed, Refresh-Resilienz —
//      Faelle, die gegen eine echte DB schwer/teuer zu simulieren sind.
//   B) LIVE-Sandbox-Integration (ROLLBACK) gegen die echte DB mit angelegten
//      Mandanten acme/globex: beweist, dass die SQL/Spaltennamen stimmen.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDirectory } = require('../lib/tenant-directory.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');

// ── Fake-query-Harness: synthetische Mandanten acme/globex ───────────────────
function makeFake(overrides = {}) {
  const data = {
    users: [
      { login: 'owner@acme.test', tenant_id: 'acme' },
      { login: 'Owner@Globex.Test', tenant_id: 'globex' }, // gemischte Schreibweise
    ],
    admins: [{ login: 'support@platform.test' }],
    tenants: [{ tenant_id: 'acme' }, { tenant_id: 'globex' }],
    machines: [{ machine_key: 'ACME-1', tenant_id: 'acme' }],
    ...overrides,
  };
  const state = { fail: false, recheckCalls: 0, recheckRows: [] };
  const query = async (sql) => {
    if (state.fail) throw new Error('simulierter DB-Fehler');
    if (/FROM automatenlager\.tenant_users/.test(sql)) return { rows: data.users };
    if (/FROM automatenlager\.platform_admins/.test(sql)) return { rows: data.admins };
    if (/FROM automatenlager\.tenants/.test(sql)) return { rows: data.tenants };
    if (/WHERE machine_key = \$1/.test(sql)) { state.recheckCalls++; return { rows: state.recheckRows }; }
    if (/FROM automatenlager\.machines/.test(sql)) return { rows: data.machines };
    throw new Error('unerwartetes SQL im Test: ' + sql);
  };
  return { query, state, data };
}

test('#116 loginTenant: bekannter Login -> tenant_id, lowercase-normalisiert, unbekannt -> null', async () => {
  const fake = makeFake();
  const dir = createTenantDirectory({ query: fake.query });
  await dir.init();
  assert.equal(dir.loginTenant('owner@acme.test'), 'acme');
  assert.equal(dir.loginTenant('OWNER@ACME.TEST'), 'acme', 'case-insensitive');
  assert.equal(dir.loginTenant('owner@globex.test'), 'globex', 'DB-Schreibweise wird lowercased');
  assert.equal(dir.loginTenant('niemand@x.de'), null, 'unbekannt -> null');
  assert.equal(dir.loginTenant(''), null);
});

test('#116 isPlatformAdmin + tenantExists synchron aus dem Cache', async () => {
  const dir = createTenantDirectory({ query: makeFake().query });
  await dir.init();
  assert.equal(dir.isPlatformAdmin('support@platform.test'), true);
  assert.equal(dir.isPlatformAdmin('owner@acme.test'), false, 'normaler User ist kein Plattform-Admin');
  assert.equal(dir.tenantExists('acme'), true);
  assert.equal(dir.tenantExists('globex'), true);
  assert.equal(dir.tenantExists('nichtda'), false);
  assert.equal(dir.tenantExists(null), false);
  assert.equal(dir.tenantExists(''), false);
});

test('#116 machineTenant: Cache-Hit ohne DB-Recheck', async () => {
  const fake = makeFake();
  const dir = createTenantDirectory({ query: fake.query });
  await dir.init();
  assert.equal(await dir.machineTenant('ACME-1'), 'acme');
  assert.equal(fake.state.recheckCalls, 0, 'bekannte Maschine -> kein Einzel-Recheck');
});

test('#116 machineTenant: nach Snapshot angelegte Maschine via Miss-Recheck + danach gecacht', async () => {
  const fake = makeFake();
  fake.state.recheckRows = [{ tenant_id: 'globex' }]; // n8n hat GLOBEX-9 nach dem Start angelegt
  const dir = createTenantDirectory({ query: fake.query });
  await dir.init();
  assert.equal(await dir.machineTenant('GLOBEX-9'), 'globex', 'Miss-Recheck loest auf');
  assert.equal(fake.state.recheckCalls, 1);
  // Zweiter Aufruf: jetzt positiv gecacht -> kein weiterer Recheck.
  assert.equal(await dir.machineTenant('GLOBEX-9'), 'globex');
  assert.equal(fake.state.recheckCalls, 1, 'positiv gecacht');
});

test('#116 machineTenant: unbekannte Maschine -> null, Negative-Caching verhindert Probe-Amplification', async () => {
  const fake = makeFake();
  fake.state.recheckRows = []; // nicht gefunden
  const dir = createTenantDirectory({ query: fake.query });
  await dir.init();
  assert.equal(await dir.machineTenant('GHOST'), null);
  assert.equal(await dir.machineTenant('GHOST'), null);
  assert.equal(await dir.machineTenant('GHOST'), null);
  assert.equal(fake.state.recheckCalls, 1, 'wiederholtes Probing erzeugt nur EINEN DB-Recheck');
});

test('#116 machineTenant: technischer DB-Fehler propagiert (rejects) und liefert NIE null', async () => {
  const fake = makeFake();
  const dir = createTenantDirectory({ query: fake.query });
  await dir.init();
  fake.state.fail = true; // DB faellt nach dem Snapshot aus
  await assert.rejects(() => dir.machineTenant('NEU-1'), /simulierter DB-Fehler/,
    'Recheck-Fehler propagiert, kein stilles null');
});

test('#116 fail-closed: initialer Load-Fehler -> init wirft, isReady=false, Lookups leer', async () => {
  const fake = makeFake();
  fake.state.fail = true;
  const dir = createTenantDirectory({ query: fake.query });
  await assert.rejects(() => dir.init(), /simulierter DB-Fehler/);
  assert.equal(dir.isReady(), false, 'nicht bereit');
  assert.equal(dir.loginTenant('owner@acme.test'), null, 'kein Durchwinken aus leerem Verzeichnis');
  assert.equal(dir.tenantExists('acme'), false);
  assert.equal(dir.isPlatformAdmin('support@platform.test'), false);
});

test('#116 Refresh-Resilienz: fehlgeschlagener Refresh behaelt letzten gueltigen Snapshot', async () => {
  const fake = makeFake();
  const dir = createTenantDirectory({ query: fake.query });
  await dir.init();
  assert.equal(dir.loginTenant('owner@acme.test'), 'acme');

  fake.state.fail = true;
  // harter refresh() wirft ...
  await assert.rejects(() => dir.refresh(), /simulierter DB-Fehler/);
  // ... refreshQuietly (Timer-Pfad) schluckt und liefert false ...
  assert.equal(await dir.refreshQuietly(), false);
  // ... aber der letzte gueltige Snapshot bleibt aktiv (kein Zurueckfallen auf leer).
  assert.equal(dir.isReady(), true);
  assert.equal(dir.loginTenant('owner@acme.test'), 'acme', 'Lookups funktionieren weiter');
  assert.equal(dir.tenantExists('acme'), true);
});

test('#116 ohne query-Funktion -> Konstruktion wirft', () => {
  assert.throws(() => createTenantDirectory({}), /query-Funktion erforderlich/);
});

// ── B) LIVE-Sandbox gegen die echte DB (acme/globex), ROLLBACK ───────────────
async function setup(client) {
  for (let n = 7; n <= 18; n++) await applyMigration(client, n);
}

test('#116 LIVE-Sandbox: loginTenant/tenantExists/isPlatformAdmin gegen echte acme/globex', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Zwei synthetische Mandanten + Mitgliedschaften + ein Plattform-Admin.
    await client.query(`SELECT automatenlager.fn_create_tenant('acme','Acme','a@acme.test')`);
    await client.query(`SELECT automatenlager.fn_create_tenant('globex','Globex','g@globex.test')`);
    await client.query(`INSERT INTO automatenlager.tenant_users (tenant_id, login, role) VALUES ('acme','owner@acme.test','eigentuemer')`);
    await client.query(`INSERT INTO automatenlager.tenant_users (tenant_id, login, role) VALUES ('globex','owner@globex.test','eigentuemer')`);
    await client.query(`INSERT INTO automatenlager.platform_admins (login) VALUES ('support@platform.test')`);

    const dir = createTenantDirectory({ query: (sql, params) => client.query(sql, params) });
    await dir.init();

    assert.equal(dir.loginTenant('owner@acme.test'), 'acme', 'echte DB: acme-Login');
    assert.equal(dir.loginTenant('owner@globex.test'), 'globex', 'echte DB: globex-Login (Isolation)');
    assert.equal(dir.isPlatformAdmin('support@platform.test'), true);
    assert.equal(dir.tenantExists('acme'), true);
    assert.equal(dir.tenantExists('globex'), true);
    assert.equal(dir.tenantExists('t_nichtda'), false);
  });
});

test('#116 LIVE-Sandbox: machineTenant Cache-Hit + Miss-Recheck einer NACH init angelegten Maschine', async (t) => {
  await inSandbox(t, async (client) => {
    await setup(client);
    // Existierende t_faltrix-Maschine + location aus den Echtdaten holen.
    const ctx = await client.query(`
      SELECT (SELECT machine_key FROM automatenlager.machines WHERE tenant_id='t_faltrix' LIMIT 1) mk,
             (SELECT location_id FROM automatenlager.locations WHERE tenant_id='t_faltrix' LIMIT 1) lid`);
    const { mk, lid } = ctx.rows[0];

    const dir = createTenantDirectory({ query: (sql, params) => client.query(sql, params) });
    await dir.init();

    if (mk) assert.equal(await dir.machineTenant(mk), 't_faltrix', 'bekannte Maschine via Snapshot-Cache');
    assert.equal(await dir.machineTenant('GHOST_KEY_TDIR'), null, 'unbekannte Maschine -> null');

    // Maschine NACH init anlegen -> Miss-Recheck muss sie finden (n8n-Zweitschreiber).
    await client.query(
      `INSERT INTO automatenlager.machines (machine_key, name, location_id, tenant_id, active)
       VALUES ('TDIR_LATE','T',${lid},'t_faltrix',TRUE)`);
    assert.equal(await dir.machineTenant('TDIR_LATE'), 't_faltrix', 'spaeter angelegte Maschine via Miss-Recheck');
  });
});

// ── Härtung: Self-Heal nach fehlgeschlagenem Initial-Load (Deploy-Fenster) ────────
// Garantie, auf die sich server.js::initTenantDirectory (finally → startAutoRefresh)
// verlässt: ein fehlgeschlagener Initial-Load lässt das Verzeichnis NICHT dauerhaft
// unready — der nächste (Auto-Refresh-)Tick heilt selbst, sobald die DB wieder antwortet.
test('Härtung: fehlgeschlagener Initial-Load → ready=false, späterer Refresh heilt → ready=true', async () => {
  let calls = 0;
  const query = async (sql) => {
    calls++;
    // Die ersten 4 Aufrufe (loadSnapshot = 4 SELECTs) scheitern (DB im Deploy-Fenster nicht erreichbar).
    if (calls <= 4) throw new Error('DB nicht erreichbar (Deploy-Fenster)');
    if (sql.includes('tenant_users')) return { rows: [{ login: 'owner@example.test', tenant_id: 't_faltrix' }] };
    if (sql.includes('tenants')) return { rows: [{ tenant_id: 't_faltrix' }] };
    return { rows: [] };
  };
  const dir = createTenantDirectory({ query });

  await assert.rejects(() => dir.init(), /nicht erreichbar/, 'Initial-Load wirft (fail-closed)');
  assert.equal(dir.isReady(), false, 'nach Fehl-Init NICHT bereit (kein leeres Durchwinken)');
  assert.equal(dir.loginTenant('owner@example.test'), null, 'unready ⇒ kein Lookup');

  // Genau das, was der Auto-Refresh-Timer (server.js: finally → startAutoRefresh) tickt:
  const healed = await dir.refreshQuietly();
  assert.equal(healed, true, 'Refresh erfolgreich, sobald die DB wieder antwortet');
  assert.equal(dir.isReady(), true, 'Verzeichnis hat sich selbst geheilt (kein Dauer-503)');
  assert.equal(dir.loginTenant('owner@example.test'), 't_faltrix', 'Owner löst nach Self-Heal wieder auf');
});
