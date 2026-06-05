-- Migration 0012: fachliche Unique-Constraints mandanten-eindeutig machen
-- (tenant_id vorangestellt). Derselbe Geschaeftsschluessel bei zwei Mandanten ->
-- zwei saubere Zeilen. Stufe 1. Issue #99. Idempotent. Setzt 0010 (Backfill) voraus.
--
-- Constraint-Namen aus dem LIVE-Schema verifiziert (mehrere wichen von der SPEC ab):
--   product_aliases real UNIQUE(alias, source)  [nicht (product_id, alias_type, ...)]
--   invoices       real UNIQUE(invoice_key)     [nicht (invoice_number, supplier_id)]
--   slot_assignments real partieller UNIQUE INDEX idx_slot_active(machine_id,mdb_code) WHERE active
--
-- BEWUSSTE ENTSCHEIDUNGEN:
--   * prices: hat HEUTE KEIN fachliches Unique (nur einen non-unique Index), 0
--     Duplikate. Es wird KEINS neu erzwungen — ein Unique auf (slot_assignment_id,
--     valid_from) wuerde fn_update_price_from_sale-Inserts mit gleichem
--     settlement_at blockieren. tenant_id ist als Spalte (0009) vorhanden (RLS).
--   * sales_transactions: hier nur (tenant_id, nayax_transaction_id). Die provider-
--     Dimension folgt in 0015 (#102) -> dort wird der Unique provider-aware.
--   * guv_daily / stock_movements: in der #99-Liste nicht aufgefuehrt, aber mit
--     fachlichem Key (guv_key/movement_key) und gleicher Cross-Tenant-Kollisions-
--     gefahr -> konsistent mit aufgenommen (keine Ausnahmen).
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0012-business-keys-tenant-unique.sql

-- ── Named-UNIQUE-Constraints: alt droppen, tenant-fuehrend neu anlegen ─────────
DO $$
DECLARE
  spec JSONB;
  specs JSONB := '[
    {"t":"products",                 "old":"products_product_key_key",                         "new":"products_tenant_uk",                 "cols":"tenant_id, product_key"},
    {"t":"stock_batches",            "old":"stock_batches_batch_key_key",                      "new":"stock_batches_tenant_uk",            "cols":"tenant_id, batch_key"},
    {"t":"suppliers",                "old":"suppliers_supplier_key_key",                       "new":"suppliers_tenant_uk",                "cols":"tenant_id, supplier_key"},
    {"t":"warnings",                 "old":"warnings_warning_key_key",                         "new":"warnings_tenant_uk",                 "cols":"tenant_id, warning_key"},
    {"t":"product_change_proposals", "old":"product_change_proposals_proposal_key_key",        "new":"product_change_proposals_tenant_uk", "cols":"tenant_id, proposal_key"},
    {"t":"product_aliases",          "old":"product_aliases_alias_source_key",                 "new":"product_aliases_tenant_uk",          "cols":"tenant_id, alias, source"},
    {"t":"invoices",                 "old":"invoices_invoice_key_key",                         "new":"invoices_tenant_uk",                 "cols":"tenant_id, invoice_key"},
    {"t":"invoice_items",            "old":"invoice_items_invoice_id_line_number_key",         "new":"invoice_items_tenant_uk",            "cols":"tenant_id, invoice_id, line_number"},
    {"t":"sales_transactions",       "old":"sales_transactions_nayax_transaction_id_key",      "new":"sales_transactions_tenant_uk",       "cols":"tenant_id, nayax_transaction_id"},
    {"t":"guv_daily",                "old":"guv_daily_guv_key_key",                            "new":"guv_daily_tenant_uk",                "cols":"tenant_id, guv_key"},
    {"t":"stock_movements",          "old":"stock_movements_movement_key_key",                 "new":"stock_movements_tenant_uk",          "cols":"tenant_id, movement_key"}
  ]';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(specs) LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I DROP CONSTRAINT IF EXISTS %I',
                   spec->>'t', spec->>'old');
    IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = spec->>'new'
             AND conrelid = ('automatenlager.' || (spec->>'t'))::regclass)
    THEN
      EXECUTE format('ALTER TABLE automatenlager.%I ADD CONSTRAINT %I UNIQUE (%s)',
                     spec->>'t', spec->>'new', spec->>'cols');
    END IF;
  END LOOP;
END $$;

-- ── slot_assignments: partieller aktiver Slot-Unique tenant-fuehrend ───────────
-- Neuer Indexname, damit Drop/Create idempotent bleibt.
DROP INDEX IF EXISTS automatenlager.idx_slot_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_active_tenant
  ON automatenlager.slot_assignments (tenant_id, machine_id, mdb_code)
  WHERE active = true;

-- ── workflow_state: PK (workflow_key) -> (tenant_id, workflow_key) ─────────────
DO $$
BEGIN
  ALTER TABLE automatenlager.workflow_state DROP CONSTRAINT IF EXISTS workflow_state_pkey;
  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'workflow_state_pkey'
           AND conrelid = 'automatenlager.workflow_state'::regclass)
  THEN
    ALTER TABLE automatenlager.workflow_state
      ADD CONSTRAINT workflow_state_pkey PRIMARY KEY (tenant_id, workflow_key);
  END IF;
END $$;
