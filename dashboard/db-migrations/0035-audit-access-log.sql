-- Migration 0035: audit.access_log — Audit-/Guest-Access-Log in die DB (Issue #213)
-- SPEC: docs/specs/cloud-migration-3-schichten-phase-b-v1.md §"Flüchtiges Cloud-Dateisystem (Render)"
--
-- ZWECK: Auf flüchtigen Cloud-Containern (Render) überlebt die bisherige JSONL-Datei
-- (dashboard/logs/guest-access.jsonl) keinen Neustart — Restarts würden Log-Lücken
-- reißen und der Anomalie-Monitor (#168, lib/jobs/anomaly-monitor.js) verlöre seine
-- Quelle. Diese Tabelle ist ab jetzt die MASSGEBLICHE Senke des zentralen Audit-
-- Trails (#32, server.js auditAction/auditDenied/auditGuestAccess); die JSONL-Datei
-- bleibt nur als best-effort-Fallback für lokale Dev bestehen.
--
-- Die Spalten bilden die heute in guest-access.jsonl geschriebenen Felder ab:
-- Zeitstempel, Login/Subjekt, Rolle, Quelle/Pfad, Aktion/Resultat, request-id,
-- sourceAddress; alle weiteren Detail-Felder (capability, machineKey, Break-Glass-
-- Felder wie actingLogin/homeTenant, …) landen im JSONB `details`.
--
-- BEWUSST KEIN tenant_id: das ist geteilte PIPELINE-/Infra-Telemetrie (analog
-- audit.workflow_runs, Migration 0027) — geschrieben/gelesen über die INFRA-
-- Verbindung, NICHT durch die Mandanten-Tür, kein RLS, kein Mandanten-Scope.
-- Der Mandant des HANDELNDEN Viewers wird rein informativ als `viewer_tenant`
-- protokolliert (Forensik), `target_tenant` trägt das Break-Glass-Ziel (#118).
--
-- Append-only per Konvention (der Schreiber kennt nur INSERT). IDEMPOTENT
-- (CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS), reines DDL (sandbox-/rollback-sicher).

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.access_log (
  access_id      BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),  -- Zeitstempel des Ereignisses
  event          TEXT        NOT NULL,                -- z. B. capability_denied, dashboard_view, config_write
  outcome        TEXT        NOT NULL DEFAULT 'ok',   -- ok | denied | guest_view | …
  login          TEXT,                                -- handelndes Subjekt (Tailscale-Login)
  role           TEXT,                                -- aufgelöste Rolle (guest/admin/…)
  role_key       TEXT,
  viewer_tenant  TEXT,                                -- Mandant des Viewers (informativ, KEIN Scope)
  endpoint       TEXT,                                -- Quelle/Pfad (z. B. /api/v2/overview)
  method         TEXT,
  source_address TEXT,                                -- req.socket.remoteAddress (nicht fälschbar)
  request_id     TEXT,                                -- per-Request-Korrelation (#117)
  target_tenant  TEXT,                                -- Break-Glass-Ziel (#118) — Anomalie-Signal
  details        JSONB                                -- alle übrigen secret-freien Detail-Felder
);

-- Lese-Indizes für den Anomalie-Monitor (#168: Fenster-Scan nach Zeit + denied-Häufung).
CREATE INDEX IF NOT EXISTS access_log_ts_idx         ON audit.access_log (ts DESC);
CREATE INDEX IF NOT EXISTS access_log_outcome_ts_idx ON audit.access_log (outcome, ts DESC);
