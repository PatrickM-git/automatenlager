'use strict';

// TDD: Neuen Automaten direkt im Dashboard anlegen (Automaten-Seite v3).
// machines.location_id ist NOT NULL -> ein Automat braucht zwingend einen
// Standort. Anlegen schreibt sowohl machines (Stammzeile, Standort, Slots) als
// auch machine_profiles (damit der Automat sofort auf der Seite erscheint).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMachineCreatePayload,
  buildMachineInsertPlan,
} = require('../lib/machine-create.js');

test('buildMachineCreatePayload: gültige Eingabe normalisieren', () => {
  const p = buildMachineCreatePayload({
    machine_key: ' 457107529 ', name: '  Snackautomat Foyer ',
    location_key: 'LOC_DPFA_CHEMNITZ',
    machine_type: 'Kombi', slot_count: '40',
    area: '1.OG', type: 'Snack', nickname: 'Foyer',
  });
  assert.equal(p.machine_key, '457107529');
  assert.equal(p.name, 'Snackautomat Foyer');
  assert.equal(p.location_key, 'LOC_DPFA_CHEMNITZ');
  assert.equal(p.machine_type, 'Kombi');
  assert.equal(p.slot_count, 40);
  assert.equal(p.area, '1.OG');
  assert.equal(p.nickname, 'Foyer');
});

test('buildMachineCreatePayload: machine_key Pflicht', () => {
  assert.throws(() => buildMachineCreatePayload({ name: 'X', location_key: 'L' }), /machine_key/);
});

test('buildMachineCreatePayload: name Pflicht', () => {
  assert.throws(() => buildMachineCreatePayload({ machine_key: '1', location_key: 'L' }), /name/);
});

test('buildMachineCreatePayload: location Pflicht (machines.location_id NOT NULL)', () => {
  assert.throws(() => buildMachineCreatePayload({ machine_key: '1', name: 'X' }), /standort|location/i);
});

test('buildMachineCreatePayload: optionale Felder fehlen -> null/leer, slot_count ungültig -> null', () => {
  const p = buildMachineCreatePayload({ machine_key: '5', name: 'Y', location_key: 'L', slot_count: 'abc' });
  assert.equal(p.machine_type, null);
  assert.equal(p.slot_count, null);
  assert.equal(p.area, null);
  assert.equal(p.nickname, null);
});

test('buildMachineInsertPlan: liefert mandantengetrennte Upserts für machines UND machine_profiles (#136)', () => {
  const plan = buildMachineInsertPlan(buildMachineCreatePayload({
    machine_key: '457107529', name: 'Foyer-Automat', location_key: 'LOC_X',
    area: '1.OG', type: 'Snack', nickname: 'Foyer',
  }), 42); // location_id ist bereits (mandanten-geprüft) aufgelöst
  // #136: machines-Upsert mandantengetrennt (tenant_id als $1); location_id als Wert, kein Sub-SELECT mehr
  assert.match(plan.machineSql, /INSERT INTO automatenlager\.machines/i);
  assert.match(plan.machineSql, /ON CONFLICT \(tenant_id, machine_key\) DO UPDATE/i);
  assert.doesNotMatch(plan.machineSql, /SELECT location_id FROM automatenlager\.locations/i);
  // machine_profiles-Upsert (machine_id = machine_key) -> erscheint auf der Seite
  assert.match(plan.profileSql, /INSERT INTO automatenlager\.machine_profiles/i);
  assert.match(plan.profileSql, /ON CONFLICT \(tenant_id, machine_id\) DO UPDATE/i);
  // keine bigint-Verwechslung: profile.machine_id trägt den machine_key; location_id als Wert
  assert.equal(plan.machineValues[0], '457107529');
  assert.equal(plan.machineValues[2], 42);
  assert.equal(plan.profileValues[0], '457107529');
});
