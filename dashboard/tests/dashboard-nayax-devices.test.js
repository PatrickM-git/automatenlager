'use strict';

// TDD: Nayax-Geräteliste (DB-Spiegel). Der n8n-Sync ruft GET /operational/v1/
// machines und schreibt die Liste nach automatenlager.nayax_devices; das
// Dashboard liest nur die DB. Diese reinen Funktionen mappen die Nayax-Antwort
// und bereiten die Liste fürs Combobox auf (Nr + Name, schon angelegte markiert).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildNayaxDeviceRows,
  buildNayaxDeviceLabel,
  shapeNayaxDevices,
} = require('../lib/nayax-devices.js');

// ── Mapping der Nayax-API-Antwort (für den n8n-Code-Node) ─────────────────────

test('buildNayaxDeviceRows: mappt MachineID/Number/Name, robust gegen Feldvarianten', () => {
  const rows = buildNayaxDeviceRows([
    { MachineID: 457107528, MachineNumber: '457107528', MachineName: 'Snackautomat DPFA' },
    { MachineId: 999111, MachineName: 'Test 2' }, // andere Schreibweise, keine Number
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { nayax_machine_id: '457107528', machine_number: '457107528', machine_name: 'Snackautomat DPFA' });
  assert.equal(rows[1].nayax_machine_id, '999111');
  assert.equal(rows[1].machine_number, '');
  assert.equal(rows[1].machine_name, 'Test 2');
});

test('buildNayaxDeviceRows: ohne MachineID -> übersprungen (kein Anker)', () => {
  const rows = buildNayaxDeviceRows([{ MachineName: 'kaputt' }, null, { MachineID: '5' }]);
  assert.deepEqual(rows.map((r) => r.nayax_machine_id), ['5']);
});

test('buildNayaxDeviceRows: leere/fehlende Eingabe -> []', () => {
  assert.deepEqual(buildNayaxDeviceRows(undefined), []);
  assert.deepEqual(buildNayaxDeviceRows([]), []);
});

// ── Anzeige-Label fürs Combobox ───────────────────────────────────────────────

test('buildNayaxDeviceLabel: "Nr — Name", fällt auf Nr zurück', () => {
  assert.equal(buildNayaxDeviceLabel({ nayax_machine_id: '457107528', machine_name: 'DPFA' }), '457107528 — DPFA');
  assert.equal(buildNayaxDeviceLabel({ nayax_machine_id: '999', machine_name: '' }), '999');
});

// ── Aufbereitung fürs Dashboard (schon angelegte markieren) ───────────────────

test('shapeNayaxDevices: markiert bereits als Automat angelegte Geräte', () => {
  const out = shapeNayaxDevices([
    { nayax_machine_id: '457107528', machine_number: '457107528', machine_name: 'DPFA', already_created: true },
    { nayax_machine_id: '999111', machine_number: '999111', machine_name: 'Neu', already_created: false },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].alreadyCreated, true);
  assert.equal(out[0].label, '457107528 — DPFA');
  assert.equal(out[1].alreadyCreated, false);
  assert.equal(out[1].machineId, '999111');
});
