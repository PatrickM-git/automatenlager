'use strict';

/**
 * Neuen Automaten direkt im Dashboard anlegen (v3 Automaten-Seite).
 *
 * Datenmodell-Besonderheiten (verifiziert gegen Prod-DB):
 *  - `machines.location_id` ist NOT NULL -> ein Automat braucht zwingend einen
 *    Standort. Das Formular bietet daher ein Pflicht-Dropdown der Standorte.
 *  - `machine_profiles.machine_id` ist die UNIQUE machine_key-Zeichenkette
 *    (z. B. "457107528"), NICHT die bigint `machines.machine_id`. Die Automaten-
 *    Seite listet machine_profiles -> ein neuer Automat bekommt sofort einen
 *    Profil-Eintrag, sonst erschiene er nicht.
 *  - Beides als idempotente Upserts (per machine_key), damit ein erneutes
 *    Anlegen denselben Automaten aktualisiert statt zu duplizieren.
 */

function s(v) {
  return v == null ? '' : String(v).trim();
}

function optStr(v) {
  const t = s(v);
  return t === '' ? null : t;
}

function optInt(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Roh-Eingabe validieren + normalisieren. Wirft bei fehlenden Pflichtfeldern.
 */
function buildMachineCreatePayload(raw = {}) {
  const machine_key = s(raw.machine_key);
  if (!machine_key) throw new Error('machine_key (Automaten-/Nayax-Nummer) ist erforderlich.');
  const name = s(raw.name);
  if (!name) throw new Error('name (Bezeichnung) ist erforderlich.');
  const location_key = s(raw.location_key || raw.location_id);
  if (!location_key) throw new Error('Standort (location) ist erforderlich – ein Automat muss einem Standort zugeordnet sein.');

  return {
    machine_key,
    name,
    location_key,
    machine_type: optStr(raw.machine_type),
    slot_count: optInt(raw.slot_count),
    area: optStr(raw.area),
    type: optStr(raw.type),
    position: optStr(raw.position),
    nickname: optStr(raw.nickname),
  };
}

/**
 * Aus dem Payload die zwei idempotenten Upserts bauen (reine Funktion, testbar
 * ohne DB). location_id wird per Sub-SELECT über location_key aufgelöst.
 */
function buildMachineInsertPlan(payload) {
  const machineSql = `
    INSERT INTO automatenlager.machines (machine_key, name, location_id, machine_type, slot_count)
    VALUES (
      $1, $2,
      (SELECT location_id FROM automatenlager.locations WHERE location_key = $3),
      $4, $5
    )
    ON CONFLICT (machine_key) DO UPDATE SET
      name         = EXCLUDED.name,
      location_id  = EXCLUDED.location_id,
      machine_type = COALESCE(EXCLUDED.machine_type, automatenlager.machines.machine_type),
      slot_count   = COALESCE(EXCLUDED.slot_count, automatenlager.machines.slot_count),
      updated_at   = now()
    RETURNING machine_id, machine_key, name, location_id`;
  const machineValues = [payload.machine_key, payload.name, payload.location_key, payload.machine_type, payload.slot_count];

  const profileSql = `
    INSERT INTO automatenlager.machine_profiles (machine_id, area, type, position, nickname)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (machine_id) DO UPDATE SET
      area     = EXCLUDED.area,
      type     = EXCLUDED.type,
      position = EXCLUDED.position,
      nickname = EXCLUDED.nickname,
      updated_at = now()`;
  const profileValues = [payload.machine_key, payload.area, payload.type, payload.position, payload.nickname];

  return { machineSql, machineValues, profileSql, profileValues };
}

/**
 * Anlegen gegen PG (machines + machine_profiles, in einer Transaktion). Wirft
 * mit klarer Meldung, wenn der Standort nicht existiert (location_id NOT NULL).
 */
async function createMachinePg(pgUrl, payload, clientFactory) {
  const { Client } = require('pg');
  const client = clientFactory ? clientFactory(pgUrl) : new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  const plan = buildMachineInsertPlan(payload);
  try {
    await client.query('BEGIN');
    let machineRow;
    try {
      machineRow = (await client.query(plan.machineSql, plan.machineValues)).rows[0];
    } catch (err) {
      if (/null value in column "location_id"/i.test(err.message)) {
        throw new Error(`Standort "${payload.location_key}" existiert nicht.`);
      }
      throw err;
    }
    await client.query(plan.profileSql, plan.profileValues);
    await client.query('COMMIT');
    return machineRow;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

module.exports = {
  buildMachineCreatePayload,
  buildMachineInsertPlan,
  createMachinePg,
};
