'use strict';

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

module.exports = { buildAutomatenView };
