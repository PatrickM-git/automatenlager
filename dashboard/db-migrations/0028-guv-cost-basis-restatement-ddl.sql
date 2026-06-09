-- Migration 0028: cost_basis-Spalte + audit.guv_restatement_log (Issue #175)
-- SPEC: docs/specs/guv-kostenbasis-kleinunternehmer-restatement-v1.md
--       §"Migrationen" (Reihenfolge DDL 0028 -> Klassifizierung 0029 -> Code -> Restatement 0030)
--
-- ZWECK: Schema-Fundament fuer die GuV-Kostenbasis-Korrektur (Kleinunternehmer ->
-- brutto) und das spaetere in-place-Restatement der Historie. REINES DDL, additiv
-- und idempotent, ohne jede Verhaltens- oder Datenaenderung:
--   1) automatenlager.guv_daily.cost_basis ('netto'/'brutto', NULLABLE, KEIN Default)
--      -- bewusst kein Default, damit jede Zeile spaeter EXPLIZIT klassifiziert wird
--      (kein stilles Auffuellen). CHECK erlaubt nur die zwei Werte (NULL erlaubt).
--   2) audit.guv_restatement_log (Vorbild audit.workflow_runs aus 0027): je restateter
--      Zeile Alt-/Neu-Werte, MwSt/Faktor, Run-ID, Audit-Kontext, Rollback-Felder.
--
-- Spalte UND Tabelle bleiben nach diesem Issue UNGENUTZT (Code stempelt erst in einem
-- Folge-Issue, Restatement laeuft erst in 0030) -> der Deploy ist gefahrlos und voll
-- rueckwegsfaehig. Nacht-Job, Live-Pfad und GuV-Panel bleiben unveraendert.
--
-- Sandbox-/rollback-sicher (alles IF NOT EXISTS; Constraint idempotent via DO-Block).

-- 1) cost_basis-Spalte: nullable, KEIN Default -> Bestandszeilen bleiben NULL.
ALTER TABLE automatenlager.guv_daily ADD COLUMN IF NOT EXISTS cost_basis TEXT;

-- CHECK auf die zwei erlaubten Werte (NULL bleibt erlaubt). ADD CONSTRAINT kennt kein
-- IF NOT EXISTS -> idempotent ueber pg_constraint-Pruefung.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'guv_daily_cost_basis_chk'
       AND conrelid = 'automatenlager.guv_daily'::regclass
  ) THEN
    ALTER TABLE automatenlager.guv_daily
      ADD CONSTRAINT guv_daily_cost_basis_chk
      CHECK (cost_basis IS NULL OR cost_basis IN ('netto', 'brutto'));
  END IF;
END $$;

-- 2) Audit-Logbuch fuer das Restatement (im bestehenden audit-Schema, Vorbild 0027).
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.guv_restatement_log (
  id                  BIGSERIAL   PRIMARY KEY,
  restatement_run_id  TEXT        NOT NULL,         -- gruppiert alle Zeilen EINES Laufs
  tenant_id           TEXT,
  guv_key             TEXT,
  source              TEXT,                          -- wf8_guv_aggregator / historic_backfill
  old_cost_of_goods   NUMERIC,
  new_cost_of_goods   NUMERIC,
  old_revenue_net     NUMERIC,
  new_revenue_net     NUMERIC,
  old_gross_profit    NUMERIC,
  new_gross_profit    NUMERIC,
  vat_rate            NUMERIC,                       -- kanonischer Kategorie-MwSt-Satz
  factor              NUMERIC,                       -- (1 + vat_rate/100)
  executed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_by         TEXT        NOT NULL DEFAULT 'restatement-0030',
  executed_context    JSONB,                         -- operator/host/git_commit/migration/started_at
  rollback_at         TIMESTAMPTZ,
  rollback_by         TEXT
);

-- Rollback-Indizes: je Run zuruecknehmen, optional auf einzelne guv_key eingrenzen.
CREATE INDEX IF NOT EXISTS guv_restatement_log_run_idx
  ON audit.guv_restatement_log (restatement_run_id);
CREATE INDEX IF NOT EXISTS guv_restatement_log_run_key_idx
  ON audit.guv_restatement_log (restatement_run_id, guv_key);
