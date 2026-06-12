'use strict';

// #216: Off-Site-Backup der Supabase-DB EINMAL manuell ausführen — für den
// Live-Smoke nach der Aktivierung und als Notfall-Trigger (z. B. vor einem
// riskanten Eingriff). Läuft mit derselben Konfiguration wie der Worker
// (Prozess-Env + .env.local) und schreibt dieselbe Lauf-Telemetrie nach
// audit.workflow_runs (Quelle 'manual'), damit der Staleness-Wächter des
// Anomalie-Monitors den Lauf sieht.
//
//   cd dashboard && node tools/run-backup-once.js

const fs = require('node:fs');
const path = require('node:path');

const { Pool } = require('pg');
const { createSupabaseBackupJob } = require('../lib/jobs/backup-supabase.js');
const { createWorkflowRunRecorder } = require('../lib/workflow-runs.js');

function loadLocalEnv() {
  const merged = {};
  for (const fp of [path.join(__dirname, '..', '..', '.env.local'), path.join(__dirname, '..', '.env.local')]) {
    let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      merged[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return merged;
}

(async () => {
  const env = { ...loadLocalEnv(), ...process.env }; // Prozess-Env hat Vorrang (wie Worker-runtimeEnv)
  const infraUrl = env.DASHBOARD_V2_PG_URL || env.SUPABASE_PG_URL_SESSION;
  if (!infraUrl) { console.error('Keine Infra-PG-URL (DASHBOARD_V2_PG_URL/SUPABASE_PG_URL_SESSION).'); process.exit(2); }
  const pool = new Pool({ connectionString: infraUrl, max: 1 });
  const exec = (sql, params) => pool.query(sql, params);
  const recorder = createWorkflowRunRecorder({ exec, source: 'manual' });
  const job = createSupabaseBackupJob({ exec, env });
  try {
    const result = await recorder.recordRun(job.key, job.run);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Backup fehlgeschlagen:', err && err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
