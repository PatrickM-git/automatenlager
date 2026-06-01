'use strict';

const { buildMachineLabel } = require('./machine-profiles.js');

/**
 * Automaten-View — reine Aufbereitung der bestehenden /api/v2/machine-profiles
 * und /api/v2/locations für die v3-Automaten-Seite. Verknüpft jeden Automaten
 * mit seinem Standort und fasst die Standorte zusammen. Keine DB-/HTTP-Abhängigkeit.
 */

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function buildAutomatenView(machines = [], locations = []) {
  const machineList = Array.isArray(machines) ? machines : [];
  const locationList = Array.isArray(locations) ? locations : [];

  // machine_id -> erster passender Standort (deterministisch nach Standort-Reihenfolge)
  const locByMachine = new Map();
  for (const loc of locationList) {
    const ids = Array.isArray(loc.machine_ids) ? loc.machine_ids : [];
    for (const id of ids) {
      const key = clean(id);
      if (key && !locByMachine.has(key)) {
        locByMachine.set(key, loc);
      }
    }
  }

  let unassignedCount = 0;
  const builtMachines = machineList.map((m) => {
    const loc = locByMachine.get(clean(m.machine_id)) || null;
    if (!loc) { unassignedCount += 1; }
    return {
      machine_id: m.machine_id,
      label: clean(m.label) || clean(m.machine_id),
      area: m.area ?? null,
      type: m.type ?? null,
      position: m.position ?? null,
      nickname: m.nickname ?? null,
      location_name: loc ? loc.name : null,
      location_status: loc ? loc.status : null,
    };
  });

  const builtLocations = locationList.map((loc) => ({
    location_id: loc.location_id ?? null,
    name: loc.name,
    status: loc.status ?? null,
    machine_ids: Array.isArray(loc.machine_ids) ? loc.machine_ids : [],
    machineCount: Array.isArray(loc.machine_ids) ? loc.machine_ids.length : 0,
  }));

  return {
    machines: builtMachines,
    locations: builtLocations,
    total: builtMachines.length,
    locationsTotal: builtLocations.length,
    unassignedCount,
  };
}

/**
 * Auswahlbaum für den GuV-Standort-/Automaten-Filter. EINE Zeile pro echtem
 * Automaten aus `automatenlager.machines` (die SSoT). Erwartet die bereits
 * gejointen Zeilen (machine + location + machine_profiles). Die `machine_id`
 * ist die INTERNE ID (= die, unter der guv_daily bucht); das Label kommt aus
 * dem Profil, das per machine_key/machine_id drangejoint wurde. So erscheint
 * jeder physische Automat genau einmal (kein Doppel durch Nayax-Nr ≠ interne ID).
 * Reine Funktion (keine DB).
 */
function buildEconomicsScope(machineRows = []) {
  const rows = Array.isArray(machineRows) ? machineRows : [];
  const machines = [];
  const locMap = new Map();

  for (const r of rows) {
    const id = clean(r.machine_id);
    if (!id) { continue; }
    const label = buildMachineLabel({
      machine_id: id,
      area: r.area ?? null,
      type: r.type ?? null,
      position: r.position ?? null,
      nickname: r.nickname ?? null,
    });
    const locationName = r.location_name ? String(r.location_name) : null;
    machines.push({ machine_id: id, label: label || id, location_name: locationName });

    const locId = r.location_id != null && clean(r.location_id) ? clean(r.location_id) : null;
    if (locId) {
      if (!locMap.has(locId)) { locMap.set(locId, { location_id: locId, name: locationName, machine_ids: [] }); }
      locMap.get(locId).machine_ids.push(id);
    }
  }

  machines.sort((a, b) =>
    (a.location_name || '￿').localeCompare(b.location_name || '￿') || a.label.localeCompare(b.label));
  const locations = [...locMap.values()]
    .map((l) => ({ location_id: l.location_id, name: l.name, machine_ids: l.machine_ids, machineCount: l.machine_ids.length }))
    .sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿'));

  return { locations, machines };
}

// DB-Zugriff: liefert je echtem Automaten eine Zeile mit Standort + Profil-Label.
// machine_profiles ist auf die Nayax-Nr (machine_key) ODER die interne ID
// geschlüsselt → Join auf beide Varianten, damit das Label sicher andockt.
async function queryEconomicsScopePg(pgUrl) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT m.machine_id,
              m.machine_key,
              m.active,
              l.location_id,
              l.name        AS location_name,
              mp.area, mp.type, mp.position, mp.nickname
         FROM automatenlager.machines m
         LEFT JOIN automatenlager.locations l ON l.location_id = m.location_id
         LEFT JOIN automatenlager.machine_profiles mp
                ON mp.machine_id::text IN (m.machine_id::text, m.machine_key::text)
        ORDER BY l.name NULLS LAST, m.machine_id`,
    );
    return buildEconomicsScope(res.rows);
  } finally {
    await client.end();
  }
}

module.exports = { buildAutomatenView, buildEconomicsScope, queryEconomicsScopePg };
