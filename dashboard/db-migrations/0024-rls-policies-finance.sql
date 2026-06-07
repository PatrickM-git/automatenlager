-- Migration 0024: RLS-Policies Finanz/GuV — Stufe 5, Slice 3b (Issue #147).
-- SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md §"Policies (Migration 0022+)"
--
-- Wie 0023, fuer die Finanz-/GuV-Gruppe. Einheitliche tenant_isolation-Policy
-- (USING + WITH CHECK), ENABLE + FORCE, einarmiges current_setting (fail-closed).
-- Idempotent. Anwenden: psql $PGURL -f dashboard/db-migrations/0024-rls-policies-finance.sql

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invoices', 'invoice_items', 'guv_daily', 'warnings'
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
