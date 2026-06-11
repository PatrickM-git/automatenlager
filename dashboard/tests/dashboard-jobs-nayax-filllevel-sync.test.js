'use strict';

/**
 * Live-Füllstand-Sync (Issue #222) — Worker-Job `nayax-filllevel-sync`.
 *
 * Schreibt alle ~5 Min `slot_assignments.current_machine_qty` aus Nayax fort —
 * NUR Mengen (`diff.qty_changes`), NIEMALS Slot-Umbelegungen
 * (`diff.assignment_changes` werden nur gezählt/gemeldet).
 *
 * KRITISCH (verifiziert gegen lib/nayax-abgleich.js): der bestehende
 * buildSlotAssignmentEvents-Pfad macht selbst für reine Mengen close+open
 * (neue slot_assignments-Zeile pro Lauf) — der Job nutzt stattdessen ein
 * DIREKTES UPDATE der aktiven Zuordnung durch die Mandanten-Tür (db.tx).
 *
 * Ebenen: (1) Factory/Skip-Pfade offline; (2) LIVE im #94-Sandbox-Harness
 * (ROLLBACK) mit injiziertem Nayax-Fetch (fetchImpl — kein echter API-Call).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createNayaxFillLevelSyncJob,
  runFillLevelSync,
  applyFillLevelForMachine,
  listActiveMachineKeys,
  FILL_LEVEL_SYNC_JOB_KEY,
} = require('../lib/jobs/nayax-filllevel-sync.js');
const { normalizeNayaxItems } = require('../lib/nayax-abgleich.js');
const { inSandbox } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

// ── Test-Hilfen ──────────────────────────────────────────────────────────────

// Injizierbarer Nayax-Fetch: beantwortet machineProducts je machine_key,
// protokolliert alle URLs (für die withDetails:false-Effizienz-Assertion).
function fakeNayaxFetch(itemsByMachine) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const m = /\/machines\/([^/]+)\/machineProducts$/.exec(String(url));
    if (m) {
      const items = itemsByMachine[decodeURIComponent(m[1])] || [];
      return { ok: true, status: 200, json: async () => items };
    }
    // Produkt-Detail-Calls dürfen bei withDetails:false NIE passieren.
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { impl, calls };
}

// Fixture-Erweiterung auf dem Sandbox-Client: zweites Produkt + zweiter Slot
// (mdb 11) auf vm_acme + nayax_id-Aliase für beide Produkte. So ist ein Diff
// mit qty_changes UND assignment_changes im selben Lauf baubar.
async function seedSecondSlotAndAliases(client, acme) {
  const p2 = await client.query(
    `INSERT INTO automatenlager.products (product_key, name, category, vat_rate_pct, tenant_id)
       VALUES ('p_acme_b', 'Acme B', 'snack', 19, 'acme') RETURNING product_id`);
  const productBId = p2.rows[0].product_id;
  const s2 = await client.query(
    `INSERT INTO automatenlager.slot_assignments
       (product_slot_key, machine_id, mdb_code, product_id, valid_from, active, current_machine_qty, tenant_id)
       VALUES ('slot_acme_b', $1, 11, $2, '2026-01-01', TRUE, 3, 'acme')
       RETURNING slot_assignment_id`,
    [acme.machineId, productBId]);
  await client.query(
    `INSERT INTO automatenlager.product_aliases (product_id, alias, source, is_primary, tenant_id)
       VALUES ($1, 'nx_a', 'nayax_id', TRUE, 'acme'), ($2, 'nx_b', 'nayax_id', TRUE, 'acme')`,
    [acme.productId, productBId]);
  return { productBId, slotBId: s2.rows[0].slot_assignment_id };
}

async function slotByKey(db, tenant, key) {
  const res = await db.read({
    tenant,
    tables: ['slot_assignments'],
    text: `SELECT slot_assignment_id, product_id, product_slot_key, active, current_machine_qty
             FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = $2`,
    params: [key],
  });
  return res.rows[0];
}

async function slotCount(db, tenant) {
  const res = await db.read({
    tenant,
    tables: ['slot_assignments'],
    text: `SELECT count(*)::int AS n FROM automatenlager.slot_assignments WHERE tenant_id = $1`,
  });
  return res.rows[0].n;
}

// ── Ebene 1: Factory + Skip-Pfade (offline) ──────────────────────────────────

test('#222 Factory: wirft ohne db (Mandanten-Tür)', () => {
  assert.throws(() => createNayaxFillLevelSyncJob({}), /db/);
  const job = createNayaxFillLevelSyncJob({ db: {}, env: {} });
  assert.equal(job.key, FILL_LEVEL_SYNC_JOB_KEY);
  assert.equal(typeof job.run, 'function');
});

test('#222 run: ohne NAYAX_API_TOKEN ⇒ skip (kein DB-/Netz-Zugriff)', async () => {
  const job = createNayaxFillLevelSyncJob({ db: {}, env: {} });
  const res = await job.run();
  assert.match(String(res.skipped), /NAYAX_API_TOKEN/);
});

test('#222 run: ohne eindeutigen Mandanten ⇒ skip (fail-closed)', async () => {
  const directory = { listTenantIds: () => ['acme', 'globex'] }; // mehrdeutig
  const job = createNayaxFillLevelSyncJob({ db: {}, directory, env: { NAYAX_API_TOKEN: 'T' } });
  const res = await job.run();
  assert.match(String(res.skipped), /Mandant/);
});

// ── Ebene 2: LIVE im Sandbox-Harness (ROLLBACK) ──────────────────────────────

test('#222 KERN-SICHERHEITSTEST LIVE: Diff mit qty_changes UND assignment_changes ⇒ NUR Menge geschrieben, Slot-Belegung unangetastet, KEINE neue Zeile', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    const { productBId } = await seedSecondSlotAndAliases(client, acme);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const before = await slotByKey(db, 'acme', 'slot_acme');
    const beforeB = await slotByKey(db, 'acme', 'slot_acme_b');
    const rowsBefore = await slotCount(db, 'acme');

    // Nayax meldet: mdb 10 = gleiches Produkt (nx_a), neue Menge 8 (PAR 10 - missing 2)
    //               mdb 11 = ANDERES Produkt (nx_a statt p_acme_b) ⇒ Umbelegung (NICHT anfassen)
    const { impl } = fakeNayaxFetch({
      vm_acme: [
        { MDBCode: 10, PAR: 10, MissingStockByMDB: 2, NayaxProductID: 'nx_a' },
        { MDBCode: 11, PAR: 6, MissingStockByMDB: 1, NayaxProductID: 'nx_a' },
      ],
    });

    const res = await runFillLevelSync(db, 'acme', { token: 'T', fetchImpl: impl });
    assert.equal(res.errors.length, 0, `keine Fehler: ${JSON.stringify(res.errors)}`);
    assert.equal(res.qtyApplied, 1, 'genau EINE Menge angewandt');
    assert.equal(res.reassignsSkipped, 1, 'Umbelegung gezählt, nicht geschrieben');

    // Menge auf DERSELBEN Zuordnung aktualisiert (direktes UPDATE, kein close/open)
    const after = await slotByKey(db, 'acme', 'slot_acme');
    assert.equal(Number(after.current_machine_qty), 8, 'current_machine_qty = PAR - MissingStockByMDB');
    assert.equal(String(after.slot_assignment_id), String(before.slot_assignment_id), 'gleiche slot_assignment_id');
    assert.equal(String(after.product_id), String(before.product_id), 'Produkt unverändert');
    assert.equal(after.active, true, 'Zuordnung bleibt aktiv');

    // Slot mit gemeldeter Umbelegung KOMPLETT unverändert (Menge UND Produkt)
    const afterB = await slotByKey(db, 'acme', 'slot_acme_b');
    assert.equal(String(afterB.product_id), String(productBId), 'Slot-Belegung (product_id) unverändert');
    assert.equal(Number(afterB.current_machine_qty), Number(beforeB.current_machine_qty), 'Menge des Umbelegungs-Slots unverändert');
    assert.equal(afterB.active, true);

    // KEINE neue slot_assignments-Zeile (keine History-Wucherung)
    const rowsAfter = await slotCount(db, 'acme');
    assert.equal(rowsAfter, rowsBefore, 'Zeilenzahl slot_assignments unverändert');
  });
});

test('#222 LIVE: Idempotenz — zweiter Lauf ohne neue Nayax-Änderung ist wirkungslos', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await seedSecondSlotAndAliases(client, acme);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const items = {
      vm_acme: [{ MDBCode: 10, PAR: 10, MissingStockByMDB: 2, NayaxProductID: 'nx_a' }],
    };
    const first = await runFillLevelSync(db, 'acme', { token: 'T', fetchImpl: fakeNayaxFetch(items).impl });
    assert.equal(first.qtyApplied, 1, 'erster Lauf wendet die Menge an');

    const second = await runFillLevelSync(db, 'acme', { token: 'T', fetchImpl: fakeNayaxFetch(items).impl });
    assert.equal(second.qtyApplied, 0, 'zweiter Lauf: Menge bereits gleich ⇒ kein UPDATE');
    assert.equal(second.errors.length, 0);

    const after = await slotByKey(db, 'acme', 'slot_acme');
    assert.equal(Number(after.current_machine_qty), 8);
  });
});

test('#222 LIVE: acme/globex-Isolation — Lauf für acme ändert keine globex-Mengen und fetcht nur acme-Maschinen', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await seedSecondSlotAndAliases(client, acme);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const globexBefore = await slotByKey(db, 'globex', 'slot_globex');

    // Antwort enthält bewusst auch mdb 10 — globex' Slot hat denselben mdb_code.
    const { impl, calls } = fakeNayaxFetch({
      vm_acme: [{ MDBCode: 10, PAR: 10, MissingStockByMDB: 2, NayaxProductID: 'nx_a' }],
      vm_globex: [{ MDBCode: 10, PAR: 99, MissingStockByMDB: 0, NayaxProductID: 'nx_a' }],
    });
    const res = await runFillLevelSync(db, 'acme', { token: 'T', fetchImpl: impl });
    assert.equal(res.qtyApplied, 1);

    // Nur die acme-Maschine wurde überhaupt abgefragt (tenant-scoped Enumeration).
    assert.ok(calls.every((u) => !u.includes('vm_globex')), 'vm_globex wird für acme NICHT gefetcht');

    // globex' Menge unverändert (Seed: 5)
    const globexAfter = await slotByKey(db, 'globex', 'slot_globex');
    assert.equal(Number(globexAfter.current_machine_qty), Number(globexBefore.current_machine_qty), 'globex-Menge unangetastet');
  });
});

test('#222 LIVE: Effizienz — Nayax wird mit withDetails:false geholt (1 Call/Maschine, keine Produkt-Detail-Calls)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    await seedSecondSlotAndAliases(client, acme);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const { impl, calls } = fakeNayaxFetch({
      vm_acme: [{ MDBCode: 10, PAR: 10, MissingStockByMDB: 2, NayaxProductID: 'nx_a' }],
    });
    await runFillLevelSync(db, 'acme', { token: 'T', fetchImpl: impl });

    assert.equal(calls.length, 1, 'genau EIN Nayax-Call pro Maschine/Lauf');
    assert.ok(/\/machines\/vm_acme\/machineProducts$/.test(calls[0]));
    assert.ok(calls.every((u) => !u.includes('/operational/v1/products/')), 'keine Detail-Calls (withDetails:false)');
  });
});

test('#222 LIVE: DEXProductName-Fallback — Item ohne NayaxProductID matcht über den Produktnamen (keine nayax_id-Alias-Pflicht)', async (t) => {
  await inSandbox(t, async (client) => {
    await seedAcmeGlobex(client); // Produktname 'Cola acme'
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // Roh-Item OHNE ProductName/NayaxProductID — nur DEXProductName (so liefert
    // Nayax machineProducts ohne Detail-Anreicherung). Muss über den
    // normalisierten products.name-Fallback matchen.
    const { impl } = fakeNayaxFetch({
      vm_acme: [{ MDBCode: 10, PAR: 9, MissingStockByMDB: 2, DEXProductName: 'Cola acme' }],
    });
    const res = await runFillLevelSync(db, 'acme', { token: 'T', fetchImpl: impl });
    assert.equal(res.errors.length, 0);
    assert.equal(res.qtyApplied, 1, 'Menge über DEX-Namen-Match angewandt');

    const after = await slotByKey(db, 'acme', 'slot_acme');
    assert.equal(Number(after.current_machine_qty), 7);
  });
});

test('#222 LIVE: Maschinen-Enumeration — nur aktive Maschinen MIT aktiven Slots des Mandanten', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    // Zweite Maschine OHNE aktive Slots + dritte INAKTIVE Maschine mit Slot.
    await client.query(
      `INSERT INTO automatenlager.machines (machine_key, name, location_id, tenant_id)
         VALUES ('vm_acme_leer', 'Leer', $1, 'acme')`, [acme.locationId]);
    const m3 = await client.query(
      `INSERT INTO automatenlager.machines (machine_key, name, location_id, active, tenant_id)
         VALUES ('vm_acme_aus', 'Aus', $1, FALSE, 'acme') RETURNING machine_id`, [acme.locationId]);
    await client.query(
      `INSERT INTO automatenlager.slot_assignments
         (product_slot_key, machine_id, mdb_code, product_id, valid_from, active, current_machine_qty, tenant_id)
         VALUES ('slot_acme_aus', $1, 10, $2, '2026-01-01', TRUE, 1, 'acme')`,
      [m3.rows[0].machine_id, acme.productId]);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const keys = await listActiveMachineKeys(db, 'acme');
    assert.deepEqual(keys, ['vm_acme'], 'nur die aktive Maschine mit aktiven Slots');
  });
});

test('#222 LIVE: applyFillLevelForMachine schreibt qty_changes per direktem UPDATE nur auf AKTIVE Zuordnungen', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const items = normalizeNayaxItems([
      { MDBCode: 10, PAR: 10, MissingStockByMDB: 4, ProductName: 'Cola acme' },
    ]);
    const res = await applyFillLevelForMachine(db, 'acme', 'vm_acme', items);
    assert.equal(res.qtyApplied, 1);
    assert.equal(res.reassignsSkipped, 0);

    const after = await slotByKey(db, 'acme', 'slot_acme');
    assert.equal(Number(after.current_machine_qty), 6);
    assert.equal(String(after.product_id), String(acme.productId));
  });
});
