-- Migration #92 (Teil 2): purchase_date Fallback-Trigger auf stock_batches
-- Der Trigger setzt purchase_date = received_at wenn kein expliziter Wert geliefert wird.
-- Hintergrund: pgw_write schreibt purchase_date nicht direkt; WF2 sendet es im payload,
-- aber der INSERT liest nur received_at. Trigger als sicherer Fallback für alle Pfade.
-- Backfill bestehender Chargen: UPDATE ... SET purchase_date = received_at (manuell ausgeführt 2026-06-05)
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0004-purchase-date-trigger.sql

CREATE OR REPLACE FUNCTION automatenlager.fn_default_purchase_date()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purchase_date IS NULL THEN
    NEW.purchase_date := NEW.received_at;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION automatenlager.fn_default_purchase_date() IS
  'Setzt purchase_date = received_at wenn NULL (Fallback für Aufrufer die purchase_date nicht kennen).';

DROP TRIGGER IF EXISTS trg_default_purchase_date ON automatenlager.stock_batches;

CREATE TRIGGER trg_default_purchase_date
BEFORE INSERT ON automatenlager.stock_batches
FOR EACH ROW
EXECUTE FUNCTION automatenlager.fn_default_purchase_date();

COMMENT ON TRIGGER trg_default_purchase_date ON automatenlager.stock_batches IS
  'Fallback: purchase_date = received_at wenn kein expliziter Wert. '
  'WF2 sendet purchase_date seit #92-Update, pgw_write liest es noch nicht explizit.';
