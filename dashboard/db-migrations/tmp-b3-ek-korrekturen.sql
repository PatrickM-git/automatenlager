-- Temporaer: B-3 EK-Korrekturen + GuV-Restatement (Issue #211)
-- Ausfuehren: psql $PGURL -f tmp-b3-ek-korrekturen.sql
-- Loeschen nach erfolgreicher Ausfuehrung.
-- Twix + 7 Days Croissant (Preise bekannt).
-- Sprite/Fanta/Coca-Cola: Preis aus Rechnung pruefen, dann via Dashboard EK-Korrektur.

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- TWIX ORIGINAL: 0.0160 → 0.4800 (WF2 Parse-Fehler)
-- ────────────────────────────────────────────────────────────────────
UPDATE automatenlager.stock_batches
SET unit_cost_net = 0.4800
WHERE batch_key = 'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1'
  AND tenant_id = 't_faltrix';

WITH twix AS (
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
FROM twix
WHERE gd.product_id = twix.product_id
  AND gd.posting_date >= twix.received_at
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

-- Audit-Log (je restated Zeile, restatement_run_id gruppiert den Lauf)
INSERT INTO audit.guv_restatement_log
  (restatement_run_id, tenant_id, guv_key, source,
   old_cost_of_goods, new_cost_of_goods, old_revenue_net, new_revenue_net,
   old_gross_profit, new_gross_profit, vat_rate, factor, executed_by, executed_context)
SELECT
  'manual-b3-twix-20260610',
  gd.tenant_id,
  gd.guv_key,
  gd.source,
  gd.cost_of_goods,
  CASE
    WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
      THEN ROUND(gd.quantity_sold * 0.4800, 2)
    ELSE ROUND(gd.cost_of_goods * (0.4800 / 0.0160), 2)
  END,
  gd.revenue_net, gd.revenue_net,
  gd.gross_profit,
  gd.revenue_gross - CASE
    WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
      THEN ROUND(gd.quantity_sold * 0.4800, 2)
    ELSE ROUND(gd.cost_of_goods * (0.4800 / 0.0160), 2)
  END,
  0, 0,
  'batch-ek-correction-manual',
  '{"batch_key":"B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1","old_unit_cost":0.016,"new_unit_cost":0.48}'::jsonb
FROM automatenlager.guv_daily gd
JOIN automatenlager.stock_batches sb ON sb.product_id = gd.product_id AND sb.tenant_id = gd.tenant_id
WHERE sb.batch_key = 'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1'
  AND gd.posting_date >= sb.received_at
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

-- ────────────────────────────────────────────────────────────────────
-- 7 DAYS CROISSANT: 0.5056 → 0.4725 (MwSt vor Stueck-Division angewendet)
-- ────────────────────────────────────────────────────────────────────
UPDATE automatenlager.stock_batches
SET unit_cost_net = 0.4725
WHERE batch_key = 'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
  AND tenant_id = 't_faltrix';

WITH days AS (
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
FROM days
WHERE gd.product_id = days.product_id
  AND gd.posting_date >= days.received_at
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

INSERT INTO audit.guv_restatement_log
  (restatement_run_id, tenant_id, guv_key, source,
   old_cost_of_goods, new_cost_of_goods, old_revenue_net, new_revenue_net,
   old_gross_profit, new_gross_profit, vat_rate, factor, executed_by, executed_context)
SELECT
  'manual-b3-7days-20260610',
  gd.tenant_id,
  gd.guv_key,
  gd.source,
  gd.cost_of_goods,
  CASE
    WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
      THEN ROUND(gd.quantity_sold * 0.4725, 2)
    ELSE ROUND(gd.cost_of_goods * (0.4725 / 0.5056), 2)
  END,
  gd.revenue_net, gd.revenue_net,
  gd.gross_profit,
  gd.revenue_gross - CASE
    WHEN gd.cost_of_goods IS NULL OR gd.cost_of_goods = 0
      THEN ROUND(gd.quantity_sold * 0.4725, 2)
    ELSE ROUND(gd.cost_of_goods * (0.4725 / 0.5056), 2)
  END,
  0, 0,
  'batch-ek-correction-manual',
  '{"batch_key":"B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3","old_unit_cost":0.5056,"new_unit_cost":0.4725}'::jsonb
FROM automatenlager.guv_daily gd
JOIN automatenlager.stock_batches sb ON sb.product_id = gd.product_id AND sb.tenant_id = gd.tenant_id
WHERE sb.batch_key = 'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
  AND gd.posting_date >= sb.received_at
  AND gd.source = 'wf8_guv_aggregator'
  AND gd.tenant_id = 't_faltrix';

COMMIT;

-- Ergebnis pruefen:
SELECT p.name, sb.batch_key, sb.unit_cost_net
FROM automatenlager.stock_batches sb
JOIN automatenlager.products p ON p.product_id = sb.product_id AND p.tenant_id = sb.tenant_id
WHERE sb.tenant_id = 't_faltrix'
  AND sb.batch_key IN (
    'B_TWIX_ORIGINAL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_1',
    'B_7_DAYS_CROISSANT_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_3'
  );
