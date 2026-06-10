-- Migration 0033: n8n_app verliert BYPASSRLS (Issue #164, Slice 4 Abschluss).
-- DEPLOY-GATED: erst NACH n8n-Abschaltung + Issue #198 Cutover anwenden.
-- Danach gilt RLS systemweit — kein Prozess mehr im Bypass.
-- Rückweg: ALTER ROLE n8n_app BYPASSRLS; (nur nötig, wenn n8n wieder gestartet wird).

ALTER ROLE n8n_app NOBYPASSRLS;
