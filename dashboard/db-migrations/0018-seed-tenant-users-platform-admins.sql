-- Migration 0018: Seed tenant_users + platform_admins (Stufe 2, Issue #115)
-- SPEC: docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md
--
-- Befuellt die in 0007 angelegten, leeren Verzeichnis-Tabellen mit den realen
-- Faltrix-Logins, damit der Stufe-2-Code Login -> tenant_id ueberhaupt aufloesen
-- kann (lib/tenant-directory.js -> loginTenant / isPlatformAdmin).
--   * tenant_users:    Eigentuemer-/Partner-/Auffueller-Login -> 't_faltrix'
--                      (active=true, role gesetzt — aber in Stufe 2 NICHT autoritativ,
--                       die Rolle kommt weiter aus den DASHBOARD_*_LOGIN-Env-Listen).
--   * platform_admins: Eigentuemer-Login (Break-Glass-Schluessel fuer Support).
--
-- KEINE Klartext-Geheimnisse — nur Login-Bezeichner (E-Mail-Adressen). Der
-- Eigentuemer-Login ist als sicherer Default hinterlegt (identisch zur Mini-
-- Tailscale-Serve-Konfiguration DASHBOARD_ADMIN_LOGIN). Partner-/Auffueller-Login
-- werden NICHT geraten, sondern optional ueber Session-GUCs parametrisiert; fehlt
-- die GUC, wird der Eintrag uebersprungen (lieber kein Eintrag als ein falscher,
-- der einen legitimen Mitarbeiter nach Stufe 2 aussperrt).
--
-- Idempotent (ON CONFLICT ... DO UPDATE): ein zweiter Lauf aendert die Werte nicht
-- und wirft nicht.
--
-- DEPLOY-REIHENFOLGE: Diese Migration laeuft VOR dem Stufe-2-Code-Rollout (#117).
-- Sonst startet der neue Code gegen leere tenant_users und sperrt den Eigentuemer
-- aus (404). Gleiches "Daten vor Code"-Prinzip wie Stufe 1.
--
-- Anwenden (Partner/Auffueller optional — Zeile weglassen, wenn unbekannt/nicht vorhanden):
--   psql "$DASHBOARD_V2_PG_URL" -v ON_ERROR_STOP=1 <<'SQL'
--   SET automatenlager.seed_partner_login  = '<partner-login>';
--   SET automatenlager.seed_operator_login = '<auffueller-login>';
--   \i dashboard/db-migrations/0018-seed-tenant-users-platform-admins.sql
--   SQL

DO $$
DECLARE
  v_tenant   TEXT := 't_faltrix';
  -- Eigentuemer-Login: sicherer Default = Mini-Serve-Login; via GUC ueberschreibbar.
  v_admin    TEXT := lower(COALESCE(NULLIF(current_setting('automatenlager.seed_admin_login', true), ''),
                                    'patrickmatthes2609@gmail.com'));
  -- Partner/Auffueller: nur wenn explizit per GUC gesetzt (kein Raten).
  v_partner  TEXT := lower(NULLIF(current_setting('automatenlager.seed_partner_login', true), ''));
  v_operator TEXT := lower(NULLIF(current_setting('automatenlager.seed_operator_login', true), ''));
BEGIN
  -- Vorbedingung: der reale Mandant muss existieren (Migration 0010).
  IF NOT EXISTS (SELECT 1 FROM automatenlager.tenants WHERE tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Mandant % fehlt — Migration 0010 zuerst anwenden', v_tenant;
  END IF;

  -- Eigentuemer -> tenant_users (Heimat-Mandant) + platform_admins (Break-Glass).
  INSERT INTO automatenlager.tenant_users (tenant_id, login, role, active)
    VALUES (v_tenant, v_admin, 'eigentuemer', TRUE)
    ON CONFLICT (tenant_id, login) DO UPDATE SET role = EXCLUDED.role, active = TRUE;

  INSERT INTO automatenlager.platform_admins (login, active)
    VALUES (v_admin, TRUE)
    ON CONFLICT (login) DO UPDATE SET active = TRUE;

  -- Partner (optional).
  IF v_partner IS NOT NULL THEN
    INSERT INTO automatenlager.tenant_users (tenant_id, login, role, active)
      VALUES (v_tenant, v_partner, 'partner', TRUE)
      ON CONFLICT (tenant_id, login) DO UPDATE SET role = EXCLUDED.role, active = TRUE;
  END IF;

  -- Auffueller (optional).
  IF v_operator IS NOT NULL THEN
    INSERT INTO automatenlager.tenant_users (tenant_id, login, role, active)
      VALUES (v_tenant, v_operator, 'auffueller', TRUE)
      ON CONFLICT (tenant_id, login) DO UPDATE SET role = EXCLUDED.role, active = TRUE;
  END IF;
END $$;
