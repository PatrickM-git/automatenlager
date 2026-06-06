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
-- Angleichung: classification_settings.mandant_id -> tenant_id (einheitlicher
-- Spaltenname ueberall). Idempotent (nur umbenennen, wenn alt da & neu fehlt).
-- Der PK-Constraint (classification_settings_pkey) bleibt erhalten.
-- ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='automatenlager' AND table_name='classification_settings'
           AND column_name='mandant_id')
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='automatenlager' AND table_name='classification_settings'
           AND column_name='tenant_id')
  THEN
    ALTER TABLE automatenlager.classification_settings RENAME COLUMN mandant_id TO tenant_id;
  END IF;
END $$;

COMMENT ON COLUMN automatenlager.classification_settings.tenant_id IS
  'Mandant (angeglichen von mandant_id in 0009). UI-/Fachbegriff bleibt "Mandant".';
