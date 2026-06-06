-- Migration 0019: mv_db_per_product_monthly + mv_db_per_slot_monthly tenant_id-fuehrend.
-- Stufe-1-Folgehaertung (Issue #106). Idempotent. Setzt 0009 (guv_daily.tenant_id) voraus.
--
-- Beide MatViews wurden ausserhalb der Repo-Migrationen direkt auf der DB angelegt und
-- standen nicht im Schema-Contract (#103/0016 liess sie bewusst unberuehrt). Sie
-- aggregieren aus guv_daily OHNE tenant_id -> bei mehr als einem Mandanten wuerden sie
-- ueber alle Mandanten hinweg aggregieren (Daten-Leck/Vermischung). Fix: tenant_id in
-- SELECT + GROUP BY; Unique-Index mandantenbewusst (ermoeglicht REFRESH ... CONCURRENTLY).
-- Definition byte-nah aus der Live-DB uebernommen, nur tenant_id ergaenzt.
--
-- MatViews koennen nicht REPLACEt werden -> DROP + CREATE (transaktional, idempotent).
-- Niemand im Dashboard-Code liest diese MVs (nur der n8n-MatView-Refresh); REFRESH
-- bleibt unveraendert mandantenuebergreifend korrekt (refresht die ganze MV).
--
-- Anwenden: psql $PGURL -f dashboard/db-migrations/0019-mv-db-monthly-tenant-id.sql

-- ── mv_db_per_product_monthly: tenant_id-fuehrend ─────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS automatenlager.mv_db_per_product_monthly;
CREATE MATERIALIZED VIEW automatenlager.mv_db_per_product_monthly AS
  SELECT date_trunc('month'::text, posting_date::timestamp with time zone)::date AS month,
         tenant_id,
         product_id,
         sum(quantity_sold) AS qty,
         sum(revenue_net) AS revenue_net,
         round(sum(revenue_net - cost_of_goods * revenue_net / NULLIF(revenue_gross, 0::numeric)), 2) AS db_net
    FROM automatenlager.guv_daily
   WHERE source <> 'historic_backfill'::text
   GROUP BY (date_trunc('month'::text, posting_date::timestamp with time zone)::date), tenant_id, product_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_db_per_product_monthly_pk
  ON automatenlager.mv_db_per_product_monthly (month, tenant_id, product_id);

-- ── mv_db_per_slot_monthly: tenant_id-fuehrend ────────────────────────────────
-- mdb_code kann NULL sein -> NULLS NOT DISTINCT (wie im urspruenglichen Index),
-- damit der Unique-Index REFRESH ... CONCURRENTLY weiterhin traegt.
DROP MATERIALIZED VIEW IF EXISTS automatenlager.mv_db_per_slot_monthly;
CREATE MATERIALIZED VIEW automatenlager.mv_db_per_slot_monthly AS
  SELECT date_trunc('month'::text, posting_date::timestamp with time zone)::date AS month,
         tenant_id,
         machine_id,
         mdb_code,
         product_id,
         sum(quantity_sold) AS qty,
         sum(revenue_net) AS revenue_net,
         round(sum(revenue_net - cost_of_goods * revenue_net / NULLIF(revenue_gross, 0::numeric)), 2) AS db_net
    FROM automatenlager.guv_daily
   WHERE source <> 'historic_backfill'::text
   GROUP BY (date_trunc('month'::text, posting_date::timestamp with time zone)::date), tenant_id, machine_id, mdb_code, product_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_db_per_slot_monthly_pk
  ON automatenlager.mv_db_per_slot_monthly (month, tenant_id, machine_id, mdb_code, product_id) NULLS NOT DISTINCT;
