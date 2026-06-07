'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTenantDb } = require('../lib/tenant-db.js'); // #127: queryLocationsPg ist jetzt tür-basiert

const {
  queryLocationsPg,
  upsertLocationPg,
  buildLocationComparison,
  slugifyLocationKey,
  LOCATIONS_SELECT_SQL,
} = require('../lib/location-profiles.js');

// Reales Schema von automatenlager.locations (Produktiv-DB homelab).
const REAL_LOCATION_COLUMNS = [
  'location_id', 'location_key', 'name', 'location_type', 'address',
  'customer_group', 'opening_hours', 'notes', 'created_at', 'updated_at',
  'tenant_id', // #127: reale Spalte (Migration 0009) — vom Mandanten-Filter genutzt
];

// Emuliert die Spaltenprüfung von Postgres: jede mit `l.` qualifizierte
// Referenz auf die locations-Tabelle muss real existieren, sonst wirft die
// (gefakte) DB denselben Fehler wie zuvor produktiv: 42703 "column ... does not exist".
function assertOnlyRealLocationColumns(sql) {
  const refs = [...sql.matchAll(/\bl\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
  for (const col of refs) {
    if (!REAL_LOCATION_COLUMNS.includes(col)) {
      const err = new Error(`column "${col}" does not exist`);
      err.code = '42703';
      throw err;
    }
  }
}

function makeFakeClient(rowsForQuery) {
  const calls = [];
  return {
    calls,
    async connect() { this.connected = true; },
    async query(sql, params) {
      // #144: RLS-GUC-Setzer (ambient-Modus) ist Vertragsbestandteil, aber kein
      // Daten-Read — nicht validieren/aufzeichnen.
      if (typeof sql === 'string' && sql.includes("set_config('automatenlager.current_tenant'")) {
        return { rows: [], rowCount: 0 };
      }
      // Wie die echte DB: zuerst Spalten validieren, dann Zeilen liefern.
      assertOnlyRealLocationColumns(sql);
      calls.push({ sql, params });
      return { rows: typeof rowsForQuery === 'function' ? rowsForQuery(sql, params) : rowsForQuery };
    },
    async end() { this.ended = true; },
  };
}

// ── Regression: GET /api/v2/locations scheitert nicht mehr an fehlender Spalte ──

test('REGRESSION: queryLocationsPg referenziert nur real existierende locations-Spalten (kein 503/PG_ERROR mehr)', async () => {
  const fake = makeFakeClient([
    {
      location_id: '1',
      name: 'DPFA Weiterbildung Chemnitz',
      notes: null,
      target_group: null,
      start_date: null,
      machine_ids: ['1', '2'],
      status: 'aktiv',
    },
  ]);

  // Vor dem Fix warf dies "column \"status\" does not exist"; jetzt läuft es durch.
  // #127: durch die Mandanten-Tür (fake-Client als query-Quelle gewrappt).
  const db = createTenantDb({ query: (s, p) => fake.query(s, p), ambient: true });
  const profiles = await queryLocationsPg(db, 'acme');

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'DPFA Weiterbildung Chemnitz');
  assert.equal(profiles[0].status, 'aktiv');
  assert.deepEqual(profiles[0].machine_ids, ['1', '2']);
  assert.equal(profiles[0].target_group, null);
  assert.equal(profiles[0].start_date, null);

  // machine_ids/target_group werden aus dem realen Schema abgeleitet.
  assert.match(fake.calls[0].sql, /automatenlager\.machines/);
  assert.match(fake.calls[0].sql, /customer_group/);
  // #127: Mandanten-Filter ist im SELECT verankert.
  assert.match(fake.calls[0].sql, /l\.tenant_id = \$1/);
});

test('REGRESSION-GUARD: die Spaltenprüfung erkennt eine wieder eingeführte status-Spalte', () => {
  // Stellt sicher, dass der obige Test nicht vacuous ist: würde jemand erneut
  // `l.status` o. Ä. selektieren, schlägt die emulierte DB-Prüfung an.
  assert.throws(
    () => assertOnlyRealLocationColumns('SELECT l.status, l.start_date FROM automatenlager.locations l'),
    /column "status" does not exist/,
  );
  // Und das tatsächliche Produktiv-SELECT besteht die Prüfung.
  assert.doesNotThrow(() => assertOnlyRealLocationColumns(LOCATIONS_SELECT_SQL));
});

test('queryLocationsPg-Ergebnis ist direkt mit buildLocationComparison kompatibel', async () => {
  const fake = makeFakeClient([
    { location_id: '1', name: 'Standort A', notes: null, target_group: 'Schule', start_date: null, machine_ids: ['VM01'], status: 'aktiv' },
  ]);
  const profiles = await queryLocationsPg(createTenantDb({ query: (s, p) => fake.query(s, p), ambient: true }), 'acme');
  const cmp = buildLocationComparison(profiles, [
    { machine_id: 'VM01', revenue_net: 100, db_net: 30, qty: 10, slot_turnover: 1, inventory_value: 50 },
  ]);
  assert.equal(cmp[0].name, 'Standort A');
  assert.equal(cmp[0].target_group, 'Schule');
  assert.equal(cmp[0].kpis.revenue_net, 100);
  assert.equal(cmp[0].kpis.qty, 10);
});

// ── Schreibpfad: upsertLocationPg an reales Schema angepasst ────────────────────

// #135: tür-basiert (Mandant als $1 vorangestellt). Die injizierte query-Funktion
// ist die Systemgrenze DB; assertOnlyRealLocationColumns spielt die PG-Spaltenprüfung.
function makeDoorCapture(rowFor) {
  const calls = [];
  const db = createTenantDb({
    ambient: true, // #144: Einzel-Client-Tür (set_config + Query in der Aufrufer-Transaktion)
    query: async (sql, params) => {
      // #144: GUC-Setzer ist Vertragsbestandteil, kein Daten-Write — nicht validieren/aufzeichnen.
      if (typeof sql === 'string' && sql.includes("set_config('automatenlager.current_tenant'")) {
        return { rows: [], rowCount: 0 };
      }
      assertOnlyRealLocationColumns(sql);
      calls.push({ sql, params });
      return { rows: [rowFor(params)], rowCount: 1 };
    },
  });
  return { db, calls };
}

test('upsertLocationPg schreibt nur reale Spalten und nutzt ON CONFLICT (tenant_id, location_key)', async () => {
  // params (mit vorangestelltem Mandanten): [tenant, location_key, name, location_type, customer_group, notes]
  const { db, calls } = makeDoorCapture((p) => ({ location_id: '7', location_key: p[1], name: p[2], location_type: p[3], customer_group: p[4], notes: p[5] }));

  const saved = await upsertLocationPg(db, 'acme', {
    name: 'Büro Berlin',
    status: 'aktiv',
    notes: 'Kantine EG',
    start_date: null,
    target_group: 'Mitarbeiter',
    machine_ids: ['VM01'],
  });

  const { sql, params } = calls[0];
  // #132/#135: ON CONFLICT mandantengetrennt — nie das Überschreiben fremder Standorte.
  assert.match(sql, /ON CONFLICT \(tenant_id, location_key\)/);
  // Nicht existierende Spalten dürfen nicht geschrieben werden.
  assert.doesNotMatch(sql, /\bstatus\b/);
  assert.doesNotMatch(sql, /start_date/);
  assert.doesNotMatch(sql, /machine_ids/);
  // Mandant als $1; eigene Parameter ab $2. Mapping target_group → customer_group.
  assert.equal(params[0], 'acme');
  assert.equal(params[1], 'LOC_BUERO_BERLIN');
  assert.equal(params[2], 'Büro Berlin');
  assert.equal(params[4], 'Mitarbeiter');
  assert.equal(params[5], 'Kantine EG');
  // Ergebnis wird zurück ins Domänenmodell gemappt.
  assert.equal(saved.name, 'Büro Berlin');
  assert.equal(saved.target_group, 'Mitarbeiter');
  assert.deepEqual(saved.machine_ids, []);
});

test('upsertLocationPg akzeptiert expliziten location_key und location_type', async () => {
  const { db, calls } = makeDoorCapture((p) => ({ location_id: '8', location_key: p[1], name: p[2], location_type: p[3], customer_group: p[4], notes: p[5] }));
  await upsertLocationPg(db, 'acme', {
    name: 'DPFA Chemnitz', status: 'aktiv', machine_ids: [],
    location_key: 'LOC_DPFA_CHEMNITZ', location_type: 'bildung',
  });
  assert.equal(calls[0].params[0], 'acme');             // Mandant als $1
  assert.equal(calls[0].params[1], 'LOC_DPFA_CHEMNITZ'); // location_key
  assert.equal(calls[0].params[3], 'bildung');           // location_type
});

test('slugifyLocationKey transliteriert Umlaute und erzeugt LOC_-Prefix', () => {
  assert.equal(slugifyLocationKey('DPFA Weiterbildung Chemnitz'), 'LOC_DPFA_WEITERBILDUNG_CHEMNITZ');
  assert.equal(slugifyLocationKey('Büro Süd'), 'LOC_BUERO_SUED');
  assert.equal(slugifyLocationKey('Straße 1'), 'LOC_STRASSE_1');
  assert.equal(slugifyLocationKey('   '), 'LOC_STANDORT');
});

test('REGRESSION: machine_ids wird aus machine_key aggregiert (behebt "Ohne Standort" trotz location_id)', () => {
  // Die v3-Automaten-Seite matcht location.machine_ids gegen die
  // machine-profiles-Identität (= machine_key, z. B. "457107528"). Trüge
  // machine_ids die bigint machine_id (z. B. "1"), zeigte ein korrekt
  // verknuepfter Automat faelschlich "Ohne Standort".
  assert.match(LOCATIONS_SELECT_SQL, /array_agg\(\s*m\.machine_key/i,
    'machine_ids muss aus m.machine_key aggregiert werden');
  assert.doesNotMatch(LOCATIONS_SELECT_SQL, /array_agg\(\s*m\.machine_id\b/i,
    'nicht die bigint m.machine_id (ID-Raum-Mismatch zur machine-profiles-Identitaet)');
});
