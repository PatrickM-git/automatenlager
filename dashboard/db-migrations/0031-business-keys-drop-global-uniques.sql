-- Migration 0031: globale (key)-Uniques droppen → nur noch (tenant_id, key).
-- Issue #111, Teil der n8n-Abloesung Stufe 6 / Abschluss-Slice #164.
-- SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Migrationen 0027+".
--
-- KONTEXT: In Stufe 1 (0012/0015) wurden die fachlichen (tenant_id, key)-Uniques
-- ADDITIV danebengelegt; die alten globalen (key)-Uniques BLIEBEN, weil der
-- laufende n8n-Schreibpfad (pgw_write + WF*) `ON CONFLICT (key)` nutzte und ein
-- Umbau das mit 42P10 gebrochen haette (Story 23). Mit der n8n-Abloesung gehen
-- alle Schreiber durch die Mandanten-Tuer mit `ON CONFLICT (tenant_id, key)` —
-- jetzt koennen die globalen (key)-Uniques weg, und "gleicher Geschaeftsschluessel
-- bei zwei Mandanten = zwei Zeilen" wird scharf (#99).
--
-- DEPLOY-GATING: Diese DDL erst anwenden, wenn KEIN n8n-Schreiber mehr `ON CONFLICT
-- (key)` nutzt (n8n abgeschaltet, #198-Cutover durch). Vorher bricht pgw_write.
-- Idempotent (IF EXISTS), sandbox-/rollback-sicher.
--
-- NICHT hier: external_transaction_id-Umbenennung (#102/#108) und product_slot_key/
-- nayax_machine_id (nicht in #111-Scope) bleiben unveraendert.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0031-business-keys-drop-global-uniques.sql

-- ── 1) Globale (key)-Unique-CONSTRAINTS droppen (composite (tenant_id, key) bleibt) ──
ALTER TABLE automatenlager.products                 DROP CONSTRAINT IF EXISTS products_product_key_key;
ALTER TABLE automatenlager.stock_batches            DROP CONSTRAINT IF EXISTS stock_batches_batch_key_key;
ALTER TABLE automatenlager.suppliers                DROP CONSTRAINT IF EXISTS suppliers_supplier_key_key;
ALTER TABLE automatenlager.warnings                 DROP CONSTRAINT IF EXISTS warnings_warning_key_key;
ALTER TABLE automatenlager.invoices                 DROP CONSTRAINT IF EXISTS invoices_invoice_key_key;
ALTER TABLE automatenlager.guv_daily                DROP CONSTRAINT IF EXISTS guv_daily_guv_key_key;
ALTER TABLE automatenlager.stock_movements          DROP CONSTRAINT IF EXISTS stock_movements_movement_key_key;
ALTER TABLE automatenlager.product_change_proposals DROP CONSTRAINT IF EXISTS product_change_proposals_proposal_key_key;
ALTER TABLE automatenlager.product_aliases          DROP CONSTRAINT IF EXISTS product_aliases_alias_source_key;
ALTER TABLE automatenlager.invoice_items            DROP CONSTRAINT IF EXISTS invoice_items_invoice_id_line_number_key;
ALTER TABLE automatenlager.sales_transactions       DROP CONSTRAINT IF EXISTS sales_transactions_nayax_transaction_id_key;

-- ── 2) Aktiver-Slot-Unique: globaler idx_slot_active weg; idx_slot_active_tenant
--        (aus 0012, tenant-fuehrend) bleibt das einzige Aktiv-Slot-Unique. ──
DROP INDEX IF EXISTS automatenlager.idx_slot_active;

-- ── 3) workflow_state-PK von (workflow_key) auf (tenant_id, workflow_key) umstellen.
--        Der redundante workflow_state_tenant_uk (0012) wird dann durch den neuen
--        PK ersetzt. Idempotent ueber Spaltensatz-Pruefung. ──
DO $$
DECLARE
  pk_cols TEXT;
BEGIN
  SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) INTO pk_cols
    FROM pg_constraint c
    JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'automatenlager.workflow_state'::regclass AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM 'tenant_id,workflow_key' THEN
    -- tenant_id muss NOT NULL sein, damit es Teil des PK werden kann (0010/0017 backfill).
    ALTER TABLE automatenlager.workflow_state ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE automatenlager.workflow_state DROP CONSTRAINT IF EXISTS workflow_state_pkey;
    ALTER TABLE automatenlager.workflow_state
      ADD CONSTRAINT workflow_state_pkey PRIMARY KEY (tenant_id, workflow_key);
  END IF;

  -- Redundanten (tenant_id, workflow_key)-Unique aus 0012 entfernen (PK deckt ihn jetzt ab).
  ALTER TABLE automatenlager.workflow_state DROP CONSTRAINT IF EXISTS workflow_state_tenant_uk;
END $$;
