-- Temporaer: B-3 EK-Korrekturen + GuV-Restatement (Issue #211)
-- Ausfuehren: psql $PGURL -f tmp-b3-ek-korrekturen.sql
-- Loeschen nach erfolgreicher Ausfuehrung.
-- Nur Twix + 7 Days Croissant (Preise bekannt).
-- Sprite/Fanta/Coca-Cola: Preis aus Rechnung pruefen, dann via Dashboard korrigieren.

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- TWIX ORIGINAL: 0.0160 → 0.4800 (WF2 Parse-Fehler)
-- ────────────────────────────────────────────────────────────────────
UPDATE automatenlager.stock_batches
SET unit_cost_net = 0.4800
WHERE batch_key = 'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1'
  AND tenant_id = 't_faltrix';

WITH twix_prod AS (
  SELECT sb.product_id, sb.received_at
  FROM automatenlager.stock_batches sb
  WHERE sb.batch_key = 'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1'
    AND sb.tenant_id = 't_faltrix'
)
UPDATE automatenlager.guv_daily gd
SET cost_of_goods = CASE
      WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
        THEN ROUND(gd.quantity_sold * 0.4800, 2)
      ELSE ROUND(gd.cost_of_goods * (0.4800 / 0.0160), 2)
    END,
    gross_profit = gd.revenue_gross - CASE
      WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
        THEN ROUND(gd.quantity_sold * 0.4800, 2)
      ELSE ROUND(gd.cost_of_goods * (0.4800 / 0.0160), 2)
    END
FROM twix_prod
WHERE gd.product_id = twix_prod.product_id
  AND gd.posting_date >= twix_prod.received_at
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

INSERT INTO audit.guv_restatement_log (tenant_id, run_id, batch_key, old_unit_cost, new_unit_cost, rows_restated, context, created_at)
SELECT 't_faltrix', 'manual-b3-twix-' || to_char(now(),'YYYYMMDD'),
       'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1',
       0.0160, 0.4800,
       (SELECT COUNT(*) FROM automatenlager.guv_daily gd
        JOIN automatenlager.stock_batches sb ON sb.product_id = gd.product_id AND sb.tenant_id = gd.tenant_id
        WHERE sb.batch_key = 'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1'
          AND gd.posting_date >= sb.received_at AND gd.source = 'wf8_guv_aggregator' AND gd.tenant_id = 't_faltrix'),
       'B-3 EK-Korrektur manuell: WF2 Parse-Fehler Twix',
       now();

-- ────────────────────────────────────────────────────────────────────
-- 7 DAYS CROISSANT: 0.5056 → 0.4725 (MwSt vor Stueck-Division angewendet)
-- Nur die aktive Charge (die depleted Chargen haben keine guv_daily mehr)
-- ────────────────────────────────────────────────────────────────────
UPDATE automatenlager.stock_batches
SET unit_cost_net = 0.4725
WHERE batch_key = 'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
  AND tenant_id = 't_faltrix';

WITH days_prod AS (
  SELECT sb.product_id, sb.received_at
  FROM automatenlager.stock_batches sb
  WHERE sb.batch_key = 'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
    AND sb.tenant_id = 't_faltrix'
)
UPDATE automatenlager.guv_daily gd
SET cost_of_goods = CASE
      WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
        THEN ROUND(gd.quantity_sold * 0.4725, 2)
      ELSE ROUND(gd.cost_of_goods * (0.4725 / 0.5056), 2)
    END,
    gross_profit = gd.revenue_gross - CASE
      WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
        THEN ROUND(gd.quantity_sold * 0.4725, 2)
      ELSE ROUND(gd.cost_of_goods * (0.4725 / 0.5056), 2)
    END
FROM days_prod
WHERE gd.product_id = days_prod.product_id
  AND gd.posting_date >= days_prod.received_at
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

INSERT INTO audit.guv_restatement_log (tenant_id, run_id, batch_key, old_unit_cost, new_unit_cost, rows_restated, context, created_at)
SELECT 't_faltrix', 'manual-b3-7days-' || to_char(now(),'YYYYMMDD'),
       'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3',
       0.5056, 0.4725,
       (SELECT COUNT(*) FROM automatenlager.guv_daily gd
        JOIN automatenlager.stock_batches sb ON sb.product_id = gd.product_id AND sb.tenant_id = gd.tenant_id
        WHERE sb.batch_key = 'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
          AND gd.posting_date >= sb.received_at AND gd.source = 'wf8_guv_aggregator' AND gd.tenant_id = 't_faltrix'),
       'B-3 EK-Korrektur manuell: MwSt vor Stueck-Division bei 7 Days Croissant',
       now();

COMMIT;

SELECT 'B3_done' AS result;

-- Pruefe Ergebnis:
SELECT p.name, sb.batch_key, sb.unit_cost_net
FROM automatenlager.stock_batches sb
JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
WHERE sb.tenant_id = 't_faltrix'
  AND sb.batch_key IN (
    'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1',
    'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
  );
