'use strict';

/**
 * #31 (Option A): settings_thresholds — mandanten-/automaten-parametrische Schwellwerte.
 *
 * Ergänzt classification_settings (Margen, Latten, graceDays) um eine zweite,
 * einfachere Relation für reine Zahlen-Schwellwerte. Vorteil: additiv, kein Refactor
 * der bestehenden #66-Config; Pro-Automat-Override nativ über machine_id.
 *
 * Schlüssel-Vorrang: machine-Override > global-Override > classification_settings > Default.
 * Diese Datei verantwortet nur den ersten und zweiten Schritt (settings_thresholds).
 * Der Fallback auf classification_settings erfolgt beim Aufrufer.
 */

const { DEFAULT_CONFIG } = require('./category-config.js');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS automatenlager.settings_thresholds (
    tenant_id   TEXT        NOT NULL DEFAULT '__default__',
    machine_id  INTEGER     NULL
      REFERENCES automatenlager.machines(machine_id) ON DELETE CASCADE,
    key         TEXT        NOT NULL,
    value       JSONB       NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT settings_thresholds_unique
      UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id, key)
  )
`;

/** Metadaten je Schwellwert-Schlüssel. */
const THRESHOLD_DEFS = {
  ladenhueterDays: {
    label: 'Ladenhüter-Schwelle (Tage)',
    description: '0 Verkäufe seit ≥ so vielen Tagen — zeitbasiertes Signal für totes Kapital und MHD-Risiko.',
    defaultValue: DEFAULT_CONFIG.ladenhueterDays,
    min: 1,
    max: 365,
    unit: 'Tage',
    type: 'integer',
  },
};

async function ensureTable(client) {
  await client.query(CREATE_TABLE_SQL);
}

/**
 * Liest alle definierten Schwellwerte mit Provenienz-Info.
 * Gibt für jeden Schlüssel { value, source: 'default'|'global'|'machine', meta } zurück.
 *
 * machineId: optional (integer); wenn gesetzt, wird zusätzlich der Automat-Override geladen.
 */
async function getThresholds(client, tenantId, machineId) {
  await ensureTable(client);
  const tid = String(tenantId || '__default__');
  const mid = machineId != null ? Number(machineId) : null;

  const globalRes = await client.query(
    `SELECT key, value FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND machine_id IS NULL`,
    [tid],
  );
  const globalOverrides = {};
  for (const r of globalRes.rows) globalOverrides[r.key] = r.value;

  const machineOverrides = {};
  if (mid != null) {
    const machRes = await client.query(
      `SELECT key, value FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND machine_id = $2`,
      [tid, mid],
    );
    for (const r of machRes.rows) machineOverrides[r.key] = r.value;
  }

  const result = {};
  for (const [key, def] of Object.entries(THRESHOLD_DEFS)) {
    let value = def.defaultValue;
    let source = 'default';
    if (key in globalOverrides) { value = globalOverrides[key]; source = 'global'; }
    if (key in machineOverrides) { value = machineOverrides[key]; source = 'machine'; }
    result[key] = { value, source, meta: def };
  }
  return result;
}

/**
 * Schreibt einen Schwellwert (global oder pro Automat).
 * Wirft Error bei unbekanntem key oder invalider value.
 */
async function setThreshold(client, tenantId, machineId, key, value) {
  if (!Object.prototype.hasOwnProperty.call(THRESHOLD_DEFS, key)) {
    throw new Error(`Unbekannter Schwellwert-Schlüssel: "${key}"`);
  }
  const def = THRESHOLD_DEFS[key];
  const num = Number(value);
  if (!Number.isFinite(num) || num < def.min || num > def.max) {
    throw new Error(`"${key}" muss eine Zahl zwischen ${def.min} und ${def.max} sein.`);
  }
  const coerced = def.type === 'integer' ? Math.round(num) : num;

  await ensureTable(client);
  const tid = String(tenantId || '__default__');
  const mid = machineId != null ? Number(machineId) : null;

  await client.query(
    `INSERT INTO automatenlager.settings_thresholds (tenant_id, machine_id, key, value, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT ON CONSTRAINT settings_thresholds_unique
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tid, mid, key, JSON.stringify(coerced)],
  );
}

/**
 * Löscht einen Override (setzt auf Fallback zurück).
 * machineId null → globalen Override entfernen.
 * machineId integer → Automat-Override entfernen.
 */
async function resetThreshold(client, tenantId, machineId, key) {
  await ensureTable(client);
  const tid = String(tenantId || '__default__');
  const mid = machineId != null ? Number(machineId) : null;
  if (mid != null) {
    await client.query(
      `DELETE FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND machine_id = $2 AND key = $3`,
      [tid, mid, key],
    );
  } else {
    await client.query(
      `DELETE FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND machine_id IS NULL AND key = $2`,
      [tid, key],
    );
  }
}

/**
 * Löscht ALLE Overrides eines Mandanten/Automaten-Scope.
 * machineId null → alle globalen Overrides entfernen.
 * machineId integer → alle Automat-Overrides für diese machine_id entfernen.
 */
async function resetAllThresholds(client, tenantId, machineId) {
  await ensureTable(client);
  const tid = String(tenantId || '__default__');
  const mid = machineId != null ? Number(machineId) : null;
  if (mid != null) {
    await client.query(
      `DELETE FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND machine_id = $2`,
      [tid, mid],
    );
  } else {
    await client.query(
      `DELETE FROM automatenlager.settings_thresholds WHERE tenant_id = $1 AND machine_id IS NULL`,
      [tid],
    );
  }
}

module.exports = { THRESHOLD_DEFS, getThresholds, setThreshold, resetThreshold, resetAllThresholds };
