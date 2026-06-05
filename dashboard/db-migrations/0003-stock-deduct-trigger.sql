-- Migration #93: Echtzeit-remaining_qty — DB-Trigger auf slot_assignments
-- Wenn Nayax current_machine_qty sinkt (Verkauf) → FIFO-Abzug von stock_batches.remaining_qty
-- remaining_qty = Automat + Backstock (Gesamt). Nayax ist einzige Wahrheitsquelle.
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0003-stock-deduct-trigger.sql

-- ──────────────────────────────────────────────────────────────────────────────
-- Funktion
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION automatenlager.fn_deduct_stock_on_machine_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_delta  INTEGER;
  v_rem    INTEGER;
  rec      RECORD;
BEGIN
  -- Nur bei Absenkung (Verkauf), bekanntem Produkt und aktivem Slot
  IF NEW.current_machine_qty >= OLD.current_machine_qty THEN
    RETURN NEW;  -- Nachfüllung oder keine Änderung → nichts tun
  END IF;
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_delta := OLD.current_machine_qty - NEW.current_machine_qty;
  v_rem   := v_delta;

  -- FIFO: älteste Charge zuerst (received_at ASC, batch_id ASC als Tiebreaker)
  FOR rec IN
    SELECT batch_id, remaining_qty
    FROM   automatenlager.stock_batches
    WHERE  product_id  = NEW.product_id
      AND  status NOT IN ('ausgesondert', 'leer', 'wartet_nachkauf')
      AND  remaining_qty > 0
    ORDER  BY received_at ASC, batch_id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_rem <= 0;

    IF rec.remaining_qty >= v_rem THEN
      UPDATE automatenlager.stock_batches
      SET    remaining_qty = remaining_qty - v_rem,
             updated_at    = now()
      WHERE  batch_id = rec.batch_id;
      v_rem := 0;
    ELSE
      UPDATE automatenlager.stock_batches
      SET    remaining_qty = 0,
             updated_at    = now()
      WHERE  batch_id = rec.batch_id;
      v_rem := v_rem - rec.remaining_qty;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION automatenlager.fn_deduct_stock_on_machine_sale() IS
  'FIFO-Abzug von stock_batches.remaining_qty wenn current_machine_qty sinkt. '
  'Feuert bei WF3-Nayax-Abgleich (alle 5 Min). remaining_qty = Automat+Backstock, '
  'daher Verkauf (Senkung) = real verbrauchte Einheit aus dem Gesamtlager.';

-- ──────────────────────────────────────────────────────────────────────────────
-- Trigger (idempotent via DROP IF EXISTS)
-- ──────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_deduct_stock_on_machine_sale ON automatenlager.slot_assignments;

CREATE TRIGGER trg_deduct_stock_on_machine_sale
AFTER UPDATE OF current_machine_qty
ON automatenlager.slot_assignments
FOR EACH ROW
WHEN (
  OLD.current_machine_qty IS DISTINCT FROM NEW.current_machine_qty
  AND NEW.active = TRUE
  AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id
)
EXECUTE FUNCTION automatenlager.fn_deduct_stock_on_machine_sale();

COMMENT ON TRIGGER trg_deduct_stock_on_machine_sale ON automatenlager.slot_assignments IS
  'Feuert bei WF3-Nayax-Abgleich (alle 5 Min). '
  'Senkung → fn_deduct_stock_on_machine_sale → FIFO-remaining_qty-Abzug. '
  'Steigung (Nachfüllung) → kein Abzug (Backstock→Automat ändert Gesamtmenge nicht). '
  'Produktwechsel am Slot → kein Feuern (WHEN-Guard OLD.product_id IS NOT DISTINCT FROM NEW.product_id).';
