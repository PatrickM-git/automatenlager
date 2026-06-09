-- Migration 0030: Grants für audit.guv_restatement_log (Issue #180)
-- SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md §"Audit & Rollback"
--
-- Das Restatement-Run 0030 läuft DURCH DIE MANDANTEN-TÜR (lib/tenant-db.js, tx) als
-- eingeengte Rolle `automatenlager_app` (Mitglied von `app_writer`, kein BYPASSRLS).
-- Es schreibt je restateter Zeile einen Eintrag in audit.guv_restatement_log und
-- stempelt beim Rollback rollback_at/by. Die Tabelle wurde in 0028 ohne Grants
-- angelegt — diese Migration ergänzt INSERT/SELECT/UPDATE für `app_writer` (analog
-- zu audit.workflow_runs aus 0027), damit der Door-Pfad nicht an Berechtigungen
-- scheitert. Reines GRANT (idempotent, additiv, rollback-/sandbox-sicher).
--
-- Voraussetzung: out-of-band-Rolle `app_writer` (Pre-Flight #143). Fehlt sie, ist
-- der GRANT ein No-Op-Fehler — daher defensiv geprüft (wie 0022).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    RAISE NOTICE 'Migration 0030: Rolle app_writer fehlt — Grants übersprungen (DB ohne RLS-Rollen).';
    RETURN;
  END IF;
  GRANT INSERT, SELECT, UPDATE ON audit.guv_restatement_log TO app_writer;
  -- Sequenz der BIGSERIAL-PK (für INSERT durch app_writer).
  GRANT USAGE, SELECT ON SEQUENCE audit.guv_restatement_log_id_seq TO app_writer;
END $$;
