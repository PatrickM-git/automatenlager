-- Migration 0006: workflow_state-Tabelle fuer WF3 Nayax-FIFO-Lauf-Tracking
-- Ersetzt den Google-Sheets-Tab "letzter Verkaufsworkflow" als Single Source of Truth.
-- Idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS automatenlager.workflow_state (
    workflow_key              TEXT PRIMARY KEY,
    last_inventory_review_at  TIMESTAMPTZ,
    state_json                JSONB,
    updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Seed-Eintrag fuer WF3 (existiert nach erstem WF3-Lauf bereits)
INSERT INTO automatenlager.workflow_state (workflow_key, last_inventory_review_at)
VALUES ('WF3_NAYAX_FIFO', NULL)
ON CONFLICT (workflow_key) DO NOTHING;
