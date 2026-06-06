-- Migration 0008: Lager-Fundament (warehouses) + Onboarding-Automatik (fn_create_tenant)
-- Stufe 1 der Multi-Tenant-SPEC. Issue #95. Idempotent. Setzt 0007 voraus.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0008-warehouses-fn-create-tenant.sql
--
-- Integer-Breite am Bestand orientiert: die operativen PKs sind durchgaengig
-- BIGINT (machines/locations/products = bigint), daher warehouse_id BIGSERIAL und
-- location_id BIGINT (typ-treu zum FK auf locations.location_id BIGINT).

-- ──────────────────────────────────────────────────────────────────────────────
-- warehouses — benennbares Lager je Mandant (optional an einen Standort haengbar)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automatenlager.warehouses (
  warehouse_id BIGSERIAL  PRIMARY KEY,
  tenant_id    TEXT        NOT NULL REFERENCES automatenlager.tenants(tenant_id),
  name         TEXT        NOT NULL,
  location_id  BIGINT      NULL REFERENCES automatenlager.locations(location_id) ON DELETE SET NULL,
  is_default   BOOLEAN     NOT NULL DEFAULT FALSE,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warehouses_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_warehouses_tenant
  ON automatenlager.warehouses (tenant_id);

-- Genau EIN Default-Lager je Mandant (partieller Unique-Index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_one_default
  ON automatenlager.warehouses (tenant_id) WHERE is_default;

COMMENT ON TABLE automatenlager.warehouses IS
  'Benennbares Lager je Mandant ("Zentrallager", "Garage", ...). Jeder Mandant '
  'startet automatisch mit genau einem is_default-Zentrallager (fn_create_tenant). '
  'location_id optional = freiwillige "Lager am Standort"-Zuordnung.';

-- ──────────────────────────────────────────────────────────────────────────────
-- fn_create_tenant — legt einen Mandanten ATOMAR an: tenants-Zeile + genau ein
-- Default-"Zentrallager". Settings-Defaults bleiben dem idempotenten
-- loadEffectiveConfig-Anleger ueberlassen (kein eigenes Seeding hier).
-- Idempotent: wiederholter Aufruf bricht nicht (ON CONFLICT DO NOTHING).
-- WER die Funktion aufrufen darf, ist Stufe 2 (Auth) — nicht Teil dieses Issues.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION automatenlager.fn_create_tenant(
  p_tenant_id     TEXT,
  p_name          TEXT,
  p_contact_email TEXT DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO automatenlager.tenants (tenant_id, name, contact_email)
  VALUES (p_tenant_id, p_name, p_contact_email)
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO automatenlager.warehouses (tenant_id, name, is_default)
  VALUES (p_tenant_id, 'Zentrallager', TRUE)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  RETURN p_tenant_id;
END;
$$;

COMMENT ON FUNCTION automatenlager.fn_create_tenant(TEXT, TEXT, TEXT) IS
  'Onboarding-Automatik: legt Mandant + Default-Zentrallager atomar an. '
  'Idempotent (ON CONFLICT DO NOTHING). Settings-Defaults via loadEffectiveConfig.';
