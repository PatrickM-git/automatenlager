-- Migration 0034: classification_settings-RLS zurück auf fail-closed (Audit 2026-06-10).
--
-- Migration 0032 hat bei der Policy-Neuerstellung versehentlich
-- current_setting(..., true) (missing_ok) eingeführt — abweichend von 0023–0026,
-- deren einarmige Form der dokumentierte Standard ist: fehlender GUC ⇒ Fehler 42704
-- statt stiller Ergebnisse (vgl. docs/specs/multi-tenant-rls-stufe-5-v1.md).
-- Beleg, dass missing_ok keinen Anwendungsfall hat: ALLE Leser von
-- classification_settings (category-config.js, jobs/guv-aggregate.js,
-- jobs/guv-backfill.js) gehen durch die Mandanten-Tür (lib/tenant-db.js), die den
-- GUC immer setzt; Migrationen und MatView-Refresh laufen über die Infra-Rolle
-- (RLS-befreit). missing_ok nähme nur die Eigenschaft, dass eine künftige
-- Tür-Umgehung sofort kracht statt still nur __default__-Zeilen zu liefern.
--
-- Stellt die beiden Policies in der 0026-Form (einarmig, fail-closed) wieder her.
-- Idempotent (DROP IF EXISTS + CREATE). 0032 bleibt unverändert (lief bereits).
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0034-classification-settings-fail-closed.sql

DROP POLICY IF EXISTS tenant_default_read ON automatenlager.classification_settings;
DROP POLICY IF EXISTS tenant_isolation    ON automatenlager.classification_settings;

CREATE POLICY tenant_default_read ON automatenlager.classification_settings
  FOR SELECT
  USING (tenant_id = current_setting('automatenlager.current_tenant')
      OR tenant_id = '__default__');

CREATE POLICY tenant_isolation ON automatenlager.classification_settings
  FOR ALL
  USING (tenant_id = current_setting('automatenlager.current_tenant'))
  WITH CHECK (tenant_id = current_setting('automatenlager.current_tenant'));
