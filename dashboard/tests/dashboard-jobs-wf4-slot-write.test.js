'use strict';

/**
 * WF4 Slot-Write (MDB/Produktzuordnung) — In-Process-Port (Issue #163, Stufe 6 Slice 3).
 * Autorität für aktive Slot-Zuordnungen: alte Zeilen schließen / neue öffnen
 * (valid_from/to, active), transaktional durch die Tür (db.tx) — faithful zur
 * pgw_write `slot_assignment`-Semantik (ON CONFLICT product_slot_key DO UPDATE).
 *
 * Ebenen: (1) reine buildSlotLifecycleEvents; (2) Live applySlotAssignmentEvents
 * durch die Tür (acme/globex-Isolation, close+open).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const wf4 = require('../lib/jobs/wf4-slot-write.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T08:00:00.000Z';

// ── Ebene 1: buildSlotLifecycleEvents ────────────────────────────────────────
test('#163 buildSlotLifecycleEvents: closeRows→active=false+valid_to; newRows→active=true; filtert unvollständige Zeilen', () => {
  const events = wf4.buildSlotLifecycleEvents({
    closeRows: [{ product_slot_id: 'S1', machine_id: 'M1', product_key: 'P1', mdb_code: '10', active: 'FALSE', valid_to: NOW, notes: 'alt zu' }],
    newRows: [{ product_slot_id: 'S2', machine_id: 'M1', product_key: 'P1', mdb_code: '11', active: 'TRUE', valid_from: NOW, current_machine_qty: 8 }],
    baseRowUpdates: [{ product_slot_id: '', machine_id: 'M1', product_key: 'P1' }], // unvollständig → raus
  }, { nowIso: NOW });

  assert.equal(events.length, 2, 'unvollständige Zeile gefiltert');
  const close = events.find((e) => e.data.product_slot_key === 'S1');
  assert.equal(close.event_type, 'slot_assignment');
  assert.equal(close.data.active, false);
  assert.equal(close.data.valid_to, NOW);
  const open = events.find((e) => e.data.product_slot_key === 'S2');
  assert.equal(open.data.active, true);
  assert.equal(open.data.current_machine_qty, 8);
  assert.equal(open.data.mdb_code, 11);
});

// ── Ebene 2: Live applySlotAssignmentEvents durch die Tür ────────────────────
test('#163 applySlotAssignmentEvents LIVE: schließt alten Slot + öffnet neuen durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    // Seed: 'slot_acme' aktiv (valid_to NULL). Wechsel: alten schließen + neuen 'slot_acme_v2' öffnen.
    const events = wf4.buildSlotLifecycleEvents({
      closeRows: [{ product_slot_id: 'slot_acme', machine_id: 'vm_acme', product_key: 'p_acme', mdb_code: '10', active: 'FALSE', valid_to: NOW, notes: 'WF4: alte Zuordnung geschlossen' }],
      newRows: [{ product_slot_id: 'slot_acme_v2', machine_id: 'vm_acme', product_key: 'p_acme', mdb_code: '11', active: 'TRUE', valid_from: NOW, current_machine_qty: 8, notes: 'WF4: neue Zuordnung' }],
    }, { nowIso: NOW });

    const res = await wf4.applySlotAssignmentEvents(db, 'acme', { events, nowIso: NOW });
    assert.equal(res.upserts, 2, 'beide Slot-Events angewandt');

    // alter Slot geschlossen
    const old = await db.read({
      tenant: 'acme', tables: ['slot_assignments'],
      text: `SELECT active, valid_to FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_acme'`,
    });
    assert.equal(old.rows[0].active, false, 'alter Slot inaktiv');
    assert.ok(old.rows[0].valid_to, 'valid_to gesetzt');

    // neuer Slot offen, Menge per INSERT gesetzt
    const neu = await db.read({
      tenant: 'acme', tables: ['slot_assignments'],
      text: `SELECT active, current_machine_qty, mdb_code FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_acme_v2'`,
    });
    assert.equal(neu.rows.length, 1, 'neuer Slot existiert');
    assert.equal(neu.rows[0].active, true);
    assert.equal(Number(neu.rows[0].current_machine_qty), 8);
    assert.equal(Number(neu.rows[0].mdb_code), 11);

    // ISOLATION: globex-Slot unverändert (immer noch aktiv, kein _v2)
    const gOld = await db.read({
      tenant: 'globex', tables: ['slot_assignments'],
      text: `SELECT active FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_globex'`,
    });
    assert.equal(gOld.rows[0].active, true, 'globex-Slot unangetastet');
    const gNew = await db.read({
      tenant: 'globex', tables: ['slot_assignments'],
      text: `SELECT count(*)::int AS n FROM automatenlager.slot_assignments WHERE tenant_id = $1 AND product_slot_key = 'slot_acme_v2'`,
    });
    assert.equal(gNew.rows[0].n, 0, 'globex sieht acme-Slot nicht');
  });
});

// ── Ebene 2: Warnungen mitschreiben ──────────────────────────────────────────
test('#163 applySlotAssignmentEvents LIVE: schreibt WF4-Warnungen mit deterministischem Schlüssel (idempotent)', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme } = await seedAcmeGlobex(client);
    for (const n of [22, 23, 24, 25, 26]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const warnings = [{ type: 'MDB_PRODUCT_MAPPING_MISMATCH', severity: 'warning', machine_id: 'vm_acme', product_key: 'p_acme', message: 'WF4 Test-Warnung' }];
    const r1 = await wf4.applySlotAssignmentEvents(db, 'acme', { events: [], warnings, nowIso: NOW });
    assert.equal(r1.warningsWritten, 1, 'Warnung geschrieben');
    const r2 = await wf4.applySlotAssignmentEvents(db, 'acme', { events: [], warnings, nowIso: NOW });
    assert.equal(r2.warningsWritten, 0, 'idempotent (gleicher warning_key, ON CONFLICT DO NOTHING)');
  });
});
