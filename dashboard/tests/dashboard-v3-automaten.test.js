'use strict';
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');

const { buildAutomatenView } = require('../lib/automaten-view.js');

/* ---- Fixtures ------------------------------------------------------------ */
const MACHINES = [
  { machine_profile_id: 1, machine_id: 'M1', area: 'EG',   type: 'Snack',    position: 'links',  nickname: null,     label: 'EG · Snack · links' },
  { machine_profile_id: 2, machine_id: 'M2', area: '1.OG', type: 'Getränke', position: 'rechts', nickname: 'Durst',  label: '1.OG · Getränke · rechts (Durst)' },
  { machine_profile_id: 3, machine_id: 'M3', area: null,   type: null,       position: null,     nickname: null,     label: 'M3' },
];
const LOCATIONS = [
  { location_id: 10, name: 'Bürohaus Nord', status: 'aktiv',  machine_ids: ['M1', 'M2'] },
  { location_id: 11, name: 'Lagerhalle',    status: 'geplant', machine_ids: ['M2'] },
];

/* ---- AC-A1: Maschinen werden mit ihrem Standort verknüpft ---------------- */
test('AC-A1: buildAutomatenView annotates each machine with its location', () => {
  const view = buildAutomatenView(MACHINES, LOCATIONS);
  const m1 = view.machines.find((m) => m.machine_id === 'M1');
  assert.equal(m1.location_name, 'Bürohaus Nord');
  assert.equal(m1.location_status, 'aktiv');
  assert.equal(m1.label, 'EG · Snack · links');
});

/* ---- AC-A2: Maschine ohne Standort ist als solche erkennbar -------------- */
test('AC-A2: machine without a location has null location and counts as unassigned', () => {
  const view = buildAutomatenView(MACHINES, LOCATIONS);
  const m3 = view.machines.find((m) => m.machine_id === 'M3');
  assert.equal(m3.location_name, null);
  assert.equal(m3.location_status, null);
  assert.equal(view.unassignedCount, 1);
});

/* ---- AC-A3: Bei mehreren Standorten gewinnt der erste deterministisch ---- */
test('AC-A3: a machine in multiple locations is mapped to the first match', () => {
  const view = buildAutomatenView(MACHINES, LOCATIONS);
  const m2 = view.machines.find((m) => m.machine_id === 'M2');
  assert.equal(m2.location_name, 'Bürohaus Nord');
});

/* ---- AC-A4: Standorte werden mit Maschinenzahl zusammengefasst ----------- */
test('AC-A4: locations are summarized with their machine count', () => {
  const view = buildAutomatenView(MACHINES, LOCATIONS);
  const nord = view.locations.find((l) => l.location_id === 10);
  assert.equal(nord.machineCount, 2);
  assert.equal(nord.status, 'aktiv');
});

/* ---- AC-A5: Gesamtzahlen ------------------------------------------------- */
test('AC-A5: totals reflect machine and location counts', () => {
  const view = buildAutomatenView(MACHINES, LOCATIONS);
  assert.equal(view.total, 3);
  assert.equal(view.locationsTotal, 2);
});

/* ---- AC-A6: Robust bei leeren Eingaben ----------------------------------- */
test('AC-A6: buildAutomatenView handles empty input gracefully', () => {
  const view = buildAutomatenView([], []);
  assert.deepEqual(view.machines, []);
  assert.deepEqual(view.locations, []);
  assert.equal(view.total, 0);
  assert.equal(view.locationsTotal, 0);
  assert.equal(view.unassignedCount, 0);
});

test('AC-A6b: missing arguments do not throw', () => {
  const view = buildAutomatenView(undefined, undefined);
  assert.equal(view.total, 0);
  assert.equal(view.unassignedCount, 0);
});

/* ---- AC-A7: Frontend-Wiring (statische Präsenz) -------------------------- */
test('AC-A7: v3.js defines renderAutomatenPage and fetches machine-profiles + locations', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /renderAutomatenPage/, 'v3.js must define renderAutomatenPage');
  assert.match(js, /\/api\/v2\/machine-profiles/, 'v3.js must fetch /api/v2/machine-profiles');
  assert.match(js, /\/api\/v2\/locations/, 'v3.js must fetch /api/v2/locations');
});

test('AC-A8: v3.js provides a jump from an automat into the slot view', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.js'), 'utf8');
  assert.match(js, /data-auto-jump/, 'automat cards must expose a slot-view jump');
  assert.match(js, /data-slots-stage-machine/, 'slot stages must carry their machine id as a dedicated jump anchor (no collision with the machine-picker chips)');
});

test('AC-A9: v3.css defines automaten layout classes', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'v3.css'), 'utf8');
  assert.match(css, /\.v3-auto-/, 'v3.css must define .v3-auto-* classes');
});
