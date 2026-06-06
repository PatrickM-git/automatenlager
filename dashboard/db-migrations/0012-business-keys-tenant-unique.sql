-- Migration 0012: fachliche Schluessel mandanten-eindeutig — ADDITIV.
-- Stufe 1. Issue #99. Idempotent. Setzt 0010 voraus.
--
-- REVIDIERT NACH DEPLOY-PRUEFUNG (kritisch): Die alten (key)-Unique-Constraints
-- werden NICHT ersetzt, sondern die (tenant_id, key)-Uniques werden ADDITIV
-- danebengelegt. Grund: der laufende n8n-Schreibpfad (DB-Funktion pgw_write und
-- mehrere WF*) nutzt `ON CONFLICT (product_key | batch_key | nayax_transaction_id
-- | guv_key | warning_key | proposal_key | workflow_key | ...)`. `ON CONFLICT (col)`
-- braucht einen Unique mit EXAKT diesen Spalten — ein Umbau auf (tenant_id, col)
-- bricht das mit Fehler 42P10 und legt damit WF3 (alle 5 Min), WF2, WF8 lahm.
-- Das verletzt SPEC-Story 23 ("laufender Betrieb bricht nicht").
--
-- Folge: In Stufe 1 existieren BEIDE Uniques nebeneinander (im Single-Tenant ist
-- der (tenant_id, key)-Unique redundant zum globalen (key)-Unique, aber harmlos
-- und legt das RLS-Fundament). Das WEGNEHMEN der alten globalen (key)-Uniques +
-- die Umstellung von pgw_write/WF auf `ON CONFLICT (tenant_id, key)` ist an die
-- n8n-Abloesung (Stufe 6) gekoppelt — erst dann wird "gleicher Key bei zwei
-- Mandanten = zwei Zeilen" wirklich scharf. (Folge-Issue dokumentiert.)
--
-- sales_transactions wird hier NICHT angefasst — sein (tenant_id, provider,
-- nayax_transaction_id)-Unique kommt provider-aware in 0015 (#102), ebenfalls additiv.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0012-business-keys-tenant-unique.sql

-- ── (tenant_id, key)-Uniques ADDITIV (alte (key)-Uniques bleiben unberuehrt) ──
DO $$
DECLARE
  spec JSONB;
  specs JSONB := '[
    {"t":"products",                 "new":"products_tenant_uk",                 "cols":"tenant_id, product_key"},
    {"t":"stock_batches",            "new":"stock_batches_tenant_uk",            "cols":"tenant_id, batch_key"},
    {"t":"suppliers",                "new":"suppliers_tenant_uk",                "cols":"tenant_id, supplier_key"},
    {"t":"warnings",                 "new":"warnings_tenant_uk",                 "cols":"tenant_id, warning_key"},
    {"t":"product_change_proposals", "new":"product_change_proposals_tenant_uk", "cols":"tenant_id, proposal_key"},
    {"t":"product_aliases",          "new":"product_aliases_tenant_uk",          "cols":"tenant_id, alias, source"},
    {"t":"invoices",                 "new":"invoices_tenant_uk",                 "cols":"tenant_id, invoice_key"},
    {"t":"invoice_items",            "new":"invoice_items_tenant_uk",            "cols":"tenant_id, invoice_id, line_number"},
    {"t":"guv_daily",                "new":"guv_daily_tenant_uk",                "cols":"tenant_id, guv_key"},
    {"t":"stock_movements",          "new":"stock_movements_tenant_uk",          "cols":"tenant_id, movement_key"},
    {"t":"workflow_state",           "new":"workflow_state_tenant_uk",           "cols":"tenant_id, workflow_key"}
  ]';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(specs) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec->>'new'
                     AND conrelid = ('automatenlager.' || (spec->>'t'))::regclass) THEN
      EXECUTE format('ALTER TABLE automatenlager.%I ADD CONSTRAINT %I UNIQUE (%s)',
                     spec->>'t', spec->>'new', spec->>'cols');
    END IF;
  END LOOP;
END $$;

-- slot_assignments: aktiver-Slot-Unique zusaetzlich tenant-fuehrend (ADDITIV; der
-- bestehende idx_slot_active bleibt, weil ON CONFLICT-/Aktiv-Slot-Logik darauf baut).
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_active_tenant
  ON automatenlager.slot_assignments (tenant_id, machine_id, mdb_code)
  WHERE active = true;
