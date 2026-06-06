-- Migration 0007: Mandanten-Fundament — tenants, tenant_users, platform_admins
-- Stufe 1 (Schema-Migration) der Multi-Tenant-SPEC (docs/specs/multi-tenant-datenmodell-v1.md).
-- Issue #94. Legt NUR das leere Strukturschema an (kein Backfill, keine Daten).
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS). Anwenden VOR Code-Rollout/Mini-Deploy.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0007-tenants-tenant-users-platform-admins.sql

-- ──────────────────────────────────────────────────────────────────────────────
-- tenants — Mandanten-Verzeichnis
--   tenant_id: opake, unveraenderliche ID (PK, auf jede Zeile gestempelt)
--   name:      aenderbares Etikett (Firmenname) — Umbenennung loest keinen Datenumzug aus
--   status:    'aktiv' | 'pausiert' | 'gekuendigt' (steuert spaeter, Stufe 2, den Zugang)
--   contact_email: Per-Mandant-Alarm-/Kontaktadresse (Warn-Mails an den richtigen Betrieb)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automatenlager.tenants (
  tenant_id     TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'aktiv',
  contact_email TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE automatenlager.tenants IS
  'Mandanten-Verzeichnis (ein Betrieb je Zeile). tenant_id opak/unveraenderlich, '
  'wird auf jede operative Zeile denormalisiert; name aenderbar.';
COMMENT ON COLUMN automatenlager.tenants.status IS
  'aktiv | pausiert | gekuendigt. Zugangssteuerung erst in Stufe 2 (Auth).';
COMMENT ON COLUMN automatenlager.tenants.contact_email IS
  'Zieladresse fuer mandanteneigene Benachrichtigungen (z. B. MHD-Warnungen).';

-- ──────────────────────────────────────────────────────────────────────────────
-- tenant_users — Mitgliedschaften (Login ↔ Mandant ↔ Rolle)
--   Traegt "ein Betrieb, zwei Eigentuemer" als zwei Zeilen.
--   Index auf login = Grundlage der spaeteren Auth-Aufloesung (Stufe 2).
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automatenlager.tenant_users (
  tenant_user_id BIGSERIAL  PRIMARY KEY,
  tenant_id      TEXT        NOT NULL REFERENCES automatenlager.tenants(tenant_id),
  login          TEXT        NOT NULL,
  role           TEXT        NOT NULL,
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_users_unique UNIQUE (tenant_id, login)
);
CREATE INDEX IF NOT EXISTS idx_tenant_users_login
  ON automatenlager.tenant_users (login);

COMMENT ON TABLE automatenlager.tenant_users IS
  'Mitgliedschaften: welcher Login zu welchem Mandanten mit welcher Rolle '
  '(eigentuemer | auffueller | gast) gehoert. Auswertung erst in Stufe 2 (Auth).';

-- ──────────────────────────────────────────────────────────────────────────────
-- platform_admins — reservierter Break-Glass-Support-Schluessel
--   Bewusst EIGENE Tabelle (mandantenuebergreifend, kein Attribut einer Mitgliedschaft).
--   Standardzustand LEER = niemand kann uebergreifen. Traegt KEINE tenant_id
--   und ist von der Tenant-Pflicht-Pruefung ausgenommen. Scharfschalten erst Stufe 2/4.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automatenlager.platform_admins (
  login      TEXT        PRIMARY KEY,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE automatenlager.platform_admins IS
  'Reservierter Break-Glass-Support-Schluessel (mandantenuebergreifend). '
  'Standard leer; bewusst OHNE tenant_id; Durchsetzung/Audit erst Stufe 2/4.';
