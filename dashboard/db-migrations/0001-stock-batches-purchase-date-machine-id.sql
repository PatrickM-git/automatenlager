-- Migration #92: stock_batches um purchase_date + machine_id (Lagerort) erweitern
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0001-stock-batches-purchase-date-machine-id.sql
-- Reihenfolge: DDL vor Code-Deploy ausführen.

ALTER TABLE automatenlager.stock_batches
  ADD COLUMN IF NOT EXISTS purchase_date  DATE,
  ADD COLUMN IF NOT EXISTS machine_id     INTEGER
    REFERENCES automatenlager.machines(machine_id) ON DELETE SET NULL;

COMMENT ON COLUMN automatenlager.stock_batches.purchase_date IS
  'Einkaufsdatum der Charge (Rechnungsdatum / Eingang). NULL = unbekannt/manuell angelegt.';

COMMENT ON COLUMN automatenlager.stock_batches.machine_id IS
  'Lagerort: in welchem Automaten oder Lagerbereich diese Charge physisch liegt. NULL = Zentrallager / unbekannt.';
