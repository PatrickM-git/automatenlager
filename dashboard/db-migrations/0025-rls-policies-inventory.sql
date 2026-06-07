-- Migration 0025: RLS-Policies Inventory/Stock — Stufe 5, Slice 3c (Issue #148).
-- SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md §"Policies (Migration 0022+)"
--
-- Wie 0023, fuer die Inventory-/Stock-Gruppe. Einheitliche tenant_isolation-Policy
-- (USING + WITH CHECK), ENABLE + FORCE, einarmiges current_setting (fail-closed).
-- Idempotent. Anwenden: psql $PGURL -f dashboard/db-migrations/0025-rls-policies-inventory.sql

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stock_movements', 'sales_transactions', 'suppliers', 'nayax_devices'
  ]
  LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE automatenlager.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON automatenlager.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON automatenlager.%I'
      || ' USING (tenant_id = current_setting(''automatenlager.current_tenant''))'
      || ' WITH CHECK (tenant_id = current_setting(''automatenlager.current_tenant''))', t);
  END LOOP;
END
$$;
