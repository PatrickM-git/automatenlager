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
 * Aus dem Payload + dem (bereits mandanten-geprüft aufgelösten) location_id die zwei
 * idempotenten Upserts bauen (reine Funktion, testbar ohne DB). #136 (Stufe 4): durch
 * die Tür — Mandant als $1 (eigene Parameter ab $2), ON CONFLICT-Ziele mandantengetrennt
 * ((tenant_id, machine_key) bzw. (tenant_id, machine_id), Constraints aus #132). Der
 * Standort wird NICHT mehr per Sub-SELECT aufgelöst, sondern als bereits mandanten-
 * geprüfter location_id übergeben (Parent-Prüfung passiert in derselben Transaktion).
 */
function buildMachineInsertPlan(payload, locationId) {
  const machineSql = `
    INSERT INTO automatenlager.machines (tenant_id, machine_key, name, location_id, machine_type, slot_count)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id, machine_key) DO UPDATE SET
      name         = EXCLUDED.name,
      location_id  = EXCLUDED.location_id,
      machine_type = COALESCE(EXCLUDED.machine_type, automatenlager.machines.machine_type),
      slot_count   = COALESCE(EXCLUDED.slot_count, automatenlager.machines.slot_count),
      updated_at   = now()
    RETURNING machine_id, machine_key, name, location_id`;
  const machineValues = [payload.machine_key, payload.name, locationId, payload.machine_type, payload.slot_count];

  const profileSql = `
    INSERT INTO automatenlager.machine_profiles (tenant_id, machine_id, area, type, position, nickname)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tenant_id, machine_id) DO UPDATE SET
      area     = EXCLUDED.area,
      type     = EXCLUDED.type,
      position = EXCLUDED.position,
      nickname = EXCLUDED.nickname,
      updated_at = now()`;
  const profileValues = [payload.machine_key, payload.area, payload.type, payload.position, payload.nickname];

  return { machineSql, machineValues, profileSql, profileValues };
}

/**
 * Anlegen durch die Mandanten-Tür (machines + machine_profiles), atomar in db.tx.
 * #136 (Stufe 4): Der Parent-Standort (location_key) wird IN DERSELBEN Transaktion
 * auf Mandanten-Eigentum geprüft — gehört er einem fremden Mandanten oder existiert
 * er nicht, wird mit NOT_FOUND geworfen (Endpunkt → 404) und KEINE Maschine angelegt
 * (kein TOCTOU-Fenster). Der aufgelöste location_id wird als Wert in den Upsert gegeben.
 */
async function createMachinePg(db, tenant, payload) {
  return db.tx(tenant, async (door) => {
    // Parent-Eigentumsprüfung: Standort muss dem Mandanten gehören.
    const loc = await door.read({
      tables: ['locations'],
      text: `SELECT location_id FROM automatenlager.locations WHERE tenant_id = $1 AND location_key = $2`,
      params: [payload.location_key],
    });
    if (loc.rows.length === 0) {
      const err = new Error(`Standort "${payload.location_key}" nicht gefunden.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const plan = buildMachineInsertPlan(payload, loc.rows[0].location_id);
    const machineRow = (await door.write({ tables: ['machines'], text: plan.machineSql, params: plan.machineValues })).rows[0];
    await door.write({ tables: ['machine_profiles'], text: plan.profileSql, params: plan.profileValues });
    return machineRow;
  });
}

// #2: Automat aussondern/reaktivieren = Soft-Delete (machines.active). Hartes
// Löschen scheidet aus (FK von sales_transactions/slot_assignments/guv_daily/…
// und Historienverlust). Reine SQL-Bauteile -> testbar ohne DB.
// #136 (Stufe 4): durch die Tür — Mandant als $1, machine_key $2, active $3. Das
// UPDATE trifft nur eigene Maschinen (WHERE tenant_id = $1): ein fremder Automat
// ergibt rowCount 0 ⇒ NOT_FOUND (Endpunkt → 404), kein Cross-Tenant-Soft-Delete.
function buildMachineActiveSql(machineKey, active) {
  const key = s(machineKey);
  if (!key) throw new Error('machine_key ist erforderlich.');
  const sql = `UPDATE automatenlager.machines
                  SET active = $3, updated_at = now()
                WHERE tenant_id = $1 AND machine_key = $2
                RETURNING machine_id, machine_key, name, active`;
  return { sql, values: [key, !!active] };
}

async function setMachineActivePg(db, tenant, machineKey, active) {
  const { sql, values } = buildMachineActiveSql(machineKey, active);
  const res = await db.write({ tenant, tables: ['machines'], text: sql, params: values });
  if (res.rowCount === 0) {
    const err = new Error(`Automat "${values[0]}" nicht gefunden.`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  return res.rows[0];
}

module.exports = {
  buildMachineCreatePayload,
  buildMachineInsertPlan,
  createMachinePg,
  buildMachineActiveSql,
  setMachineActivePg,
};
