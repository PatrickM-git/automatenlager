-- Migration 0016: Views/MatViews tenant_id-fuehrend machen. Stufe 1. Issue #103.
-- Idempotent. Setzt 0009 (tenant_id auf den Basistabellen) voraus.
--
-- Realer Zustand introspiziert (alle drei VORHANDEN, ohne Repo-DDL):
--   v_warnings_open        VIEW  (SELECT aus warnings WHERE resolved=false)
--   v_slot_turnover        VIEW  (Aggregat aus sales_transactions)
--   mv_inventory_value_daily MATVIEW (Aggregat aus stock_batches, UNIQUE(date, product_id))
-- Die uebrigen MatViews mv_db_per_product_monthly / mv_db_per_slot_monthly stehen
-- NICHT im Schema-Contract (EXPECTED_RELATIONS) und sind nicht Teil von #103 ->
-- bewusst unberuehrt (eigene Folge-Haertung, falls noetig).
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0016-views-tenant-id.sql

-- ── v_warnings_open: tenant_id mitfuehren (am Ende, REPLACE-kompatibel) ────────
CREATE OR REPLACE VIEW automatenlager.v_warnings_open AS
  SELECT warning_id,
         warning_key,
         warning_type,
         severity,
         product_id,
         slot_assignment_id,
         machine_id,
         mdb_code,
         message,
         source_workflow,
         created_at,
         tenant_id
    FROM automatenlager.warnings
   WHERE resolved = false;

-- ── v_slot_turnover: tenant_id in SELECT + GROUP BY ───────────────────────────
CREATE OR REPLACE VIEW automatenlager.v_slot_turnover AS
  SELECT machine_id,
         mdb_code,
         date_trunc('month', (settlement_at AT TIME ZONE 'Europe/Berlin'))::date AS month,
         count(*) AS turnover_count,
         tenant_id
    FROM automatenlager.sales_transactions
   WHERE source <> 'historic_backfill'
   GROUP BY machine_id, mdb_code,
            date_trunc('month', (settlement_at AT TIME ZONE 'Europe/Berlin'))::date,
            tenant_id;

-- ── mv_inventory_value_daily: tenant_id-fuehrend, Gesamtwert PRO Mandant ───────
-- MatView kann nicht REPLACEt werden -> DROP + CREATE; Unique-Index mandanten-
-- bewusst (date, tenant_id, product_id) ermoeglicht REFRESH ... CONCURRENTLY.
-- CASCADE (#152): seit Stufe 5 haengt die Security-View v_inventory_value_daily
-- (Migration 0022) an dieser MatView. Ein Rebuild muss die abhaengige View
-- mit-droppen — 0022 baut v_inventory_value_daily danach wieder auf (Kette).
DROP MATERIALIZED VIEW IF EXISTS automatenlager.mv_inventory_value_daily CASCADE;
CREATE MATERIALIZED VIEW automatenlager.mv_inventory_value_daily AS
  SELECT CURRENT_DATE AS date,
         tenant_id,
         product_id,
         sum(remaining_qty::numeric * unit_cost_net) AS value_per_product,
         sum(sum(remaining_qty::numeric * unit_cost_net)) OVER (PARTITION BY tenant_id) AS total_value
    FROM automatenlager.stock_batches
   WHERE status <> ALL (ARRAY['depleted'::text, 'expired'::text])
   GROUP BY tenant_id, product_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_inventory_value_daily_pk
  ON automatenlager.mv_inventory_value_daily (date, tenant_id, product_id);
