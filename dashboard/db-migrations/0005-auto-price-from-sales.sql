-- Migration #0005: Automatische Preis-Aktualisierung aus Nayax-Verkäufen
--
-- Trigger auf sales_transactions (AFTER INSERT): Wenn WF3 einen Verkauf mit
-- einem Preis einbucht, der vom aktuellen prices-Eintrag abweicht, wird der
-- Preis automatisch aktualisiert. Nayax ist Wahrheitsquelle für Preise.
--
-- Warum: Preiserhöhungen oder Korrekturen sollen automatisch in der prices-
-- Tabelle landen, damit GuV und Dashboard immer korrekte Preise zeigen.
-- source='estimated'-Einträge werden genauso überschrieben wie andere.
--
-- Korrekturen an Schätzpreisen (source='estimated'):
--   Hochwald Eiskaffee: 1.50 -> 2.50 (User-Bestätigung 2026-06-05)
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0005-auto-price-from-sales.sql

-- ──────────────────────────────────────────────────────────────────────────────
-- Hochwald Eiskaffee Preis-Korrektur (war Schätzung, jetzt bestätigt)
-- ──────────────────────────────────────────────────────────────────────────────
UPDATE automatenlager.prices
   SET sale_price_gross = 2.50
 WHERE price_id = 38
   AND source = 'estimated'
   AND sale_price_gross = 1.50;

-- ──────────────────────────────────────────────────────────────────────────────
-- Funktion: Preis aus Nayax-Verkauf übernehmen
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION automatenlager.fn_update_price_from_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_unit_price  NUMERIC(10, 2);
  v_current_id  BIGINT;
  v_current_amt NUMERIC(10, 2);
BEGIN
  -- Einheitspreis berechnen
  v_unit_price := ROUND(NEW.gross_amount / NEW.quantity, 2);

  -- Aktuellen Preis für diesen Slot lesen
  SELECT price_id, sale_price_gross
    INTO v_current_id, v_current_amt
    FROM automatenlager.prices
   WHERE slot_assignment_id = NEW.slot_assignment_id
     AND valid_to IS NULL
   ORDER BY valid_from DESC
   LIMIT 1
   FOR UPDATE;

  -- Nichts tun wenn Preis identisch
  IF v_current_amt IS NOT DISTINCT FROM v_unit_price THEN
    RETURN NEW;
  END IF;

  -- Bisherigen Preis schließen (valid_to = Zeitpunkt des Verkaufs)
  IF v_current_id IS NOT NULL THEN
    UPDATE automatenlager.prices
       SET valid_to = NEW.settlement_at
     WHERE price_id = v_current_id;
  END IF;

  -- Neuen Preis eintragen
  INSERT INTO automatenlager.prices
    (slot_assignment_id, sale_price_gross, valid_from, valid_to, source)
  VALUES
    (NEW.slot_assignment_id, v_unit_price, NEW.settlement_at, NULL, 'nayax_transaction');

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION automatenlager.fn_update_price_from_sale() IS
  'Aktualisiert prices.sale_price_gross wenn ein Nayax-Verkauf einen anderen Preis meldet. '
  'Schließt den bisherigen Preis (valid_to=settlement_at) und öffnet einen neuen Eintrag. '
  'Nayax ist Wahrheitsquelle — überschreibt auch source=estimated.';

-- ──────────────────────────────────────────────────────────────────────────────
-- Trigger (idempotent)
-- ──────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_update_price_from_sale ON automatenlager.sales_transactions;

CREATE TRIGGER trg_update_price_from_sale
AFTER INSERT ON automatenlager.sales_transactions
FOR EACH ROW
WHEN (
  NEW.gross_amount IS NOT NULL AND NEW.gross_amount > 0
  AND NEW.quantity  IS NOT NULL AND NEW.quantity  > 0
  AND NEW.slot_assignment_id IS NOT NULL
)
EXECUTE FUNCTION automatenlager.fn_update_price_from_sale();

COMMENT ON TRIGGER trg_update_price_from_sale ON automatenlager.sales_transactions IS
  'Feuert nach jedem Verkaufs-INSERT mit gültigem Preis und bekanntem Slot. '
  'Aktualisiert prices-Tabelle wenn der berechnete Einheitspreis vom aktuellen abweicht. '
  'Preis-History bleibt erhalten (valid_from/valid_to). Nayax = Preiswahrheitsquelle.';
