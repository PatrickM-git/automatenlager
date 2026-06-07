'use strict';

/**
 * Nayax-Geräte-Spiegel (DB-first, Vercel+Supabase-kompatibel).
 *
 * Ein Sync-Job (heute n8n-WF, später Supabase-Cron) ruft die Nayax-Lynx-API
 * `GET https://lynx.nayax.com/operational/v1/machines` und schreibt die Liste
 * idempotent nach `automatenlager.nayax_devices`. Das Dashboard liest NUR die
 * Tabelle — kein Live-Nayax-Call im UI, kein Nayax-Secret im Dashboard.
 *
 * - `buildNayaxDeviceRows`: Nayax-API-Items -> Upsert-Rows (im n8n-Code-Node).
 * - `buildNayaxUpsertPlan`: idempotentes Upsert-SQL je Gerät.
 * - `queryNayaxDevicesPg` + `shapeNayaxDevices`: Lese-Pfad fürs Combobox,
 *   markiert bereits als Automat angelegte Geräte (machine_key == nayax_machine_id).
 */

function s(v) {
  return v == null ? '' : String(v).trim();
}

function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

/**
 * Rohe Nayax-API-Maschinen-Objekte -> Spiegel-Rows. Robust gegen Schreibweisen
 * (MachineID/MachineId, MachineNumber, MachineName). Ohne MachineID -> verworfen.
 */
function buildNayaxDeviceRows(items) {
  return (items || []).filter(Boolean).map((it) => ({
    nayax_machine_id: firstNonEmpty(it, ['MachineID', 'MachineId', 'machineId', 'machine_id']),
    machine_number: firstNonEmpty(it, ['MachineNumber', 'MachineNo', 'machine_number']),
    machine_name: firstNonEmpty(it, ['MachineName', 'Description', 'machine_name']),
  })).filter((r) => r.nayax_machine_id !== '');
}

// Anzeige-Label fürs Combobox: "Nr — Name" (oder nur Nr).
function buildNayaxDeviceLabel(row) {
  const id = s(row.nayax_machine_id);
  const name = s(row.machine_name);
  return name ? `${id} — ${name}` : id;
}

/**
 * Idempotentes Upsert je Gerät (für den n8n-Postgres-Node).
 */
function buildNayaxUpsertPlan(row) {
  const sql = `
    INSERT INTO automatenlager.nayax_devices (nayax_machine_id, machine_number, machine_name, last_seen_at, synced_at)
    VALUES ($1, $2, $3, now(), now())
    ON CONFLICT (nayax_machine_id) DO UPDATE SET
      machine_number = EXCLUDED.machine_number,
      machine_name   = EXCLUDED.machine_name,
      last_seen_at   = now(),
      synced_at      = now()`;
  return { sql, values: [row.nayax_machine_id, row.machine_number, row.machine_name] };
}

// DB-Rows (inkl. already_created-Flag aus dem LEFT JOIN) -> Combobox-Form.
function shapeNayaxDevices(dbRows) {
  return (dbRows || []).map((r) => ({
    machineId: s(r.nayax_machine_id),
    machineNumber: s(r.machine_number),
    machineName: s(r.machine_name),
    label: buildNayaxDeviceLabel(r),
    alreadyCreated: r.already_created === true,
  }));
}

// #127 (Stufe 3): nutzersichtbarer Geräte-Read mandantengetrennt durch die Tür
// (nayax_devices ist als Geräte-ZUORDNUNG mandantenpflichtig). Mandant = $1. Die
// reine Existenz-/Claiming-Eindeutigkeitsprüfung (global) ist ein separater Pfad
// (Onboarding/Stufe 6) und bleibt von der Tür unberührt.
async function queryNayaxDevicesPg(db, tenant) {
  const res = await db.read({
    tenant,
    tables: ['nayax_devices', 'machines'],
    text:
      `SELECT d.nayax_machine_id, d.machine_number, d.machine_name,
              (m.machine_key IS NOT NULL) AS already_created
         FROM automatenlager.nayax_devices d
         LEFT JOIN automatenlager.machines m ON m.machine_key = d.nayax_machine_id AND m.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1
        ORDER BY already_created, d.machine_name NULLS LAST, d.nayax_machine_id`,
    params: [],
  });
  return res.rows;
}

module.exports = {
  buildNayaxDeviceRows,
  buildNayaxDeviceLabel,
  buildNayaxUpsertPlan,
  shapeNayaxDevices,
  queryNayaxDevicesPg,
};
