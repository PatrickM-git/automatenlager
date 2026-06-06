-- Migration 0011: stock_batches.warehouse_id — jede Charge liegt in einem
-- eindeutigen physischen Ort: Automat (machine_id) ODER Lager (warehouse_id).
-- Stufe 1. Issue #98. Idempotent. Setzt 0008 (warehouses) + 0010 (Backfill/Mandant) voraus.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0011-stock-batches-warehouse-id.sql

-- Spalte + FK (ON DELETE SET NULL: Lager-Wegfall macht Charge ortlos, nicht weg).
ALTER TABLE automatenlager.stock_batches
  ADD COLUMN IF NOT EXISTS warehouse_id BIGINT NULL
    REFERENCES automatenlager.warehouses(warehouse_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_batches_warehouse
  ON automatenlager.stock_batches (warehouse_id);

-- CHECK "hoechstens ein Ort" (<= 1, nicht = 1): eine voll verbrauchte/ausgesonderte
-- Charge darf ortlos sein. Die schaerfere Invariante "aktive Charge hat genau einen
-- Ort" wird als Test geprueft (Status-Altlasten nicht per Constraint blockieren).
DO $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'stock_batches_one_location'
           AND conrelid = 'automatenlager.stock_batches'::regclass)
  THEN
    ALTER TABLE automatenlager.stock_batches
      ADD CONSTRAINT stock_batches_one_location
      CHECK (num_nonnulls(machine_id, warehouse_id) <= 1);
  END IF;
END $$;

-- Backfill: das alte namenlose "Zentrallager" (machine_id IS NULL) auf das
-- Default-Zentrallager des jeweiligen Mandanten setzen. Daraus fallen Gesamt-
-- Kurzansicht und Drill-down pro Lager von selbst heraus.
UPDATE automatenlager.stock_batches sb
   SET warehouse_id = w.warehouse_id
  FROM automatenlager.warehouses w
 WHERE sb.machine_id IS NULL
   AND sb.warehouse_id IS NULL
   AND w.tenant_id = sb.tenant_id
   AND w.is_default = TRUE;

COMMENT ON COLUMN automatenlager.stock_batches.warehouse_id IS
  'Lager-Ort der Charge (Charge in Automat ODER Lager). NULL = im Automaten '
  '(machine_id gesetzt) oder ortlos (verbraucht/ausgesondert). CHECK erzwingt '
  'hoechstens einen Ort.';
