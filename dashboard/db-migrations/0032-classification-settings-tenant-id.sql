-- Migration 0032: classification_settings.mandant_id → tenant_id + RLS-Policy-Update.
-- Issue #108 (Stufe 6 Cleanup). Sicher: n8n schreibt nicht in classification_settings
-- (WF8 seit Slice 1 deaktiviert; nur in-process-Code liest diese Tabelle).
-- Idempotent: IF EXISTS-Guard auf RENAME; DROP/CREATE POLICY sind idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'automatenlager'
      AND table_name = 'classification_settings'
      AND column_name = 'mandant_id'
  ) THEN
    ALTER TABLE automatenlager.classification_settings
      RENAME COLUMN mandant_id TO tenant_id;
  END IF;
END $$;

-- RLS-Policies referenzieren den Spaltennamen → nach Rename neu anlegen.
DROP POLICY IF EXISTS tenant_default_read ON automatenlager.classification_settings;
DROP POLICY IF EXISTS tenant_isolation    ON automatenlager.classification_settings;

CREATE POLICY tenant_default_read ON automatenlager.classification_settings
  FOR SELECT
  USING (tenant_id = current_setting('automatenlager.current_tenant', true)
      OR tenant_id = '__default__');

CREATE POLICY tenant_isolation ON automatenlager.classification_settings
  FOR ALL
  USING (tenant_id = current_setting('automatenlager.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('automatenlager.current_tenant', true));
