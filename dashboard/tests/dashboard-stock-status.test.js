'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AVAILABLE_BATCH_STATUSES,
  isAvailableBatchStatus,
  availableBatchStatusSqlList,
} = require('../lib/stock-status.js');

test('AVAILABLE_BATCH_STATUSES enthaelt aktiv, active und reserve', () => {
  assert.deepEqual(AVAILABLE_BATCH_STATUSES, ['aktiv', 'active', 'reserve']);
});

test('isAvailableBatchStatus: reserve zaehlt als verfuegbar (Pick-Up-Drift)', () => {
  assert.equal(isAvailableBatchStatus('reserve'), true);
  assert.equal(isAvailableBatchStatus('aktiv'), true);
  assert.equal(isAvailableBatchStatus('active'), true);
});

test('isAvailableBatchStatus: ausgesondert/leer/wartet_nachkauf zaehlen NICHT', () => {
  assert.equal(isAvailableBatchStatus('ausgesondert'), false);
  assert.equal(isAvailableBatchStatus('leer'), false);
  assert.equal(isAvailableBatchStatus('wartet_nachkauf'), false);
});

test('isAvailableBatchStatus: null/leerer Status gilt als verfuegbar (Alt-Daten)', () => {
  assert.equal(isAvailableBatchStatus(null), true);
  assert.equal(isAvailableBatchStatus(''), true);
  assert.equal(isAvailableBatchStatus(undefined), true);
});

test('isAvailableBatchStatus: tolerant gegen Whitespace/Gross-Klein', () => {
  assert.equal(isAvailableBatchStatus(' Reserve '), true);
  assert.equal(isAvailableBatchStatus('AKTIV'), true);
});

test('availableBatchStatusSqlList liefert eine SQL-IN-Liste', () => {
  assert.equal(availableBatchStatusSqlList(), "'aktiv', 'active', 'reserve'");
});
