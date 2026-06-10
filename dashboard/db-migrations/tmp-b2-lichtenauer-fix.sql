-- Temporaer: B-2 Fix Lichtenauer Still + alle depleted-aber-nicht-leer Chargen
-- Ausfuehren: psql $PGURL -f tmp-b2-lichtenauer-fix.sql
-- Loeschen nach erfolgreicher Ausfuehrung.

-- 1. Falsche guv_daily-Zeilen fuer Lichtenauer still loeschen
--    (ON CONFLICT DO NOTHING verhindert Ueberschreiben; guv-aggregate schreibt sie neu)
WITH prod AS (
  SELECT product_id
  FROM automatenlager.products
  WHERE name = 'Lichtenauer still'
    AND tenant_id = 't_faltrix'
)
DELETE FROM automatenlager.guv_daily gd
USING prod
WHERE gd.product_id = prod.product_id
  AND gd.posting_date >= '2026-05-29'::date
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

-- 2. Alle Chargen mit remaining_qty=0 und nicht-leer Status korrigieren
--    (verhindert erneutes B-1-Auftreten fuer alle Produkte)
UPDATE automatenlager.stock_batches
SET status = 'leer'
WHERE tenant_id = 't_faltrix'
  AND remaining_qty = 0
  AND status IN ('aktiv', 'active');

SELECT 'B2_fix_done' AS result;
