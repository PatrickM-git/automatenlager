'use strict';

// DoD (f) fuer Issue #17: Der apply-SCHREIBPFAD wird gegen das ECHTE
// automatenlager.pgw_write verifiziert — OHNE jede reale Mutation, in EINER
// Transaktion mit erzwungenem ROLLBACK. pgw_write ist plpgsql ohne
// COMMIT/dblink/autonomous (live geprueft) -> ROLLBACK macht alle Effekte
// rueckgaengig. Skip, wenn PG offline (CI), laeuft live ueber den SSH-Tunnel.
//
// Verifiziert: close(alte Zuordnung)=active=false+valid_to, open(neue)=neuer
// product_slot_key mit Zielprodukt UND current_machine_qty per INSERT gesetzt;
// nach ROLLBACK ist der Originalzustand vollstaendig wiederhergestellt.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildApplyPlan,
  buildSlotAssignmentEvents,
  validateAbgleichApply,
} = require('../lib/nayax-abgleich.js');

const ROOT_DIR = path.join(__dirname, '..');

function resolvePgUrlForTest() {
  const fromEnv = process.env.DASHBOARD_V2_PG_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const files = [path.join(ROOT_DIR, '..', '.env.local'), path.join(ROOT_DIR, '.env.local')];
  const merged = {};
  for (const fp of files) {
    let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      merged[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return (merged.DASHBOARD_V2_PG_URL || merged.POSTGRES_URL || merged.DATABASE_URL || '').trim();
}

// ── Guard-Test (kein DB): nichts Schreibbares -> kein Event, Apply ungueltig ──

test('Guard: Onboarding-/PG-only-Diff erzeugt keinen Schreibplan und keine Events', () => {
  const diff = {
    machine_id: '457107528',
    assignment_changes: [],
    qty_changes: [],
    onboarding: [{ mdb_code: 16, product_name: 'Neu', product_id: null, on_hand: 5, reason: 'kein_match' }],
    pg_only_slots: [{ mdb_code: 14, product_id: 105, product_name: 'Bounty', current_machine_qty: 3 }],
  };
  const plan = buildApplyPlan(diff);
  assert.equal(plan.operations.length, 0, 'kein Schreibplan');
  assert.deepEqual(buildSlotAssignmentEvents(plan, { machineKey: '457107528' }), [], 'keine Events');
  assert.equal(validateAbgleichApply({ machine_id: '457107528', operations: plan.operations }).valid, false,
    'leerer Plan -> Apply ungueltig (nichts wird geschrieben)');
});

// ── LIVE-Rollback-Test: echter Schreibpfad, garantiert ohne Mutation ─────────

test('LIVE: apply-Schreibpfad via echtes pgw_write — close+open, erzwungener ROLLBACK (skip offline)', async (t) => {
  const pgUrl = resolvePgUrlForTest();
  if (!pgUrl) { t.skip('Kein DASHBOARD_V2_PG_URL — Rollback-Test uebersprungen.'); return; }
  let Client;
  try { ({ Client } = require('pg')); } catch { t.skip('pg nicht installiert.'); return; }

  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 4000 });
  try { await client.connect(); } catch (err) { t.skip(`PG nicht erreichbar (${err.code || err.message}).`); return; }

  try {
    // Realen aktiven Slot + ein anderes reales Produkt waehlen (parametrisch).
    const slotRes = await client.query(
      `SELECT sa.mdb_code, sa.product_id, p.product_key, sa.current_machine_qty,
              sa.product_slot_key, sa.target_stock, sa.machine_capacity, m.machine_key
         FROM automatenlager.slot_assignments sa
         JOIN automatenlager.products p ON p.product_id = sa.product_id
         JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
        WHERE sa.active = TRUE AND p.product_key IS NOT NULL
        ORDER BY sa.mdb_code LIMIT 1`);
    if (!slotRes.rows.length) { t.skip('Keine aktiven Slots fuer den Test.'); return; }
    const slot = slotRes.rows[0];
    const machineKey = String(slot.machine_key);
    const otherRes = await client.query(
      `SELECT product_id, product_key FROM automatenlager.products
        WHERE product_id <> $1 AND product_key IS NOT NULL ORDER BY product_id LIMIT 1`, [slot.product_id]);
    if (!otherRes.rows.length) { t.skip('Kein zweites Produkt fuer den Umbuchungstest.'); return; }
    const other = otherRes.rows[0];

    const targetQty = (Number(slot.current_machine_qty) || 0) + 1;
    const plan = buildApplyPlan({
      machine_id: machineKey,
      assignment_changes: [{
        mdb_code: Number(slot.mdb_code), slot_assignment_id: 0, product_slot_key: slot.product_slot_key,
        old_product_id: Number(slot.product_id), old_product_key: slot.product_key,
        new_product_id: Number(other.product_id), new_product_name: other.product_key,
        old_qty: Number(slot.current_machine_qty), new_qty: targetQty,
        target_stock: slot.target_stock, machine_capacity: slot.machine_capacity,
      }],
      qty_changes: [],
    });
    const events = buildSlotAssignmentEvents(plan, {
      machineKey, nowIso: '2026-05-31T23:59:59.000Z', batchRunId: 'abgl_rollbacktest',
      productKeyById: { [other.product_id]: other.product_key, [slot.product_id]: slot.product_key },
    });
    assert.equal(events.length, 2, 'close + open');

    await client.query('BEGIN');
    try {
      for (const e of events) {
        const r = await client.query('SELECT automatenlager.pgw_write($1::text,$2::text,$3::jsonb) AS result',
          [e.event_type, e.batch_run_id, JSON.stringify(e.data)]);
        assert.equal(r.rows[0].result.status, 'success', 'pgw_write erfolgreich');
      }

      // Zustand INNERHALB der Transaktion
      const inTx = await client.query(
        `SELECT sa.product_slot_key, sa.product_id, sa.active, sa.current_machine_qty, sa.valid_to
           FROM automatenlager.slot_assignments sa
           JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
          WHERE m.machine_key = $1 AND sa.mdb_code = $2`, [machineKey, slot.mdb_code]);
      const newActive = inTx.rows.find((r) => r.active && Number(r.product_id) === Number(other.product_id));
      const oldRow = inTx.rows.find((r) => r.product_slot_key === slot.product_slot_key);
      assert.ok(newActive, 'neue aktive Zuordnung mit Zielprodukt existiert');
      assert.equal(Number(newActive.current_machine_qty), targetQty, 'On-Hand per INSERT korrekt gesetzt');
      assert.equal(oldRow.active, false, 'alte Zuordnung geschlossen (active=false)');
      assert.ok(oldRow.valid_to, 'alte Zuordnung hat valid_to gesetzt');
    } finally {
      await client.query('ROLLBACK'); // HARTE GRENZE: niemals committen
    }

    // Nach ROLLBACK: Originalzustand vollstaendig wiederhergestellt
    const after = await client.query(
      `SELECT count(*) FILTER (WHERE sa.active) AS active_n,
              bool_or(sa.active AND sa.product_slot_key = $3) AS old_still_active
         FROM automatenlager.slot_assignments sa
         JOIN automatenlager.machines m ON m.machine_id = sa.machine_id
        WHERE m.machine_key = $1 AND sa.mdb_code = $2`, [machineKey, slot.mdb_code, slot.product_slot_key]);
    assert.equal(Number(after.rows[0].active_n), 1, 'nach ROLLBACK genau 1 aktive Zuordnung (keine neue persistiert)');
    assert.equal(after.rows[0].old_still_active, true, 'alte Zuordnung nach ROLLBACK wieder aktiv -> keine Mutation');
  } finally {
    await client.end();
  }
});
