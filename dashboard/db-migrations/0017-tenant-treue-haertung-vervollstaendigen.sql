-- Migration 0017: Tenant-Treue-Härtung vervollständigen (Folge zu #100/0013).
-- Issue #105. Idempotent. Setzt 0013 voraus.
--   (a) machine_profiles tenant-treu per Validierungs-Trigger (kein composite FK
--       moeglich: machine_id ist TEXT=machine_key, kein bigint-FK auf machines).
--   (b) composite Kind-FKs fuer die in 0013 ausgelassenen Pfade: guv_daily,
--       warnings, product_aliases, product_change_proposals, stock_movements.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0017-tenant-treue-haertung-vervollstaendigen.sql

-- ── (a) machine_profiles: Validierungs-Trigger ────────────────────────────────
-- Laeuft NACH dem Auto-Fill (trg_inherit_… < trg_validate_… alphabetisch): erst
-- erben (wenn weggelassen), dann harte Pruefung gegen die Maschine. Eine explizit
-- mandantenfremde tenant_id wird damit von der DB abgelehnt.
CREATE OR REPLACE FUNCTION automatenlager.fn_assert_machine_profile_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_machine_tenant TEXT;
BEGIN
  SELECT tenant_id INTO v_machine_tenant
    FROM automatenlager.machines
   WHERE machine_key = NEW.machine_id;
  IF v_machine_tenant IS NULL THEN
    RAISE EXCEPTION 'machine_profiles: keine Maschine mit machine_key=% (tenant_id nicht ableitbar)', NEW.machine_id;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM v_machine_tenant THEN
    RAISE EXCEPTION 'machine_profiles: tenant_id % passt nicht zur Maschine % (gehoert %)',
      NEW.tenant_id, NEW.machine_id, v_machine_tenant;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_tenant_machine_profiles ON automatenlager.machine_profiles;
CREATE TRIGGER trg_validate_tenant_machine_profiles
  BEFORE INSERT OR UPDATE ON automatenlager.machine_profiles
  FOR EACH ROW EXECUTE FUNCTION automatenlager.fn_assert_machine_profile_tenant();

-- ── (b) Eltern-Anker fuer stock_batches (fuer stock_movements-FK) ─────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_batches_tenant_pk_uk'
                   AND conrelid='automatenlager.stock_batches'::regclass) THEN
    ALTER TABLE automatenlager.stock_batches
      ADD CONSTRAINT stock_batches_tenant_pk_uk UNIQUE (tenant_id, batch_id);
  END IF;
END $$;

-- ── (b) composite Kind-FKs (NO ACTION wie die bestehenden Single-FKs) ─────────
DO $$
DECLARE
  spec JSONB;
  fks JSONB := '[
    {"t":"guv_daily",                "old":"guv_daily_machine_id_fkey",                  "new":"guv_daily_machine_tenant_fk",         "cols":"tenant_id, machine_id",         "ref":"machines",         "rcols":"tenant_id, machine_id"},
    {"t":"guv_daily",                "old":"guv_daily_product_id_fkey",                  "new":"guv_daily_product_tenant_fk",         "cols":"tenant_id, product_id",         "ref":"products",         "rcols":"tenant_id, product_id"},
    {"t":"warnings",                 "old":"warnings_machine_id_fkey",                   "new":"warnings_machine_tenant_fk",          "cols":"tenant_id, machine_id",         "ref":"machines",         "rcols":"tenant_id, machine_id"},
    {"t":"warnings",                 "old":"warnings_product_id_fkey",                   "new":"warnings_product_tenant_fk",          "cols":"tenant_id, product_id",         "ref":"products",         "rcols":"tenant_id, product_id"},
    {"t":"warnings",                 "old":"warnings_slot_assignment_id_fkey",           "new":"warnings_slot_tenant_fk",             "cols":"tenant_id, slot_assignment_id", "ref":"slot_assignments", "rcols":"tenant_id, slot_assignment_id"},
    {"t":"product_aliases",          "old":"product_aliases_product_id_fkey",            "new":"product_aliases_product_tenant_fk",   "cols":"tenant_id, product_id",         "ref":"products",         "rcols":"tenant_id, product_id"},
    {"t":"product_change_proposals", "old":"product_change_proposals_machine_id_fkey",   "new":"product_change_proposals_machine_tenant_fk","cols":"tenant_id, machine_id",   "ref":"machines",         "rcols":"tenant_id, machine_id"},
    {"t":"product_change_proposals", "old":"product_change_proposals_product_id_fkey",   "new":"product_change_proposals_product_tenant_fk","cols":"tenant_id, product_id",   "ref":"products",         "rcols":"tenant_id, product_id"},
    {"t":"stock_movements",          "old":"stock_movements_batch_id_fkey",              "new":"stock_movements_batch_tenant_fk",     "cols":"tenant_id, batch_id",           "ref":"stock_batches",    "rcols":"tenant_id, batch_id"}
  ]';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(fks) LOOP
    EXECUTE format('ALTER TABLE automatenlager.%I DROP CONSTRAINT IF EXISTS %I', spec->>'t', spec->>'old');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec->>'new'
                     AND conrelid = ('automatenlager.' || (spec->>'t'))::regclass) THEN
      EXECUTE format(
        'ALTER TABLE automatenlager.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES automatenlager.%I (%s)',
        spec->>'t', spec->>'new', spec->>'cols', spec->>'ref', spec->>'rcols');
    END IF;
  END LOOP;
END $$;
