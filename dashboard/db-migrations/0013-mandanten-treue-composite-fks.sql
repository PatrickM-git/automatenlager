-- Migration 0013: Mandanten-treue Fremdschluessel (composite FK ueber
-- (tenant_id, parent_id)) — die staerkste Haertung: ein Kind kann NIE auf einen
-- Eltern eines fremden Mandanten zeigen. Plus tenant_id -> tenants(tenant_id)-FK
-- auf allen operativen Tabellen. Stufe 1. Issue #100. Idempotent.
-- Setzt 0010 (Backfill, tenant_id konsistent) + 0012 (Unique-Anker teils) voraus.
--
-- SONDERFAELLE (Live-Schema verifiziert):
--   * machine_profiles.machine_id ist TEXT (= machine_key) und hat HEUTE keinen FK
--     auf machines(machine_id BIGINT) -> aus der composite-Haertung ausgenommen.
--   * Nullbare Kind-FKs nutzen PG16 "ON DELETE SET NULL (spalte)", damit beim
--     Eltern-Loeschen NUR die FK-Spalte genullt wird, nicht das NOT-NULL tenant_id.
--   * Die composite-Haertung folgt den SPEC-Hauptpfaden (Finanz/Bestand/Slot).
--     Weitere Kind-FKs (guv_daily, warnings, product_aliases, product_change_
--     proposals) bleiben Single-FK; der tenant_id->tenants-FK + Backfill sichern
--     ihre Konsistenz. Erweiterbar in einer Folge-Haertung.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0013-mandanten-treue-composite-fks.sql

-- ── 1. System-Default-Vorlage-Mandant ('__default__') ─────────────────────────
-- Die Config-Tabellen tragen read-side weiter eine '__default__'-Vorlagezeile
-- (Stufe 1). Damit der tenant_id->tenants-FK lueckenlos greift, existiert
-- '__default__' als pausierter System-Mandant (kein echter Betrieb).
INSERT INTO automatenlager.tenants (tenant_id, name, status)
VALUES ('__default__', 'System-Default-Vorlage', 'pausiert')
ON CONFLICT (tenant_id) DO NOTHING;

-- ── 2. Eltern-Unique-Anker (tenant_id, parent_pk) ─────────────────────────────
DO $$
DECLARE
  spec JSONB;
  anchors JSONB := '[
    {"t":"machines",         "new":"machines_tenant_uk",         "cols":"tenant_id, machine_id"},
    {"t":"products",         "new":"products_tenant_pk_uk",      "cols":"tenant_id, product_id"},
    {"t":"warehouses",       "new":"warehouses_tenant_uk",       "cols":"tenant_id, warehouse_id"},
    {"t":"slot_assignments", "new":"slot_assignments_tenant_uk", "cols":"tenant_id, slot_assignment_id"},
    {"t":"locations",        "new":"locations_tenant_uk",        "cols":"tenant_id, location_id"},
    {"t":"invoices",         "new":"invoices_tenant_pk_uk",      "cols":"tenant_id, invoice_id"}
  ]';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(anchors) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec->>'new'
                     AND conrelid = ('automatenlager.' || (spec->>'t'))::regclass) THEN
      EXECUTE format('ALTER TABLE automatenlager.%I ADD CONSTRAINT %I UNIQUE (%s)',
                     spec->>'t', spec->>'new', spec->>'cols');
    END IF;
  END LOOP;
END $$;

-- ── 3. tenant_id -> tenants(tenant_id)-FK auf allen operativen Tabellen ────────
DO $$
DECLARE
  t TEXT;
  tabs TEXT[] := ARRAY[
    'machines','locations','machine_profiles','slot_assignments','products',
    'product_aliases','product_change_proposals','stock_batches','stock_movements',
    'sales_transactions','guv_daily','warnings','invoices','invoice_items','suppliers',
    'nayax_devices','workflow_state','prices','settings_thresholds','warehouses'
    -- classification_settings ausgenommen: traegt in Stufe 1 mandant_id (kein
    -- tenant_id-FK moeglich); kommt mit der Angleichung in Stufe 6.
  ];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_tenant_fk'
                     AND conrelid = ('automatenlager.' || t)::regclass) THEN
      EXECUTE format(
        'ALTER TABLE automatenlager.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES automatenlager.tenants(tenant_id)',
        t, t || '_tenant_fk');
    END IF;
  END LOOP;
END $$;

-- ── 4. Composite Kind-FKs (tenant-treu) — alte Single-FK ersetzen ─────────────
DO $$
DECLARE
  spec JSONB;
  -- ondel: '' = NO ACTION, sonst Spaltenname fuer "ON DELETE SET NULL (spalte)".
  fks JSONB := '[
    {"t":"slot_assignments",   "old":"slot_assignments_machine_id_fkey",            "new":"slot_assignments_machine_tenant_fk", "cols":"tenant_id, machine_id",          "ref":"machines",         "rcols":"tenant_id, machine_id",          "ondel":""},
    {"t":"slot_assignments",   "old":"slot_assignments_product_id_fkey",            "new":"slot_assignments_product_tenant_fk", "cols":"tenant_id, product_id",          "ref":"products",         "rcols":"tenant_id, product_id",          "ondel":""},
    {"t":"stock_batches",      "old":"stock_batches_product_id_fkey",               "new":"stock_batches_product_tenant_fk",    "cols":"tenant_id, product_id",          "ref":"products",         "rcols":"tenant_id, product_id",          "ondel":""},
    {"t":"stock_batches",      "old":"stock_batches_machine_id_fkey",               "new":"stock_batches_machine_tenant_fk",    "cols":"tenant_id, machine_id",          "ref":"machines",         "rcols":"tenant_id, machine_id",          "ondel":"machine_id"},
    {"t":"stock_batches",      "old":"stock_batches_warehouse_id_fkey",             "new":"stock_batches_warehouse_tenant_fk",  "cols":"tenant_id, warehouse_id",        "ref":"warehouses",       "rcols":"tenant_id, warehouse_id",        "ondel":"warehouse_id"},
    {"t":"prices",             "old":"prices_slot_assignment_id_fkey",              "new":"prices_slot_tenant_fk",              "cols":"tenant_id, slot_assignment_id",  "ref":"slot_assignments", "rcols":"tenant_id, slot_assignment_id",  "ondel":""},
    {"t":"sales_transactions", "old":"sales_transactions_machine_id_fkey",          "new":"sales_transactions_machine_tenant_fk","cols":"tenant_id, machine_id",         "ref":"machines",         "rcols":"tenant_id, machine_id",          "ondel":""},
    {"t":"sales_transactions", "old":"sales_transactions_slot_assignment_id_fkey",  "new":"sales_transactions_slot_tenant_fk",  "cols":"tenant_id, slot_assignment_id",  "ref":"slot_assignments", "rcols":"tenant_id, slot_assignment_id",  "ondel":"slot_assignment_id"},
    {"t":"invoice_items",      "old":"invoice_items_invoice_id_fkey",               "new":"invoice_items_invoice_tenant_fk",    "cols":"tenant_id, invoice_id",          "ref":"invoices",         "rcols":"tenant_id, invoice_id",          "ondel":""},
    {"t":"warehouses",         "old":"warehouses_location_id_fkey",                 "new":"warehouses_location_tenant_fk",      "cols":"tenant_id, location_id",         "ref":"locations",        "rcols":"tenant_id, location_id",         "ondel":"location_id"}
  ]';
  ondel_clause TEXT;
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(fks) LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I DROP CONSTRAINT IF EXISTS %I', spec->>'t', spec->>'old');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec->>'new'
                     AND conrelid = ('automatenlager.' || (spec->>'t'))::regclass) THEN
      ondel_clause := CASE WHEN (spec->>'ondel') = '' THEN ''
                          ELSE format(' ON DELETE SET NULL (%I)', spec->>'ondel') END;
      EXECUTE format(
        'ALTER TABLE automatenlager.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES automatenlager.%I (%s)%s',
        spec->>'t', spec->>'new', spec->>'cols', spec->>'ref', spec->>'rcols', ondel_clause);
    END IF;
  END LOOP;
END $$;
