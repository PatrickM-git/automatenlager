-- Migration 0022: RLS-App-Rolle + Grants/Revokes — Stufe 5, Slice 2 (Issue #145).
-- SPEC: docs/specs/multi-tenant-rls-stufe-5-v1.md §"Rollen & Verbindungen"
--
-- Legt die eingeengte, NICHT-besitzende, RLS-unterworfene App-Rolle
-- `automatenlager_app` an (KEIN BYPASSRLS, KEIN Tabellen-Eigentum) und verkabelt
-- ihre Rechte über die bereits existierende, out-of-band angelegte Rollen-
-- Hierarchie (app_reader/app_writer/n8n_app — verifiziert via Pre-Flight #143,
-- NICHT im Repo). Anders als die SPEC ursprünglich annahm ("keine Rollen
-- vorhanden") wird `automatenlager_app` Mitglied von `app_writer` (erbt die
-- korrekten operativen INSERT/SELECT/UPDATE-Grants + Schema-/Sequenz-USAGE +
-- View-SELECT) statt alle Grants neu aufzubauen.
--
-- Idempotent (DO-Blöcke, IF [NOT] EXISTS). KEIN Passwort hier (Secret gehört nicht
-- in Git) — das Login-Passwort wird beim Live-Rollout via `ALTER ROLE ... PASSWORD`
-- gesetzt und in dashboard/.env.local (DASHBOARD_V2_APP_PG_URL) hinterlegt.
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0022-rls-app-role-and-grants.sql
-- Rollback siehe docs/security/rls-stufe-5-rollback.md.

-- ── 0) Vorbedingung: die out-of-band Funktions-Rollen müssen existieren (#143) ─
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    RAISE EXCEPTION 'Migration 0022 setzt die out-of-band-Rolle app_writer voraus (Pre-Flight #143) — auf dieser DB nicht vorhanden.';
  END IF;
END
$$;

-- ── 1) App-Rolle anlegen (Login, NICHT privilegiert) ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automatenlager_app') THEN
    CREATE ROLE automatenlager_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- search_path härten (CVE-2018-1058-Klasse: keine unqualifizierte Auflösung in ein
-- vom Angreifer beschreibbares Schema). Voll qualifiziert + festes pg_temp am Ende.
ALTER ROLE automatenlager_app SET search_path = automatenlager, pg_catalog, pg_temp;

-- ── 2) Operative Rechte über die app_writer-Mitgliedschaft erben ─────────────
-- app_writer: INSERT/SELECT/UPDATE auf den 27 operativen Tabellen + USAGE auf
-- Schema/Sequenzen + SELECT auf v_warnings_open/v_slot_turnover (Pre-Flight #143).
GRANT app_writer TO automatenlager_app;

-- ── 3) DELETE-Lücke schließen (app_writer hat KEIN DELETE) ───────────────────
-- Einzige Lösch-Pfade der App (verifiziert gegen den Code): locations
-- (deleteLocationPg) + settings_thresholds (resetThreshold).
GRANT DELETE ON automatenlager.locations         TO automatenlager_app;
GRANT DELETE ON automatenlager.settings_thresholds TO automatenlager_app;

-- ── 4) Registry-Tabellen für die App-Tier-Rollen sperren ─────────────────────
-- tenants/tenant_users/platform_admins sind Infra-Territorium (Auth/Verzeichnis),
-- werden NUR über die Infra-/BYPASSRLS-Verbindung (Owner homelab) gelesen, NIE
-- durch die Tür. Die App-Rolle darf darauf KEINEN Direktzugriff haben. Da
-- automatenlager_app (und n8n_app) ihre Registry-Rechte ausschließlich über
-- app_writer ERBEN (n8n_app hat keine Registry-Direkt-Grants — #143), wird der
-- Zugriff an der Wurzel entzogen: REVOKE von app_writer (+ app_reader). n8n
-- schreibt keine Auth-Registry (operative WFs), bleibt also funktionsfähig und
-- umgeht RLS ohnehin (Schritt 5).
REVOKE ALL ON automatenlager.tenants         FROM app_writer, app_reader;
REVOKE ALL ON automatenlager.tenant_users    FROM app_writer, app_reader;
REVOKE ALL ON automatenlager.platform_admins FROM app_writer, app_reader;

-- ── 5) n8n bewusst AUSSERHALB des Backstops (bis Stufe 6) ─────────────────────
-- n8n_app (WF3/WF7) schreibt außerhalb der Tür ohne GUC. Ohne BYPASSRLS bräche es
-- unter FORCE RLS (Slice 3). SPEC US14: n8n bleibt dokumentiert außerhalb des
-- Backstops. homelab (Owner) hat BYPASSRLS bereits.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_app') THEN
    ALTER ROLE n8n_app WITH BYPASSRLS;
  END IF;
END
$$;

-- ── 6) (Mat)View-Sicherung — INERT, aktiviert KEINE Tabellen-RLS ──────────────
-- Bewusst hier (Rollen-Migration, vor der gestaffelten Scharfschaltung 0023-0026):
-- diese Schritte sind harmlos, solange keine Tabellen-Policy greift, MUESSEN aber
-- vor dem Code-Deploy existieren (economics.js/assortment-slots.js lesen die
-- Security-View v_inventory_value_daily statt der rohen MatView).
--
-- security_invoker=true auf den gelesenen Views: erst wirksam, wenn die
-- Basistabellen-RLS scharf ist (0023/0024) UND als App-Rolle gelesen wird.
ALTER VIEW automatenlager.v_warnings_open SET (security_invoker = true);
ALTER VIEW automatenlager.v_slot_turnover SET (security_invoker = true);

-- MatView mv_inventory_value_daily kann selbst keine RLS tragen: vorgelagerte
-- security_barrier-View mit GUC-Filter; App liest NUR diese View.
CREATE OR REPLACE VIEW automatenlager.v_inventory_value_daily
  WITH (security_barrier = true) AS
  SELECT * FROM automatenlager.mv_inventory_value_daily
   WHERE tenant_id = current_setting('automatenlager.current_tenant');
GRANT SELECT ON automatenlager.v_inventory_value_daily TO automatenlager_app;
-- App-Tier verliert Direktzugriff auf die rohen MatViews (liest nur die GUC-View).
REVOKE ALL ON automatenlager.mv_inventory_value_daily   FROM app_writer, app_reader;
REVOKE ALL ON automatenlager.mv_db_per_product_monthly  FROM app_writer, app_reader;
REVOKE ALL ON automatenlager.mv_db_per_slot_monthly     FROM app_writer, app_reader;
