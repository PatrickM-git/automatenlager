-- Supabase Slice 1 (Issue #214): out-of-band Rollen-Bootstrap.
-- ------------------------------------------------------------
-- VOR dem Schema-Restore als `postgres` (Session-Pooler, Port 5432) ausführen.
-- Bildet die Mini-Rollenlandschaft (Pre-Flight #143) auf Supabase ab:
--   app_reader / app_writer  — NOLOGIN-Gruppenrollen (Objekt-Grants kommen mit
--                              dem Schema-Dump bzw. den Migrationen 0022+)
--   automatenlager_app       — App-Pool-Rolle, LOGIN, KEIN BYPASSRLS (auf
--                              Supabase für Custom-Rollen ohnehin unmöglich)
-- `n8n_app` wird BEWUSST NICHT angelegt: n8n lief nur auf dem Mini; Migration
-- 0033 ist rollen-bedingt und skippt sauber.
--
-- Infra-Pool = `postgres` (Supabase-Default, rolbypassrls=true) — Äquivalent
-- zur Mini-Eigentümerrolle für Bootstrap/Migrationen/MatView-Refresh.
--
-- Passwort wird NICHT hier gesetzt (kein Secret in Git). Out-of-band danach:
--   ALTER ROLE automatenlager_app PASSWORD '<aus dem Passwortmanager>';
-- App-Pool-URL (Transaction-Pooler, Port 6543):
--   postgresql://automatenlager_app.<projekt-ref>:<pw>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_reader') THEN
    CREATE ROLE app_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    CREATE ROLE app_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automatenlager_app') THEN
    CREATE ROLE automatenlager_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- postgres braucht die Mitgliedschaft, um SET ROLE automatenlager_app zu können
-- (Isolationssuite + 0022-Anwendung). Auf PG16+ bekommt der CREATEROLE-Ersteller
-- die Mitgliedschaft automatisch — idempotent absichern.
GRANT automatenlager_app TO postgres;

-- BEWUSSTE ABWEICHUNG von der SPEC: KEINE GUC-Vorregistrierung
-- (ALTER DATABASE … SET automatenlager.current_tenant = ''). Ein registrierter
-- Leerwert würde das fail-closed-Verhalten aufweichen: fehlender Mandant müsste
-- mit 42704 krachen (Migration 0034 + Test), nicht still '' liefern.
-- set_config('automatenlager.current_tenant', $1, true) funktioniert auf
-- Supabase auch ohne Vorregistrierung (live verifiziert 2026-06-11).
