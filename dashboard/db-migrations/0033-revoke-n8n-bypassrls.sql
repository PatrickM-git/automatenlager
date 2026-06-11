-- Migration 0033: n8n_app verliert BYPASSRLS (Issue #164, Slice 4 Abschluss).
-- DEPLOY-GATED: erst NACH n8n-Abschaltung + Issue #198 Cutover anwenden.
-- Danach gilt RLS systemweit — kein Prozess mehr im Bypass.
-- Rückweg: ALTER ROLE n8n_app BYPASSRLS; (nur nötig, wenn n8n wieder gestartet wird).
--
-- BEDINGT (Issue #214, Cloud-Migration Slice 1): Auf Supabase existiert die Rolle
-- `n8n_app` NIE (n8n lief nur auf dem Mini) — ein unbedingtes ALTER ROLE würde dort
-- mit „role does not exist" hart fehlschlagen und die Migrationskette abbrechen.
-- Daher rollen-bedingt + idempotent (gleiches Muster wie 0030/0036-Grants).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_app') THEN
    ALTER ROLE n8n_app NOBYPASSRLS;
  ELSE
    RAISE NOTICE 'Migration 0033: Rolle n8n_app fehlt — übersprungen (z. B. Supabase, wo n8n nie existierte).';
  END IF;
END $$;
