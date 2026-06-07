-- Migration 0026: RLS-Policies Config/Rest + Vereinigungs-Policy + (Mat)View-Sicherung
-- Stufe 5, Slice 3d (Issue #149). SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md
--
-- 1) Uniforme tenant_isolation-Policy auf der Config/Rest-Gruppe.
-- 2) Vereinigungs-Policy fuer die geteilte Config classification_settings
--    (Spalte mandant_id!): LESEN = eigener Mandant ODER '__default__'; SCHREIBEN/
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

-- ── 2) Vereinigungs-Policy: classification_settings (Spalte mandant_id) ───────
ALTER TABLE automatenlager.classification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE automatenlager.classification_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_default_read ON automatenlager.classification_settings;
DROP POLICY IF EXISTS tenant_isolation   ON automatenlager.classification_settings;
-- Lesen: eigener Mandant ODER die geteilte __default__-Vorlage.
CREATE POLICY tenant_default_read ON automatenlager.classification_settings
  FOR SELECT
  USING (mandant_id = current_setting('automatenlager.current_tenant') OR mandant_id = '__default__');
-- Schreiben/Aendern/Loeschen: strikt nur eigener Mandant (USING schuetzt __default__
-- vor UPDATE/DELETE; WITH CHECK verhindert Schreiben fremder/__default__-Zeilen).
CREATE POLICY tenant_isolation ON automatenlager.classification_settings
  FOR ALL
  USING (mandant_id = current_setting('automatenlager.current_tenant'))
  WITH CHECK (mandant_id = current_setting('automatenlager.current_tenant'));

-- ── 3) security_invoker auf gelesenen Views (Basistabellen-RLS greift) ────────
ALTER VIEW automatenlager.v_warnings_open SET (security_invoker = true);
ALTER VIEW automatenlager.v_slot_turnover SET (security_invoker = true);

-- ── 4) MatView mv_inventory_value_daily: security_barrier-View + Zugriff einengen
CREATE OR REPLACE VIEW automatenlager.v_inventory_value_daily
  WITH (security_barrier = true) AS
  SELECT * FROM automatenlager.mv_inventory_value_daily
   WHERE tenant_id = current_setting('automatenlager.current_tenant');
GRANT SELECT ON automatenlager.v_inventory_value_daily TO automatenlager_app;
-- App-Tier verliert Direktzugriff auf die rohe MatView (liest nur die GUC-View).
REVOKE ALL ON automatenlager.mv_inventory_value_daily FROM app_writer, app_reader;

-- ── 5) mv_db_per_* (keine App-Leser): App-Direktzugriff entziehen ─────────────
REVOKE ALL ON automatenlager.mv_db_per_product_monthly FROM app_writer, app_reader;
REVOKE ALL ON automatenlager.mv_db_per_slot_monthly    FROM app_writer, app_reader;
