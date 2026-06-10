'use strict';

/**
 * WF4 Slot-Write (MDB/Produktzuordnung) — In-Process-Port (Issue #163, Stufe 6 Slice 3).
 *
 * WF4 ist die AUTORITÄT für aktive MDB/Slot-Zuordnungen: alte Zeilen schließen
 * (active=false, valid_to=jetzt) / neue öffnen (neuer product_slot_key, valid_from=jetzt),
 * plus Warnungen. n8n baute das per WF-PGW `slot_assignment`-Event; hier als
 * **transaktionales db.tx durch die Mandanten-Tür** (direkter Wechsel, starke Tests).
 *
 * Verifizierte pgw_write()-Semantik (Pre-Flight-Dump):
 *   slot_assignment → slot_assignments
 *     INSERT (… product_slot_key, machine_id, mdb_code, product_id, valid_from,
 *             valid_to, active, current_machine_qty, target_stock, machine_capacity, notes)
 *     ON CONFLICT (product_slot_key) DO UPDATE
 *       SET valid_to = EXCLUDED.valid_to, active = EXCLUDED.active,
 *           notes = COALESCE(EXCLUDED.notes, sa.notes)
 *       WHERE sa.valid_to IS DISTINCT FROM EXCLUDED.valid_to
 *          OR sa.active  IS DISTINCT FROM EXCLUDED.active
 *   ⇒ current_machine_qty/target_stock/machine_capacity werden NUR beim INSERT eines
 *     NEUEN Schlüssels gesetzt; ON CONFLICT aktualisiert nur valid_to/active/notes.
 *     Daher: jede Änderung = close(alt) + open(neuer Schlüssel) — kein Roh-UPDATE.
 *
 * Aufbau: reine `buildSlotLifecycleEvents` (faithful zur WF4 „Prepare PGW"-Node) +
 * `applySlotAssignmentEvents(db, tenant)` (db.tx, RLS-GUC, explizites tenant_id).
 * Trägt KEIN rohes pg (#107-rein).
 */

const { toAllowedWarningType } = require('../warning-types.js');

const WF4_SLOT_WRITE_KEY = 'wf4-slot-write';

function clean(v) { return String(v == null ? '' : v).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(); }
function num(v) { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function boolActive(v) { return ['TRUE', '1', 'JA', 'YES', 'AKTIV', 'ACTIVE'].includes(clean(v).toUpperCase()) || v === true; }

/** Eine Roh-Zeile (close/new/baseUpdate) → slot_assignment-Event (faithful zur WF4-Node). */
function rowToSlotEvent(row, batchRunId, nowIso) {
  // valid_from ist NOT NULL und wird bei ON CONFLICT (product_slot_key) NICHT aktualisiert,
  // aber der „speculative insert" prüft NOT NULL VOR der Konflikt-Auflösung → daher beim
  // Close (ohne valid_from) auf nowIso defaulten (verhaltensgetreu zum Abgleich-Builder).
  const at = nowIso || new Date().toISOString();
  return {
    event_type: 'slot_assignment',
    batch_run_id: batchRunId,
    data: {
      product_slot_key: clean(row.product_slot_id || row.product_slot_key),
      machine_key: clean(row.machine_id || row.machine_key),
      mdb_code: num(row.mdb_code),
      product_key: clean(row.product_key),
      valid_from: clean(row.valid_from_datetime || row.valid_from) || at,
      valid_to: clean(row.valid_to_datetime || row.valid_to) || null,
      active: boolActive(row.active),
      current_machine_qty: num(row.current_machine_qty) ?? 0,
      target_stock: num(row.target_stock),
      machine_capacity: num(row.machine_capacity),
      notes: clean(row.notes) || null,
    },
  };
}

/**
 * Reine Logik: die drei WF4-Zeilengruppen → slot_assignment-Events.
 * Filtert Zeilen ohne product_slot_id/machine_id/product_key (wie die WF4-Node).
 * @param {{closeRows?:object[], newRows?:object[], baseRowUpdates?:object[]}} plan
 * @param {{nowIso?:string, batchRunId?:string}} [ctx]
 */
function buildSlotLifecycleEvents(plan = {}, ctx = {}) {
  const nowIso = ctx.nowIso || new Date().toISOString();
  const batchRunId = ctx.batchRunId || `wf4_${nowIso.slice(0, 10)}`;
  return [
    ...(plan.closeRows || []),
    ...(plan.newRows || []),
    ...(plan.baseRowUpdates || []),
  ]
    .map((row) => rowToSlotEvent(row, batchRunId, nowIso))
    .filter((ev) => ev.data.product_slot_key && ev.data.machine_key && ev.data.product_key);
}

// Faithful zu pgw_write: FK-Auflösung machine_key→machine_id, product_key→product_id;
// ON CONFLICT (product_slot_key) DO UPDATE nur valid_to/active/notes (qty nur bei INSERT).
const SLOT_ASSIGNMENT_UPSERT_SQL = `
  INSERT INTO automatenlager.slot_assignments
    (product_slot_key, machine_id, mdb_code, product_id, valid_from, valid_to,
     active, current_machine_qty, target_stock, machine_capacity, notes, tenant_id)
  SELECT $2, m.machine_id, $4::integer, p.product_id, $5::timestamptz, $6::timestamptz,
         COALESCE($7::boolean, TRUE), COALESCE($8::integer, 0), $9::integer, $10::integer, $11, $1
    FROM automatenlager.machines m
    LEFT JOIN automatenlager.products p ON p.product_key = $3 AND p.tenant_id = $1
   WHERE m.machine_key = $12 AND m.tenant_id = $1
   LIMIT 1
  ON CONFLICT (product_slot_key) DO UPDATE
    SET valid_to = EXCLUDED.valid_to,
        active   = EXCLUDED.active,
        notes    = COALESCE(EXCLUDED.notes, slot_assignments.notes)
    WHERE slot_assignments.valid_to IS DISTINCT FROM EXCLUDED.valid_to
       OR slot_assignments.active   IS DISTINCT FROM EXCLUDED.active`;

function sanitizeKey(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const WF4_WARNING_INSERT_SQL = `
  INSERT INTO automatenlager.warnings
    (warning_key, warning_type, severity, machine_id, product_id, message, source_workflow, tenant_id)
  SELECT $2, $3, $4, m.machine_id, p.product_id, $7, 'wf4', $1
    FROM (SELECT 1) x
    LEFT JOIN automatenlager.machines m ON m.machine_key = $5 AND m.tenant_id = $1
    LEFT JOIN automatenlager.products p ON p.product_key = $6 AND p.tenant_id = $1
  ON CONFLICT (tenant_id, warning_key) DO NOTHING`;

/**
 * Slot-Zuordnungs-Events transaktional durch die Tür anwenden (close alt / open neu).
 * @param {object} db      Mandanten-Tür
 * @param {string} tenant  expliziter Mandant
 * @param {object} opts     { events, warnings, nowIso }
 * @returns {Promise<{upserts:number, warningsWritten:number, skipped:number}>}
 */
async function applySlotAssignmentEvents(db, tenant, { events = [], warnings = [], nowIso } = {}) {
  const at = nowIso || new Date().toISOString();
  const dateStr = at.slice(0, 10);
  return db.tx(tenant, async (door) => {
    let upserts = 0; let skipped = 0;
    for (const ev of events) {
      const d = (ev && ev.data) ? ev.data : ev;
      const r = await door.write({
        tables: ['slot_assignments', 'machines', 'products'],
        text: SLOT_ASSIGNMENT_UPSERT_SQL,
        params: [d.product_slot_key, d.product_key, d.mdb_code, d.valid_from, d.valid_to,
          d.active, d.current_machine_qty, d.target_stock, d.machine_capacity, d.notes, d.machine_key],
      });
      const n = r.rowCount || 0;
      upserts += n;
      if (n === 0) skipped += 1; // FK unauflösbar ODER ON-CONFLICT-WHERE nicht erfüllt (No-Op)
    }
    let warningsWritten = 0;
    let idx = 0;
    for (const w of warnings) {
      const allowed = toAllowedWarningType(w.type || w.warning_type);
      if (!allowed) continue; // kein PG-Warnungstyp (CHECK) ⇒ übersprungen
      const key = ['WF4', sanitizeKey(allowed), sanitizeKey(w.machine_id || w.machine_key), sanitizeKey(w.product_key || 'NA'), sanitizeKey(dateStr), String(idx++)].join('_');
      const r = await door.write({
        tables: ['warnings', 'machines', 'products'],
        text: WF4_WARNING_INSERT_SQL,
        params: [key, allowed, clean(w.severity) || 'info',
          clean(w.machine_id || w.machine_key), clean(w.product_key), clean(w.message)],
      });
      warningsWritten += (r.rowCount || 0);
    }
    return { upserts, warningsWritten, skipped };
  });
}

module.exports = {
  WF4_SLOT_WRITE_KEY,
  buildSlotLifecycleEvents,
  rowToSlotEvent,
  applySlotAssignmentEvents,
  SLOT_ASSIGNMENT_UPSERT_SQL,
};
