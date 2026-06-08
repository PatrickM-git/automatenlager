-- Migration 0027: audit.workflow_runs Schreibvertrag (Stufe 6, Slice 0, Issue #160)
-- SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Job-Lauf-Telemetrie" + §"Migrationen"
--
-- ZWECK: Der Worker-Telemetrie-Schreiber (dashboard/lib/workflow-runs.js) ersetzt
-- n8ns interne execution_entity und protokolliert je Lauf Start/Ende/Status/FEHLER
-- (workflow_key = Job-Name). Die Tabelle audit.workflow_runs existiert bereits
-- out-of-band (von pgw_write/n8n angelegt); Pre-Flight #160 (tools/preflight-pgw-write.js)
-- ergab die realen Spalten: run_id, workflow_key, started_at, finished_at, status,
-- records_in, records_out, records_failed, notes — ABER weder `error` noch `source`.
--
-- Diese Migration ist ADDITIV + IDEMPOTENT:
--   1) Schema/Tabelle anlegen, falls nicht vorhanden (frische DB / Sandbox / CI).
--   2) error/source/details ergänzen (vom neuen Schreiber genutzt) — IF NOT EXISTS,
--      damit der reale Mini-Bestand und pgw_write UNBERÜHRT bleiben (pgw_write
--      referenziert diese Spalten nicht).
--   3) Lese-Indizes für Monitoring (alert-digest/overview-monitoring lesen nach
--      workflow_key + started_at und filtern auf status).
--
-- audit.workflow_runs ist SYSTEM-Telemetrie OHNE tenant_id (geteilte Pipeline) und
-- bleibt es (SPEC). Kein RLS, kein Mandanten-Bezug. Reines DDL (sandbox-/rollback-sicher).

CREATE SCHEMA IF NOT EXISTS audit;

-- 1) Basistabelle (Spalten spiegeln den realen Mini-Stand laut Pre-Flight #160).
CREATE TABLE IF NOT EXISTS audit.workflow_runs (
  run_id          BIGSERIAL PRIMARY KEY,
  workflow_key    TEXT        NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'running',
  records_in      INTEGER,
  records_out     INTEGER,
  records_failed  INTEGER,
  notes           TEXT
);

-- 2) Telemetrie-Ergänzungen (additiv) — vom Worker-Schreiber benötigt.
ALTER TABLE audit.workflow_runs ADD COLUMN IF NOT EXISTS error   TEXT;
ALTER TABLE audit.workflow_runs ADD COLUMN IF NOT EXISTS source  TEXT;
ALTER TABLE audit.workflow_runs ADD COLUMN IF NOT EXISTS details JSONB;

-- 3) Lese-Indizes (Monitoring/Konsistenz-Checks ersetzen n8ns execution_entity).
CREATE INDEX IF NOT EXISTS workflow_runs_key_started_idx ON audit.workflow_runs (workflow_key, started_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_started_idx     ON audit.workflow_runs (started_at DESC);
