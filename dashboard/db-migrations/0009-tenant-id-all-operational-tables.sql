-- Migration 0009: tenant_id auf ALLE operativen Tabellen (die EINE Regel) + Index,
-- plus Angleichung classification_settings.mandant_id -> tenant_id.
-- Stufe 1 der Multi-Tenant-SPEC. Issue #96. Idempotent. Setzt 0007 voraus.
--
-- DEFAULT '__default__' ist hier nur das MIGRATIONS-SICHERHEITSNETZ, damit
-- ADD COLUMN NOT NULL auf bestehenden Zeilen nicht scheitert. Der reale Mandant +
-- Backfill + differenzierte Default-Strategie folgen in 0010 (#97). Die
-- tenant_id -> tenants(tenant_id)-FK folgt NACH dem Backfill in 0013 (#100),
-- sonst entstehen verwaiste '__default__'-Werte.
--
-- Erfasst zusaetzlich stock_movements: in der urspruenglichen Issue-Liste
-- uebersehen (Audit zaehlte "18 von 20"), aber eine operative Tabelle mit
-- tenant-tragenden Eltern (batch_id). Die SPEC-Kernregel "jede operative Tabelle,
-- keine Ausnahmen" verlangt sie -> bewusst mit aufgenommen (Backfill 0010, Auto-
-- Fill-Trigger 0014).
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0009-tenant-id-all-operational-tables.sql

-- ──────────────────────────────────────────────────────────────────────────────
-- tenant_id TEXT NOT NULL DEFAULT '__default__' + Index je operativer Tabelle
-- ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  -- settings_thresholds traegt tenant_id bereits; classification_settings wird
  -- weiter unten umbenannt. Beide hier NICHT enthalten.
  tables TEXT[] := ARRAY[
    'machines', 'locations', 'machine_profiles', 'slot_assignments',
    'products', 'product_aliases', 'product_change_proposals',
    'stock_batches', 'stock_movements', 'sales_transactions', 'guv_daily',
    'warnings', 'invoices', 'invoice_items', 'suppliers',
    'nayax_devices', 'workflow_state', 'prices'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE automatenlager.%I ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT %L',
      t, '__default__');
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_tenant ON automatenlager.%I (tenant_id)',
      t, t);
  END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- ANGLEICHUNG classification_settings.mandant_id -> tenant_id: BEWUSST NICHT in
-- Stufe 1. Grund (Deploy-Pruefung): WF8 (GuV-Aggregator, alle 15 Min) liest
-- hartcodiert `SELECT config FROM classification_settings WHERE mandant_id=...`.
-- Eine Umbenennung wuerde WF8 mit "column mandant_id does not exist" brechen
-- (Story 23). Die Spalte bleibt daher `mandant_id`; der Dashboard-Code liest sie
-- ueber die Bruecke category-config.js::tenantColumn() (erkennt mandant_id).
-- Die Angleichung auf tenant_id erfolgt mit der n8n-Abloesung in Stufe 6
-- (gleicher Zeitpunkt wie der Drop der globalen (key)-Uniques, Issue #111).
-- classification_settings ist daher von der Tenant-Pflicht-Liste (db-schema.js)
-- in Stufe 1 ausgenommen — es traegt seine Mandanten-Dimension als `mandant_id`.
