-- Migration 0036: audit.sales_reconciliation_log + Grants (Issue #221)
-- Nachbuchung unvollständig gelieferter Nayax-Verkäufe.
--
-- ZWECK: Audit-Logbuch für die Nachbuch-Reconciliation (lib/jobs/nayax-reconcile.js).
-- Je nachgebuchter sales_transactions-Zeile wird ein Eintrag mit Alt-/Neu-Werten
-- geschrieben (gross/net/status), damit jede Preis-/FIFO-Korrektur nachvollziehbar
-- und (über reconcile_run_id) rückrollbar ist. Vorbild: audit.guv_restatement_log
-- (Migration 0028) + dessen Grants (0030).
--
-- Der Reconcile-Lauf läuft DURCH DIE MANDANTEN-TÜR (lib/tenant-db.js, db.tx) als
-- eingeengte Rolle `automatenlager_app` (Mitglied von `app_writer`, kein BYPASSRLS) —
-- daher dieselbe Grant-Logik wie 0030. Lauf-Telemetrie (Start/Ende/Status) läuft
-- separat über audit.workflow_runs (Infra-Verbindung, kein tenant_id).
--
-- BEWUSST tenant_id NULLABLE + nur informativ (wie guv_restatement_log): das ist
-- Audit-/Pipeline-Telemetrie; der Schreibpfad durch die Tür setzt tenant_id selbst.
--
-- Reines DDL + GRANT, additiv und idempotent (CREATE … IF NOT EXISTS, Grants im
-- DO-Block defensiv geprüft) — sandbox-/rollback-sicher.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.sales_reconciliation_log (
  id                    BIGSERIAL   PRIMARY KEY,
  reconcile_run_id      TEXT        NOT NULL,        -- gruppiert alle Zeilen EINES Laufs
  tenant_id             TEXT,                         -- informativ (KEIN RLS-Scope)
  nayax_transaction_id  TEXT,
  machine_key           TEXT,
  product_key           TEXT,
  quantity              INTEGER,
  old_gross             NUMERIC,
  new_gross             NUMERIC,
  old_net               NUMERIC,
  new_net               NUMERIC,
  old_status            TEXT,
  new_status            TEXT,
  deducted_batches      TEXT,                         -- kommaseparierte batch_keys
  executed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_by           TEXT        NOT NULL DEFAULT 'reconcile-0036',
  executed_context      JSONB,                        -- run-id/host/git_commit/started_at
  rollback_at           TIMESTAMPTZ,
  rollback_by           TEXT
);

-- Rollback-/Forensik-Indizes: je Run zurücknehmen, optional auf eine Transaktion eingrenzen.
CREATE INDEX IF NOT EXISTS sales_reconciliation_log_run_idx
  ON audit.sales_reconciliation_log (reconcile_run_id);
CREATE INDEX IF NOT EXISTS sales_reconciliation_log_run_tx_idx
  ON audit.sales_reconciliation_log (reconcile_run_id, nayax_transaction_id);

-- Grants für den Door-Pfad (Rolle app_writer). Defensiv: fehlt die out-of-band-Rolle
-- (DB ohne RLS-Rollen, z. B. Dev/Supabase vor Slice 1), ist es ein No-Op (kein Fehler).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    RAISE NOTICE 'Migration 0036: Rolle app_writer fehlt — Grants übersprungen (DB ohne RLS-Rollen).';
    RETURN;
  END IF;
  GRANT INSERT, SELECT, UPDATE ON audit.sales_reconciliation_log TO app_writer;
  GRANT USAGE, SELECT ON SEQUENCE audit.sales_reconciliation_log_id_seq TO app_writer;
END $$;
