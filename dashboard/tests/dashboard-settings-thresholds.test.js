'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { THRESHOLD_DEFS } = require('../lib/settings-thresholds.js');
const { DEFAULT_CONFIG } = require('../lib/category-config.js');
const { classifyTurnover } = require('../lib/slow-mover.js');

// ── Metadaten-Smoke ──────────────────────────────────────────────────────────

describe('THRESHOLD_DEFS', () => {
  it('enthält ladenhueterDays mit defaultValue aus DEFAULT_CONFIG', () => {
    assert.ok(THRESHOLD_DEFS.ladenhueterDays, 'ladenhueterDays muss definiert sein');
    assert.equal(THRESHOLD_DEFS.ladenhueterDays.defaultValue, DEFAULT_CONFIG.ladenhueterDays);
    assert.equal(THRESHOLD_DEFS.ladenhueterDays.min, 1);
    assert.ok(THRESHOLD_DEFS.ladenhueterDays.max >= 30, 'max muss >= 30 sein');
    assert.equal(THRESHOLD_DEFS.ladenhueterDays.type, 'integer');
  });

  it('alle Defs haben label, description, defaultValue, min, max, unit, type', () => {
    for (const [key, def] of Object.entries(THRESHOLD_DEFS)) {
      assert.ok(def.label, `${key}: label fehlt`);
      assert.ok(def.description, `${key}: description fehlt`);
      assert.ok(def.defaultValue != null, `${key}: defaultValue fehlt`);
      assert.ok(def.min != null, `${key}: min fehlt`);
      assert.ok(def.max != null, `${key}: max fehlt`);
      assert.ok(def.unit, `${key}: unit fehlt`);
      assert.ok(def.type, `${key}: type fehlt`);
    }
  });
});

// ── getThresholds-Logik (mit Fake-Client) ────────────────────────────────────

function makeFakeClient(globalRows = {}, machineRows = {}) {
  return {
    _created: false,
    async query(sql, params) {
      // ensureTable
      if (sql.includes('CREATE TABLE IF NOT EXISTS')) return { rows: [] };
      // global read
      if (sql.includes('machine_id IS NULL') && !sql.includes('machine_id = $2')) {
        return { rows: Object.entries(globalRows).map(([key, value]) => ({ key, value })) };
      }
      // machine read
      if (sql.includes('machine_id = $2')) {
        return { rows: Object.entries(machineRows).map(([key, value]) => ({ key, value })) };
      }
      return { rows: [] };
    },
  };
}

describe('getThresholds — Provenienz-Logik', () => {
  const { getThresholds } = require('../lib/settings-thresholds.js');

  it('kein Override → source=default, value=DEFAULT_CONFIG.ladenhueterDays', async () => {
    const client = makeFakeClient({}, {});
    const result = await getThresholds(client, '__default__', null);
    assert.equal(result.ladenhueterDays.source, 'default');
    assert.equal(result.ladenhueterDays.value, DEFAULT_CONFIG.ladenhueterDays);
  });

  it('globaler Override → source=global, value=Override-Wert', async () => {
    const client = makeFakeClient({ ladenhueterDays: 45 }, {});
    const result = await getThresholds(client, '__default__', null);
    assert.equal(result.ladenhueterDays.source, 'global');
    assert.equal(result.ladenhueterDays.value, 45);
  });

  it('Automat-Override schlägt globalen Override vor', async () => {
    const client = makeFakeClient({ ladenhueterDays: 45 }, { ladenhueterDays: 20 });
    const result = await getThresholds(client, '__default__', 1);
    assert.equal(result.ladenhueterDays.source, 'machine');
    assert.equal(result.ladenhueterDays.value, 20);
  });

  it('kein machine_id → Automat-Read wird nicht ausgeführt (nur global)', async () => {
    let machineQueryCalled = false;
    const client = {
      async query(sql) {
        if (sql.includes('CREATE TABLE IF NOT EXISTS')) return { rows: [] };
        if (sql.includes('machine_id IS NULL')) return { rows: [{ key: 'ladenhueterDays', value: 60 }] };
        if (sql.includes('machine_id = $2')) { machineQueryCalled = true; return { rows: [] }; }
        return { rows: [] };
      },
    };
    await getThresholds(client, '__default__', null);
    assert.equal(machineQueryCalled, false, 'Automat-Query darf ohne machineId nicht ausgeführt werden');
  });

  it('result enthält meta-Objekt je Schlüssel', async () => {
    const client = makeFakeClient({}, {});
    const result = await getThresholds(client, '__default__', null);
    for (const t of Object.values(result)) {
      assert.ok(t.meta, 'meta muss vorhanden sein');
      assert.ok(t.meta.label, 'meta.label muss vorhanden sein');
    }
  });
});

// ── setThreshold-Validierung ─────────────────────────────────────────────────

describe('setThreshold — Validierung', () => {
  const { setThreshold } = require('../lib/settings-thresholds.js');

  function makeFakeWriteClient() {
    const calls = [];
    return {
      calls,
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
  }

  it('schreibt gültigen integer-Wert (rundet auf)', async () => {
    const client = makeFakeWriteClient();
    await setThreshold(client, '__default__', null, 'ladenhueterDays', 45.7);
    const insertCall = client.calls.find(c => c.sql.includes('INSERT'));
    assert.ok(insertCall, 'INSERT muss aufgerufen werden');
    assert.equal(JSON.parse(insertCall.params[3]), 46, 'Wert muss auf Integer gerundet werden');
  });

  it('wirft bei unbekanntem Schlüssel', async () => {
    const client = makeFakeWriteClient();
    await assert.rejects(
      () => setThreshold(client, '__default__', null, 'nichtVorhanden', 30),
      /Unbekannter Schwellwert/,
    );
  });

  it('wirft wenn Wert unter min', async () => {
    const client = makeFakeWriteClient();
    await assert.rejects(
      () => setThreshold(client, '__default__', null, 'ladenhueterDays', 0),
      /muss eine Zahl/,
    );
  });

  it('wirft wenn Wert über max', async () => {
    const client = makeFakeWriteClient();
    const max = THRESHOLD_DEFS.ladenhueterDays.max;
    await assert.rejects(
      () => setThreshold(client, '__default__', null, 'ladenhueterDays', max + 1),
      /muss eine Zahl/,
    );
  });

  it('wirft bei NaN', async () => {
    const client = makeFakeWriteClient();
    await assert.rejects(
      () => setThreshold(client, '__default__', null, 'ladenhueterDays', 'abc'),
      /muss eine Zahl/,
    );
  });
});

// ── slow-mover.js-Integration: ladenhueterDays-Override wirkt ───────────────

describe('slow-mover.js reagiert auf geänderte ladenhueterDays', () => {
  function makeSlot(daysSinceLastSale) {
    return {
      daysSinceLastSale,
      listedDays: 999,
      category: 'snack',
      db_window: 100,
      marginPerWeek: 5,
      ek_missing: false,
    };
  }

  it('Standard-ladenhueterDays=30: Slot mit 31 Tagen → ladenhueter', () => {
    const slots = classifyTurnover([makeSlot(31)], { ladenhueterDays: 30, graceDays: 14 });
    assert.equal(slots[0].turnover_class, 'ladenhueter');
  });

  it('erhöhter Schwellwert=60: Slot mit 31 Tagen → nicht mehr ladenhueter', () => {
    const slots = classifyTurnover([makeSlot(31)], { ladenhueterDays: 60, graceDays: 14 });
    assert.notEqual(slots[0].turnover_class, 'ladenhueter');
  });

  it('erhöhter Schwellwert=60: Slot mit 61 Tagen → ladenhueter', () => {
    const slots = classifyTurnover([makeSlot(61)], { ladenhueterDays: 60, graceDays: 14 });
    assert.equal(slots[0].turnover_class, 'ladenhueter');
  });

  it('Schwellwert=1: Slot mit 1 Tag → ladenhueter', () => {
    const slots = classifyTurnover([makeSlot(1)], { ladenhueterDays: 1, graceDays: 0 });
    assert.equal(slots[0].turnover_class, 'ladenhueter');
  });
});
