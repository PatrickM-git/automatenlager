-- Migration 0023: RLS-Policies Kern-Tabellen — Stufe 5, Slice 3a (Issue #146).
-- SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md §"Policies (Migration 0022+)"
--
-- ENABLE + FORCE ROW LEVEL SECURITY + einheitliche tenant_isolation-Policy
-- (USING + WITH CHECK) auf den 6 Kern-Tabellen. Das einarmige current_setting
-- ('automatenlager.current_tenant') ohne missing_ok ⇒ fehlender GUC kracht statt
-- still leer (fail-closed). tenant_id ist ueberall TEXT ⇒ text = text, KEIN Cast.
-- Policy gilt fuer PUBLIC: BYPASSRLS-Rollen (homelab Infra, n8n_app) umgehen sie,
-- automatenlager_app (kein BYPASSRLS) wird gefiltert.
--
-- Idempotent (ENABLE/FORCE wiederholbar; DROP POLICY IF EXISTS vor CREATE).
-- Rollback (diszipliniert, nur Infra-Rolle): siehe docs/security/rls-stufe-5-rollback.md.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0023-rls-policies-core.sql

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'machines', 'locations', 'machine_profiles', 'slot_assignments', 'products', 'stock_batches'
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
