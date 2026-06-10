-- Migration 0026: RLS-Policies Config/Rest + Vereinigungs-Policy + (Mat)View-Sicherung
-- Stufe 5, Slice 3d (Issue #149). SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md
--
-- 1) Uniforme tenant_isolation-Policy auf der Config/Rest-Gruppe.
-- 2) Vereinigungs-Policy fuer die geteilte Config classification_settings
--    (Spalte mandant_id / tenant_id nach 0032): LESEN = eigener Mandant ODER '__default__'; SCHREIBEN/
--    LOESCHEN strikt nur eigener Mandant (die __default__-Vorlage ist nur ueber
--    Infra/Migration pflegbar). settings_thresholds traegt aktuell KEINE
--    __default__-Zeile (Defaults stehen im Code) ⇒ uniforme Policy genuegt.
-- 3) security_invoker=true auf den gelesenen Views (v_warnings_open, v_slot_turnover),
--    damit die Basistabellen-RLS unter der App-Rolle greift (sonst laeuft die View
--    als Eigentuemer = RLS-Umgehung).
-- 4) MatView mv_inventory_value_daily kann selbst keine RLS tragen: vorgelagerte
--    security_barrier-View v_inventory_value_daily mit GUC-Filter; App-Rolle liest
--    NUR die View, Direktzugriff auf die rohe MatView wird entzogen.
-- 5) mv_db_per_*-MatViews (keine App-Leser, nur Refresh): App-Direktzugriff entziehen.
--
-- Idempotent. PostgreSQL >= 15 (security_invoker). REFRESH laeuft weiter ueber die
-- Infra-/Owner-Rolle (mandantenuebergreifend, gewollt). Rollback: docs/security/rls-stufe-5-rollback.md.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0026-rls-policies-config-and-views.sql

-- ── 1) Uniforme Policy auf Config/Rest ───────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings_thresholds', 'warehouses', 'prices', 'product_aliases',
    'product_change_proposals', 'workflow_state'
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

-- ── 2) Vereinigungs-Policy: classification_settings (mandant_id oder tenant_id) ──
-- Dynamisch: nach Migration 0032 heißt die Spalte tenant_id; davor mandant_id.
-- Die DO-Block-Erkennung macht 0026 re-entrant auf einem DB-Stand nach 0032.
DO $$
DECLARE col TEXT;
BEGIN
  SELECT column_name INTO col
    FROM information_schema.columns
   WHERE table_schema = 'automatenlager'
     AND table_name   = 'classification_settings'
     AND column_name IN ('mandant_id', 'tenant_id')
   LIMIT 1;
  col := COALESCE(col, 'tenant_id');

  ALTER TABLE automatenlager.classification_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE automatenlager.classification_settings FORCE ROW LEVEL SECURITY;
  EXECUTE 'DROP POLICY IF EXISTS tenant_default_read ON automatenlager.classification_settings';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation    ON automatenlager.classification_settings';

  EXECUTE format(
    'CREATE POLICY tenant_default_read ON automatenlager.classification_settings'
    ' FOR SELECT USING (%I = current_setting(''automatenlager.current_tenant'') OR %I = ''__default__'')',
    col, col);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON automatenlager.classification_settings'
    ' FOR ALL USING (%I = current_setting(''automatenlager.current_tenant''))'
    ' WITH CHECK (%I = current_setting(''automatenlager.current_tenant''))',
    col, col);
END $$;

-- HINWEIS: Die (Mat)View-Sicherung (security_invoker auf v_warnings_open/
-- v_slot_turnover, die security_barrier-View v_inventory_value_daily + MatView-
-- Zugriffsentzug) ist nach 0022 verschoben — sie ist INERT (aktiviert keine
-- Tabellen-RLS) und MUSS vor dem Code-Deploy existieren (economics/assortment
-- lesen v_inventory_value_daily), also vor der gestaffelten Scharfschaltung.
