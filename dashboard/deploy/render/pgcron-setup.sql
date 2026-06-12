-- pg_cron-Schedules → geschützte Render-Trigger — Issue #217 (Cloud-Slice 3).
-- ---------------------------------------------------------------------------
-- Ersetzt den Dauer-Worker auf der Render-Gratis-Stufe: pg_cron stößt zu festen
-- Zeiten POST {RENDER_URL}/internal/jobs/<key> an, mit dem gemeinsamen Secret
-- (X-Worker-Trigger-Secret). Die Job-LOGIK bleibt identisch (server.js baut den
-- Worker lazy, runJobNow + Telemetrie in audit.workflow_runs).
--
-- VORAUSSETZUNGEN / EINMALIG im Supabase-SQL-Editor (als Eigentümer):
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
-- Beide sind auf Supabase-Gratis verfügbar (pg_available_extensions verifiziert).
--
-- ANWENDUNG: zwei Platzhalter ersetzen, dann ausführen:
--   :RENDER_URL            -> z. B. https://faltrix-dashboard.onrender.com
--   :WORKER_TRIGGER_SECRET -> exakt der Render-Env-Wert (generateValue in render.yaml)
-- Idempotent: jeder Job wird vor dem (Neu)Anlegen entplant (cron.unschedule).
-- Zeitzone: pg_cron plant in UTC. Die Schedules unten sind in UTC angegeben;
-- die Kommentare nennen die Berlin-Zeit (Sommerzeit CEST = UTC+2).

-- Komfort-Wrapper: einen geschützten Trigger feuern (Antwort interessiert nicht;
-- das Ergebnis steht in audit.workflow_runs).
CREATE OR REPLACE FUNCTION automatenlager.fire_job(p_key text, p_base_url text, p_secret text)
RETURNS bigint LANGUAGE sql AS $$
  SELECT net.http_post(
    url     := p_base_url || '/internal/jobs/' || p_key,
    headers := jsonb_build_object('Content-Type','application/json','X-Worker-Trigger-Secret', p_secret),
    body    := '{}'::jsonb
  );
$$;

-- Helfer: (re)planen. \set-Variablen aus psql werden als :'name' eingesetzt.
-- Schedule-Matrix (= worker.js, Cron-Doc Slice 0). Live-Motoren (alle 5 Min)
-- sind idempotent und kurze HTTP-Calls — auf Gratis vertretbar.
DO $cron$
DECLARE
  base   text := :'RENDER_URL';
  secret text := :'WORKER_TRIGGER_SECRET';
  jobs   jsonb := jsonb_build_array(
    -- [key, cron(UTC), Kommentar]
    jsonb_build_array('wf3-nayax-fifo',        '*/5 * * * *',  'WF3 Nayax-Verkäufe (alle 5 Min)'),
    jsonb_build_array('nayax-filllevel-sync',  '*/5 * * * *',  'Live-Füllstand (alle 5 Min)'),
    jsonb_build_array('wf-guv-aggregate',      '*/15 * * * *', 'GuV-Aggregat (alle 15 Min)'),
    jsonb_build_array('wf1-invoice-intake',    '*/10 * * * *', 'WF1 Rechnungseingang (alle 10 Min)'),
    jsonb_build_array('wf9-pickliste',         '*/5 * * * *',  'WF9 Pickliste (alle 5 Min)'),
    jsonb_build_array('anomaly-monitor',       '*/30 * * * *', 'Anomalie-Monitor (alle 30 Min)'),
    jsonb_build_array('claude-proposals',      '30 2 * * *',   'Claude-Proposals (04:30 CEST)'),
    jsonb_build_array('wf5-monitor',           '0 5 * * *',    'WF5 MHD/Low-Stock (07:00 CEST)'),
    jsonb_build_array('wf-matview-refresh',    '45 2 * * *',   'MatView-Refresh (04:45 CEST)'),
    jsonb_build_array('backup-supabase',       '15 1 * * *',   'Off-Site-Backup (03:15 CEST) — nur falls Render-Ziel gesetzt')
  );
  j        jsonb;
  job_name text;
BEGIN
  FOR j IN SELECT * FROM jsonb_array_elements(jobs) LOOP
    job_name := 'faltrix_' || (j->>0);
    PERFORM cron.unschedule(job_name) WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name);
    PERFORM cron.schedule(
      job_name,
      j->>1,
      format('SELECT automatenlager.fire_job(%L, %L, %L)', j->>0, base, secret)
    );
  END LOOP;
END
$cron$;

-- Kontrolle:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'faltrix_%' ORDER BY 1;
--   SELECT jobname, status, return_message, start_time FROM cron.job_run_details
--     ORDER BY start_time DESC LIMIT 20;
