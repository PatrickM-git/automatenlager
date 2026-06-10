-- B-5: Twix guv_daily 2026-06-04 korrigieren (WF8/Sheets Kartonpreis 16.50 -> korrekt 0.57)
-- und Lichtenauer Still batch unit_cost_net 0.7140 -> 0.35 (laut Rechnung 2026-05-29)

BEGIN;

-- 1. Twix guv_daily: cost_of_goods war 16.50 (Kartonpreis aus altem WF8/n8n-Job)
--    Korrektur: 1 Stueck x 0.4800 netto x 1.19 (Kleinunternehmer brutto) = 0.5712
UPDATE automatenlager.guv_daily
SET cost_of_goods = ROUND(0.4800 * 1.19, 2),
    gross_profit  = ROUND(1.00 - (0.4800 * 1.19), 2)
WHERE tenant_id = 't_faltrix'
  AND guv_key = '2026-06-04|457107528|SKU_TWIX_ORIGINAL';

-- Audit-Log fuer Twix
INSERT INTO audit.guv_restatement_log
  (restatement_run_id, tenant_id, guv_key, source,
   old_cost_of_goods, new_cost_of_goods,
   old_revenue_net,   new_revenue_net,
   old_gross_profit,  new_gross_profit,
   vat_rate, factor, executed_by, executed_context)
VALUES
  ('manual-b5-twix-lichtenauer-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS'),
   't_faltrix',
   '2026-06-04|457107528|SKU_TWIX_ORIGINAL',
   'manual_correction',
   16.50, ROUND(0.4800 * 1.19, 2),
   1.00,  1.00,
   -15.50, ROUND(1.00 - (0.4800 * 1.19), 2),
   19, ROUND((0.4800 * 1.19) / 16.50, 4),
   'admin', 'B-5: WF8-Sheets Kartonpreis 16.50 statt Stueckpreis 0.48');

-- 2. Lichtenauer Still: batch unit_cost_net korrigieren
--    0.7140 -> 0.35 (laut Rechnung 2026-05-29, netto ohne MwSt, ohne Pfand)
--    guv_daily Zeilen seit 2026-05-29 wurden bereits geloescht (B-2 fix),
--    werden von guv-aggregate neu mit korrektem EK 0.35 x 1.19 = 0.4165 erstellt.
UPDATE automatenlager.stock_batches
SET unit_cost_net = 0.35
WHERE tenant_id = 't_faltrix'
  AND batch_key = 'B_LICHTENAUER_STILL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_5';

-- Verifikation
SELECT 'twix_fix' AS check_name,
       guv_key, quantity_sold, cost_of_goods, gross_profit
FROM automatenlager.guv_daily
WHERE tenant_id = 't_faltrix'
  AND guv_key = '2026-06-04|457107528|SKU_TWIX_ORIGINAL';

SELECT 'lichtenauer_batch' AS check_name,
       batch_key, unit_cost_net, remaining_qty, status
FROM automatenlager.stock_batches
WHERE tenant_id = 't_faltrix'
  AND batch_key = 'B_LICHTENAUER_STILL_20260529_APP_1IlurHQIe2FpPMmWErI0g4POMmwaBRr5j_5';

COMMIT;
