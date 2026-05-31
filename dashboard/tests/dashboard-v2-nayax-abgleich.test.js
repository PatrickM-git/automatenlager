'use strict';

// TDD fuer Issue #17: "Aus Nayax abgleichen" - reine Abgleich-Logik.
// Vollabgleich Slotbelegung (Umbuchung) UND Fuellstand Nayax/Moma -> PG.
// Nayax-Wahrheit: machineProducts, On-Hand = PAR - MissingStockByMDB (nur MDB).
// Matching Nayax-Produktname -> products.product_id ueber product_aliases (source='nayax').
// Reine Funktionen, voll getestet inkl. Edge-Cases. machine_id parametrisch.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeOnHand,
  normalizeName,
  normalizeNayaxItems,
  buildAliasIndex,
  matchNayaxProduct,
  buildAbgleichDiff,
  buildApplyPlan,
  validateAbgleichApply,
  buildAbgleichPreviewPayload,
  buildAbgleichApplyPayload,
  buildAbgleichAuditEntry,
  buildActiveSlotsQuery,
  buildNayaxAliasesQuery,
  buildProductsByIdQuery,
} = require('../lib/nayax-abgleich.js');

// ── computeOnHand: PAR - MissingStockByMDB, geclamped >= 0 ────────────────────

test('computeOnHand: On-Hand = PAR - MissingStockByMDB', () => {
  assert.equal(computeOnHand(40, 5), 35);
  assert.equal(computeOnHand(40, 0), 40);
  assert.equal(computeOnHand(10, 3), 7);
});

test('computeOnHand: negativ wird auf 0 geclamped', () => {
  assert.equal(computeOnHand(10, 15), 0);
});

test('computeOnHand: fehlende Werte -> 0, robust', () => {
  assert.equal(computeOnHand(undefined, undefined), 0);
  assert.equal(computeOnHand(null, null), 0);
  assert.equal(computeOnHand('8', '2'), 6);
});

// ── normalizeName: symmetrische Normalisierung fuer das Matching ──────────────

test('normalizeName: lowercase + trim + Whitespace-Kollaps', () => {
  assert.equal(normalizeName('  Snickers '), 'snickers');
  assert.equal(normalizeName('COCA  COLA'), 'coca cola');
});

test('normalizeName: deutsche Umlaute + ss werden ascii-gemappt (kein U+FFFD-Bug)', () => {
  assert.equal(normalizeName('Müller'), 'mueller');
  assert.equal(normalizeName('Weiße Schokolade'), 'weisse schokolade');
  assert.equal(normalizeName('Nürnberger Lebkuchen'), 'nuernberger lebkuchen');
});

test('normalizeName: Satzzeichen werden zu Trenn-Whitespace', () => {
  assert.equal(normalizeName('Kit-Kat'), 'kit kat');
  assert.equal(normalizeName('m&m\'s'), 'm m s');
});

test('normalizeName: leer/null robust', () => {
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName(''), '');
});

// ── normalizeNayaxItems: rohe machineProducts -> normalisierte Items ──────────

test('normalizeNayaxItems: rohe Nayax-Feldnamen (MDBCode/PAR/MissingStockByMDB) -> normalisiert + on_hand', () => {
  const raw = [{ MDBCode: '11', Name: 'Snickers', PAR: 10, MissingStockByMDB: 2 }];
  const [item] = normalizeNayaxItems(raw);
  assert.equal(item.mdb_code, 11, 'mdb_code als Number');
  assert.equal(item.product_name, 'Snickers');
  assert.equal(item.par, 10);
  assert.equal(item.missing_mdb, 2);
  assert.equal(item.on_hand, 8, 'on_hand = PAR - MissingStockByMDB');
});

test('normalizeNayaxItems: akzeptiert bereits normalisierte Keys', () => {
  const [item] = normalizeNayaxItems([{ mdb_code: 12, product_name: 'KitKat', par: 8, missing_mdb: 0 }]);
  assert.equal(item.mdb_code, 12);
  assert.equal(item.product_name, 'KitKat');
  assert.equal(item.on_hand, 8);
});

test('normalizeNayaxItems: PAR/Missing sind die Wahrheit, ueberschreiben mitgeliefertes on_hand', () => {
  const [item] = normalizeNayaxItems([{ mdb_code: 1, product_name: 'X', par: 10, missing_mdb: 2, on_hand: 99 }]);
  assert.equal(item.on_hand, 8, 'on_hand wird aus PAR-Missing neu berechnet, nicht uebernommen');
});

test('normalizeNayaxItems: nie DEX verwenden (MissingStockByDEX wird ignoriert)', () => {
  const [item] = normalizeNayaxItems([{ MDBCode: 5, Name: 'Y', PAR: 10, MissingStockByMDB: 1, MissingStockByDEX: 10 }]);
  assert.equal(item.on_hand, 9, 'nur MDB zaehlt, DEX wird ignoriert');
});

test('normalizeNayaxItems: leere/ungueltige Eingabe -> []', () => {
  assert.deepEqual(normalizeNayaxItems([]), []);
  assert.deepEqual(normalizeNayaxItems(undefined), []);
  assert.deepEqual(normalizeNayaxItems(null), []);
});

// ── buildAliasIndex / matchNayaxProduct ──────────────────────────────────────

test('buildAliasIndex + matchNayaxProduct: Nayax-Name -> product_id ueber Aliase', () => {
  const idx = buildAliasIndex([
    { alias: 'Snickers', product_id: 101 },
    { alias: 'Kit Kat', product_id: 102 },
  ]);
  assert.equal(matchNayaxProduct({ product_name: 'snickers' }, idx), 101, 'case-insensitiv');
  assert.equal(matchNayaxProduct({ product_name: 'KIT  KAT' }, idx), 102, 'whitespace-tolerant');
  assert.equal(matchNayaxProduct({ product_name: 'Unbekannt' }, idx), null, 'kein Treffer -> null');
});

test('buildAliasIndex: mehrere Aliase pro Produkt erlaubt (alle mappen)', () => {
  const idx = buildAliasIndex([
    { alias: 'Coca Cola', product_id: 200 },
    { alias: 'Cola', product_id: 200 },
  ]);
  assert.equal(matchNayaxProduct({ product_name: 'Cola' }, idx), 200);
  assert.equal(matchNayaxProduct({ product_name: 'coca cola' }, idx), 200);
});

// ── buildAbgleichDiff: das Herzstueck ────────────────────────────────────────

const PG_SLOTS = [
  { slot_assignment_id: 1, machine_key: '457107528', mdb_code: 11, product_id: 101, product_name: 'Snickers', current_machine_qty: 5, product_slot_key: 'PS_a', target_stock: 10, machine_capacity: 10 },
  { slot_assignment_id: 2, machine_key: '457107528', mdb_code: 12, product_id: 102, product_name: 'KitKat', current_machine_qty: 8, product_slot_key: 'PS_b', target_stock: 10, machine_capacity: 10 },
  { slot_assignment_id: 3, machine_key: '457107528', mdb_code: 13, product_id: 104, product_name: 'Mars', current_machine_qty: 4, product_slot_key: 'PS_c', target_stock: 6, machine_capacity: 6 },
  { slot_assignment_id: 4, machine_key: '457107528', mdb_code: 14, product_id: 105, product_name: 'Bounty', current_machine_qty: 3, product_slot_key: 'PS_d', target_stock: 6, machine_capacity: 6 },
];

const NAYAX_ITEMS = [
  { mdb_code: 11, product_name: 'Snickers', par: 10, missing_mdb: 2, on_hand: 8 },   // Menge 5 -> 8
  { mdb_code: 12, product_name: 'Twix', par: 10, missing_mdb: 1, on_hand: 9 },        // Umbuchung KitKat->Twix, 8 -> 9
  { mdb_code: 13, product_name: 'Mars', par: 6, missing_mdb: 2, on_hand: 4 },         // unveraendert
  { mdb_code: 15, product_name: 'Pringles', par: 8, missing_mdb: 0, on_hand: 8 },     // matched, aber kein PG-Slot -> onboarding
  { mdb_code: 16, product_name: 'Unbekannt XY', par: 5, missing_mdb: 0, on_hand: 5 }, // unmatchbar -> onboarding
];

const ALIAS_INDEX = buildAliasIndex([
  { alias: 'Snickers', product_id: 101 },
  { alias: 'KitKat', product_id: 102 },
  { alias: 'Twix', product_id: 103 },
  { alias: 'Mars', product_id: 104 },
  { alias: 'Bounty', product_id: 105 },
  { alias: 'Pringles', product_id: 106 },
]);

const PRODUCTS_BY_ID = { 101: 'Snickers', 102: 'KitKat', 103: 'Twix', 104: 'Mars', 105: 'Bounty', 106: 'Pringles' };

function diff() {
  return buildAbgleichDiff(PG_SLOTS, NAYAX_ITEMS, ALIAS_INDEX, { machineId: '457107528', productsById: PRODUCTS_BY_ID });
}

test('buildAbgleichDiff: Produktwechsel im Slot -> assignment_change (Umbuchung alt->neu)', () => {
  const d = diff();
  assert.equal(d.assignment_changes.length, 1);
  const c = d.assignment_changes[0];
  assert.equal(c.mdb_code, 12);
  assert.equal(c.old_product_id, 102);
  assert.equal(c.old_product_name, 'KitKat');
  assert.equal(c.new_product_id, 103);
  assert.equal(c.new_product_name, 'Twix', 'neuer Name aus productsById aufgeloest');
  assert.equal(c.old_qty, 8);
  assert.equal(c.new_qty, 9);
});

test('buildAbgleichDiff: gleiches Produkt, andere Menge -> qty_change (Menge alt->neu)', () => {
  const d = diff();
  assert.equal(d.qty_changes.length, 1);
  const q = d.qty_changes[0];
  assert.equal(q.mdb_code, 11);
  assert.equal(q.product_id, 101);
  assert.equal(q.old_qty, 5);
  assert.equal(q.new_qty, 8);
  assert.equal(q.diff, 3);
});

test('buildAbgleichDiff: identischer Slot -> unchanged, nicht in Aenderungen', () => {
  const d = diff();
  assert.equal(d.unchanged.length, 1);
  assert.equal(d.unchanged[0].mdb_code, 13);
});

test('buildAbgleichDiff: unmatchbarer Nayax-Name -> onboarding (kein_match), kein Schreiben', () => {
  const d = diff();
  const ob = d.onboarding.find((o) => o.mdb_code === 16);
  assert.ok(ob, 'mdb 16 muss in onboarding sein');
  assert.equal(ob.product_name, 'Unbekannt XY');
  assert.equal(ob.product_id, null);
  assert.equal(ob.reason, 'kein_match');
  assert.equal(ob.on_hand, 5);
});

test('buildAbgleichDiff: Nayax-Slot ohne PG-Pendant (matched) -> onboarding (kein_pg_slot)', () => {
  const d = diff();
  const ob = d.onboarding.find((o) => o.mdb_code === 15);
  assert.ok(ob, 'mdb 15 muss in onboarding sein');
  assert.equal(ob.product_id, 106);
  assert.equal(ob.reason, 'kein_pg_slot');
});

test('buildAbgleichDiff: PG-Slot ohne Nayax-Pendant -> pg_only_slots (melden, nicht loeschen)', () => {
  const d = diff();
  assert.equal(d.pg_only_slots.length, 1);
  assert.equal(d.pg_only_slots[0].mdb_code, 14);
  assert.equal(d.pg_only_slots[0].product_id, 105);
});

test('buildAbgleichDiff: summary zaehlt korrekt', () => {
  const d = diff();
  assert.equal(d.machine_id, '457107528');
  assert.equal(d.summary.n_assignment_changes, 1);
  assert.equal(d.summary.n_qty_changes, 1);
  assert.equal(d.summary.n_onboarding, 2);
  assert.equal(d.summary.n_pg_only, 1);
  assert.equal(d.summary.n_unchanged, 1);
});

test('buildAbgleichDiff: leere Nayax-Daten -> keine Aenderungen, alle PG-Slots als pg_only', () => {
  const d = buildAbgleichDiff(PG_SLOTS, [], ALIAS_INDEX, { machineId: '457107528' });
  assert.equal(d.assignment_changes.length, 0);
  assert.equal(d.qty_changes.length, 0);
  assert.equal(d.pg_only_slots.length, 4);
});

test('buildAbgleichDiff: leere PG-Slots -> alle matchbaren Nayax-Items als onboarding (neu)', () => {
  const d = buildAbgleichDiff([], NAYAX_ITEMS, ALIAS_INDEX, { machineId: '457107528' });
  assert.equal(d.assignment_changes.length, 0);
  assert.equal(d.qty_changes.length, 0);
  assert.ok(d.onboarding.length >= 4, 'alle Nayax-Slots ohne PG-Pendant landen in onboarding');
});

test('buildAbgleichDiff: ohne productsById faellt new_product_name auf Nayax-Name zurueck', () => {
  const d = buildAbgleichDiff(PG_SLOTS, NAYAX_ITEMS, ALIAS_INDEX, { machineId: '457107528' });
  const c = d.assignment_changes[0];
  assert.equal(c.new_product_name, 'Twix');
});

// ── buildApplyPlan: nur Umbuchungen + Mengen, ohne onboarding/pg_only ─────────

test('buildApplyPlan: erzeugt Operationen nur fuer Umbuchungen und Mengenaenderungen', () => {
  const plan = buildApplyPlan(diff());
  assert.equal(plan.operations.length, 2, 'genau Umbuchung(12) + Menge(11), kein onboarding');
  const reassign = plan.operations.find((o) => o.type === 'reassign');
  const setQty = plan.operations.find((o) => o.type === 'set_qty');
  assert.ok(reassign && setQty);
  assert.equal(reassign.mdb_code, 12);
  assert.equal(reassign.old_product_id, 102);
  assert.equal(reassign.new_product_id, 103);
  assert.equal(reassign.new_qty, 9);
  assert.equal(setQty.mdb_code, 11);
  assert.equal(setQty.product_id, 101);
  assert.equal(setQty.new_qty, 8);
});

test('buildApplyPlan: onboarding-/pg_only-Slots werden NIE in den Schreibplan aufgenommen', () => {
  const plan = buildApplyPlan(diff());
  const mdbs = plan.operations.map((o) => o.mdb_code);
  assert.ok(!mdbs.includes(15), 'kein_pg_slot wird uebersprungen');
  assert.ok(!mdbs.includes(16), 'kein_match wird uebersprungen');
  assert.ok(!mdbs.includes(14), 'pg_only wird uebersprungen');
});

test('buildApplyPlan: Guard = Anzahl Aenderungen + Summe der Soll-Mengen', () => {
  const plan = buildApplyPlan(diff());
  assert.equal(plan.guard.expected_changes, 2);
  assert.equal(plan.guard.expected_qty_sum, 17, '9 (Umbuchung) + 8 (Menge)');
  assert.equal(plan.machine_id, '457107528');
});

test('buildApplyPlan: jede Operation hat einen deterministischen, idempotenten op_key', () => {
  const plan1 = buildApplyPlan(diff());
  const plan2 = buildApplyPlan(diff());
  assert.deepEqual(plan1.operations.map((o) => o.op_key), plan2.operations.map((o) => o.op_key));
  assert.ok(plan1.operations.every((o) => typeof o.op_key === 'string' && o.op_key.length > 0));
});

// ── validateAbgleichApply: Guard gegen leere/ungueltige Applies ───────────────

test('validateAbgleichApply: akzeptiert gueltigen Plan', () => {
  const r = validateAbgleichApply({ machine_id: '457107528', operations: [{ type: 'set_qty', mdb_code: 11 }] });
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
});

test('validateAbgleichApply: fehlende machine_id -> ungueltig', () => {
  const r = validateAbgleichApply({ operations: [{ type: 'set_qty' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.field === 'machine_id'));
});

test('validateAbgleichApply: leerer Plan (nichts abzugleichen) -> ungueltig', () => {
  const r = validateAbgleichApply({ machine_id: '457107528', operations: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.field === 'operations'));
});

// ── Payloads: preview + apply ────────────────────────────────────────────────

test('buildAbgleichPreviewPayload: mode=preview + machine_id', () => {
  const p = buildAbgleichPreviewPayload('457107528');
  assert.equal(p.mode, 'preview');
  assert.equal(p.machine_id, '457107528');
});

test('buildAbgleichApplyPayload: mode=apply, traegt Plan + Guard + triggered_by', () => {
  const plan = buildApplyPlan(diff());
  const p = buildAbgleichApplyPayload(plan, { triggered_by: 'admin@example.test' });
  assert.equal(p.mode, 'apply');
  assert.equal(p.machine_id, '457107528');
  assert.deepEqual(p.guard, plan.guard);
  assert.equal(p.operations.length, 2);
  assert.equal(p.triggered_by, 'admin@example.test');
});

test('buildAbgleichApplyPayload: idempotenter abgleich_key (gleicher Plan -> gleicher Key)', () => {
  const p1 = buildAbgleichApplyPayload(buildApplyPlan(diff()), { triggered_by: 'a' });
  const p2 = buildAbgleichApplyPayload(buildApplyPlan(diff()), { triggered_by: 'a' });
  assert.ok(typeof p1.abgleich_key === 'string' && p1.abgleich_key.length > 0);
  assert.equal(p1.abgleich_key, p2.abgleich_key);
});

// ── Audit ────────────────────────────────────────────────────────────────────

test('buildAbgleichAuditEntry: enthaelt viewer-login, timestamp, Ergebnis', () => {
  const viewer = { login: 'admin@example.test', canTriggerActions: true };
  const payload = buildAbgleichApplyPayload(buildApplyPlan(diff()), { triggered_by: 'admin@example.test' });
  const result = { ok: true, status_ref: 'abgl-123', message: 'ok' };
  const entry = buildAbgleichAuditEntry(viewer, payload, result);
  assert.equal(entry.triggered_by, 'admin@example.test');
  assert.ok(typeof entry.triggered_at === 'string');
  assert.equal(entry.machine_id, '457107528');
  assert.equal(entry.ok, true);
  assert.equal(entry.status_ref, 'abgl-123');
  assert.ok(entry.abgleich_key);
  assert.equal(entry.n_operations, 2);
});

// ── Query-Builder: parametrisch + schema-qualifiziert (Drift-Guard) ───────────

test('buildActiveSlotsQuery: joint noetige Tabellen, schema-qualifiziert, nur aktive', () => {
  const q = buildActiveSlotsQuery({ machineKey: '457107528' });
  const text = typeof q === 'string' ? q : q.text;
  for (const rel of ['slot_assignments', 'products', 'machines']) {
    assert.ok(text.includes(`automatenlager.${rel}`), `Query muss automatenlager.${rel} joinen`);
  }
  assert.ok(/\bactive\b/.test(text), 'nur aktive Slots');
});

test('buildActiveSlotsQuery: machine_key parametrisch ($1), kein Hardcode', () => {
  const q = buildActiveSlotsQuery({ machineKey: '457107528' });
  assert.ok(typeof q === 'object' && Array.isArray(q.values));
  assert.ok(!q.text.includes('457107528'), 'kein Hardcode der Nayax-Nummer');
  assert.deepEqual(q.values, ['457107528']);
  assert.ok(/\$1/.test(q.text));
});

test('buildNayaxAliasesQuery: schema-qualifiziert, filtert source=nayax', () => {
  const q = buildNayaxAliasesQuery();
  const text = typeof q === 'string' ? q : q.text;
  assert.ok(text.includes('automatenlager.product_aliases'));
  assert.ok(/nayax/.test(text), 'filtert auf source nayax');
  assert.ok(/\balias\b/.test(text));
  assert.ok(/\bproduct_id\b/.test(text));
});

test('buildProductsByIdQuery: schema-qualifiziert, liefert product_id + name', () => {
  const q = buildProductsByIdQuery();
  const text = typeof q === 'string' ? q : q.text;
  assert.ok(text.includes('automatenlager.products'));
  assert.ok(/\bproduct_id\b/.test(text));
  assert.ok(/\bname\b/.test(text));
});

// ── HTTP-Endpunkte: preview (read-only) + apply (admin-only) ──────────────────

const http = require('node:http');
const { spawn } = require('node:child_process');

function getFreePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET';
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: opts.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function startDashboard(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      N8N_BASE_URL: 'http://127.0.0.1:9',
      N8N_API_KEY: 'test-key',
      DASHBOARD_V2_PG_URL: '',
      DASHBOARD_ADMIN_LOGIN: 'admin@example.test',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server timeout')); }, 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) { clearTimeout(timeout); resolve(child); }
    });
    child.stderr.resume();
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Exit ${code}`)); } });
  });
}

test('Endpoint: GET /api/v2/nayax-abgleich/preview ohne machine -> 400', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/preview');
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MISSING_PARAMS');
  } finally { child.kill(); }
});

test('Endpoint: GET /api/v2/nayax-abgleich/preview ohne PG -> 503 PG_UNCONFIGURED', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/preview?machine=457107528');
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
  } finally { child.kill(); }
});

test('Endpoint: POST /api/v2/nayax-abgleich/apply -> 403 fuer Gast', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'guest@example.test' },
      body: JSON.stringify({ machine: '457107528' }),
    });
    assert.equal(res.status, 403);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'READ_ONLY_FORBIDDEN');
  } finally { child.kill(); }
});

test('Endpoint: POST /api/v2/nayax-abgleich/apply (Admin) ohne machine -> 400', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MISSING_FIELDS');
  } finally { child.kill(); }
});

test('Endpoint: POST /api/v2/nayax-abgleich/apply (Admin, machine, kein PG) -> 503', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port, { DASHBOARD_ADMIN_LOGIN: 'admin@example.test' });
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'admin@example.test' },
      body: JSON.stringify({ machine: '457107528' }),
    });
    assert.equal(res.status, 503);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'PG_UNCONFIGURED');
  } finally { child.kill(); }
});

test('Endpoint: kein Roh-Schreibpfad (PUT /api/v2/nayax-abgleich/raw -> 404)', async () => {
  const port = await getFreePort();
  const child = await startDashboard(port);
  try {
    const res = await request(port, '/api/v2/nayax-abgleich/raw', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
  } finally { child.kill(); }
});
