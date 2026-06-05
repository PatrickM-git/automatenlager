-- Migration #31: settings_thresholds — mandanten-/automaten-parametrische Schwellwerte
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0002-settings-thresholds.sql
-- Reihenfolge: kein Vorgänger erforderlich.

CREATE TABLE IF NOT EXISTS automatenlager.settings_thresholds (
  tenant_id   TEXT        NOT NULL DEFAULT '__default__',
  machine_id  INTEGER     NULL
    REFERENCES automatenlager.machines(machine_id) ON DELETE CASCADE,
  key         TEXT        NOT NULL,
  value       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_thresholds_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id, key)
);

COMMENT ON TABLE automatenlager.settings_thresholds IS
  'Mandanten-/Automaten-parametrische Schwellwerte (ladenhueterDays etc.). '
  'machine_id NULL = global; gesetztes machine_id = Automat-Override (schlägt global vor).';

COMMENT ON COLUMN automatenlager.settings_thresholds.tenant_id IS
  'Mandant, Default "__default__" (Single-Tenant).';

COMMENT ON COLUMN automatenlager.settings_thresholds.machine_id IS
  'NULL = mandant-globaler Override; integer = Pro-Automat-Override.';

COMMENT ON COLUMN automatenlager.settings_thresholds.key IS
  'Schwellwert-Schlüssel, z. B. "ladenhueterDays".';

COMMENT ON COLUMN automatenlager.settings_thresholds.value IS
  'JSONB-Wert (Zahl als JSON-Zahl, z. B. 45).';
