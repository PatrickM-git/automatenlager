'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Off-Site-Backup der Supabase-DB — Issue #216 (Betriebsreife A3, cloud-nativ).
//
// Die Supabase-Gratis-Stufe hat KEINE automatischen Backups. Dieser Infra-Job
// zieht einen geplanten `pg_dump` (custom-Format, Schemas automatenlager+audit)
// von der Supabase-DB an einen Off-Site-Ablageort (SUPABASE_BACKUP_DIR — heute
// die externe Platte des Mini, der zugleich das DR-Rollback-Ziel ist), validiert
// den Dump (`pg_restore --list` + Size-Guard) und räumt per Retention auf.
//
// ALARMKETTE (AC: fehlgeschlagener/ausbleibender Lauf ⇒ Alarm):
//  - Fehlerlauf: wirft (⇒ audit.workflow_runs status=error via Runner), schreibt
//    eine unresolved BACKUP_FAIL-Warnung (der Anomalie-Monitor mailt BACKUP_*
//    bereits KRITISCH, lib/jobs/anomaly-monitor.js) und mailt zusätzlich direkt
//    (best effort — Mail-Fehler verschluckt den Job-Fehler nie).
//  - Ausbleibender Lauf: evaluateBackupStaleness (vom Anomalie-Monitor pro Tick
//    aufgerufen) synthetisiert eine BACKUP_STALE-Warnung, wenn der letzte
//    erfolgreiche Lauf älter als SUPABASE_BACKUP_MAX_AGE_H ist (Default 30 h).
//  - Erfolgslauf löst offene BACKUP_FAIL-Warnungen auf (Alarm verstummt).
//
// CRON-QUELLE: heute der Worker (dailyAt, wie alle Nachtjobs); mit #217 wird der
// Auslöser wie alle Jobs auf pg_cron→Trigger-Endpunkt umgehängt (Entscheidung
// docs/cloud-migration/slice-0-cron-quelle-entscheidung.md, Zeile „Off-Site-Backup").
//
// VERSIONS-PFLICHT: Supabase ist PG 17 ⇒ pg_dump/pg_restore müssen PG-17-Clients
// sein (SUPABASE_BACKUP_PG_BIN zeigt aufs bin-Verzeichnis; Default: PATH).
// #107-rein: kein rohes pg — Warnungs-Schreibpfad läuft über den injizierten
// INFRA-Executor (System-Health, bewusst nicht durch die Mandanten-Tür, wie
// anomaly-monitor.js).
// ─────────────────────────────────────────────────────────────────────────────

const path = require('node:path');

const SUPABASE_BACKUP_KEY = 'backup-supabase';
const DEFAULTS = Object.freeze({
  retentionDays: 30,
  minBytes: 20_000,     // leeres/abgebrochenes Archiv erkennen (DB ist ~MB-groß)
  minTocEntries: 40,    // Vollständigkeit: beide Schemas liefern weit mehr TOC-Zeilen
  maxAgeH: 30,          // Staleness: täglicher Lauf + Puffer
});

function clean(v) { return String(v == null ? '' : v).trim(); }

function backupConfig(env = {}) {
  const url = clean(env.SUPABASE_PG_URL_SESSION);
  const dir = clean(env.SUPABASE_BACKUP_DIR);
  const bin = clean(env.SUPABASE_BACKUP_PG_BIN);
  return {
    url,
    dir,
    pgDump: bin ? path.join(bin, 'pg_dump') : 'pg_dump',
    pgRestore: bin ? path.join(bin, 'pg_restore') : 'pg_restore',
    retentionDays: Number(env.SUPABASE_BACKUP_RETENTION_DAYS) || DEFAULTS.retentionDays,
    minBytes: Number(env.SUPABASE_BACKUP_MIN_BYTES) || DEFAULTS.minBytes,
    maxAgeH: Number(env.SUPABASE_BACKUP_MAX_AGE_H) || DEFAULTS.maxAgeH,
    configured: !!(url && dir),
  };
}

// Default-Kommando-Runner: execFile (kein Shell-Quoting-Risiko), 10-min-Limit.
function defaultRunCmd(cmd, args) {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message = `${cmd}: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 400)}` : ''}`; reject(err); return; }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Staleness-Auswertung (REIN, vom Anomalie-Monitor pro Tick aufgerufen):
// nur wenn das Backup konfiguriert ist; ohne je einen Erfolgslauf oder älter
// als maxAgeH ⇒ BACKUP_STALE-Warnung (Form wie automatenlager.warnings-Zeile,
// damit der bestehende BACKUP_ALERT-Pfad sie kritisch mailt).
function evaluateBackupStaleness({ configured, lastOkAt, now, maxAgeH = DEFAULTS.maxAgeH } = {}) {
  if (!configured) return null;
  const nowMs = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
  const lastMs = lastOkAt ? new Date(lastOkAt).getTime() : NaN;
  if (!Number.isFinite(lastMs)) {
    return { warning_type: 'BACKUP_STALE', message: 'Noch KEIN erfolgreicher Supabase-Backup-Lauf (backup-supabase) registriert.' };
  }
  const ageH = Math.round((nowMs - lastMs) / 3_600_000);
  if (ageH <= maxAgeH) return null;
  return { warning_type: 'BACKUP_STALE', message: `Letztes erfolgreiches Supabase-Backup ist ${ageH} h alt (Limit ${maxAgeH} h).` };
}

// Letzten Erfolgslauf aus der Lauf-Telemetrie lesen (Infra-Executor).
async function readLastBackupOk(exec) {
  const res = await exec(
    `SELECT max(finished_at) AS last_ok FROM audit.workflow_runs
      WHERE workflow_key = $1 AND lower(status) IN ('ok','success')`,
    [SUPABASE_BACKUP_KEY],
  );
  return (res && res.rows && res.rows[0] && res.rows[0].last_ok) || null;
}

/**
 * @param {object} deps
 * @param {(sql:string,params:any[])=>Promise<{rows:any[]}>} deps.exec  INFRA-Executor (Warnungen).
 * @param {{send:Function}} [deps.mailer]   Alert-Mail (best effort).
 * @param {object} [deps.env]
 * @param {(cmd:string,args:string[])=>Promise<{stdout:string}>} [deps.runCmd]  injizierbar (Tests).
 * @param {object} [deps.fsImpl]  injizierbares fs (Tests).
 * @param {()=>Date} [deps.now]
 */
function createSupabaseBackupJob({ exec, mailer, env = process.env, runCmd, fsImpl, now } = {}) {
  if (typeof exec !== 'function') throw new TypeError('backup-supabase: exec (INFRA-Executor) erforderlich');
  const cmd = typeof runCmd === 'function' ? runCmd : defaultRunCmd;
  const fsx = fsImpl || require('node:fs');
  const clock = typeof now === 'function' ? now : () => new Date();

  async function raiseAlarm(err) {
    const day = clock().toISOString().slice(0, 10);
    try {
      await exec(
        `INSERT INTO automatenlager.warnings (warning_key, warning_type, severity, message, source_workflow)
         VALUES ($1, 'BACKUP_FAIL', 'critical', $2, $3)
         ON CONFLICT (tenant_id, warning_key)
         DO UPDATE SET resolved = FALSE, resolved_at = NULL, message = EXCLUDED.message`,
        [`backup_fail_${day}`, `Supabase-Backup fehlgeschlagen: ${err && err.message}`.slice(0, 500), SUPABASE_BACKUP_KEY],
      );
    } catch { /* Warnungs-Schreibfehler darf den Originalfehler nicht maskieren */ }
    const to = clean(env.ALERT_EMAIL_DEFAULT);
    if (mailer && typeof mailer.send === 'function' && to) {
      try {
        await mailer.send({
          to,
          subject: '[ALARM] Supabase-Backup fehlgeschlagen',
          text: `Der geplante pg_dump der Supabase-DB ist fehlgeschlagen:\n\n${err && err.message}\n\nJob: ${SUPABASE_BACKUP_KEY} · ${clock().toISOString()}`,
        });
      } catch { /* best effort — Mail-Ausfall verschluckt den Job-Fehler nie */ }
    }
  }

  return {
    key: SUPABASE_BACKUP_KEY,
    run: async () => {
      const cfg = backupConfig(env);
      if (!cfg.configured) {
        return { skipped: true, reason: 'SUPABASE_PG_URL_SESSION/SUPABASE_BACKUP_DIR nicht konfiguriert' };
      }
      const stamp = clock().toISOString().replace(/[:.]/g, '-');
      const file = path.join(cfg.dir, `supabase-automatenlager-${stamp}.dump`);
      try {
        fsx.mkdirSync(cfg.dir, { recursive: true });

        // 1) Dump (custom-Format; --no-owner, damit der Restore auf Mini/neuem
        //    Projekt nicht an einer fehlenden Eigentümer-Rolle scheitert).
        await cmd(cfg.pgDump, ['--format=custom', '--no-owner', '-n', 'automatenlager', '-n', 'audit', '-f', file, cfg.url]);

        // 2) Size-Guard: abgebrochene/leere Archive sofort erkennen.
        const bytes = fsx.statSync(file).size;
        if (!(bytes >= cfg.minBytes)) {
          throw new Error(`Dump verdächtig klein (${bytes} B < ${cfg.minBytes} B Size-Guard)`);
        }

        // 3) Validierung: pg_restore --list muss das Archiv lesen können und
        //    eine plausible TOC-Breite liefern (beide Schemas).
        const { stdout } = await cmd(cfg.pgRestore, ['--list', file]);
        const tocEntries = String(stdout).split(/\r?\n/).filter((l) => /^\d+;/.test(l.trim())).length;
        if (tocEntries < DEFAULTS.minTocEntries) {
          throw new Error(`Dump-Validierung: nur ${tocEntries} TOC-Einträge (< ${DEFAULTS.minTocEntries})`);
        }

        // 4) Retention: alte Sicherungen löschen (Dateiname-Präfix-Match).
        const cutoff = clock().getTime() - cfg.retentionDays * 24 * 3_600_000;
        let pruned = 0;
        for (const name of fsx.readdirSync(cfg.dir)) {
          if (!/^supabase-automatenlager-.*\.dump$/.test(name)) continue;
          const full = path.join(cfg.dir, name);
          const st = typeof fsx.statSyncFor === 'function' ? fsx.statSyncFor(full) : fsx.statSync(full);
          if (st.mtimeMs < cutoff) { fsx.unlinkSync(full); pruned += 1; }
        }

        // 5) Erfolg: offene BACKUP_FAIL-Warnungen auflösen (Alarm verstummt).
        await exec(
          `UPDATE automatenlager.warnings
              SET resolved = TRUE, resolved_at = NOW(), resolved_by = $1
            WHERE warning_type = 'BACKUP_FAIL' AND resolved = FALSE AND source_workflow = $1`,
          [SUPABASE_BACKUP_KEY],
        );

        return { ok: true, file, bytes, tocEntries, pruned };
      } catch (err) {
        // Partial-/Leerdatei eines Fehllaufs nicht liegen lassen (Retention
        // greift nur bei Erfolg; ein 0-Byte-.dump wäre irreführend).
        try { if (typeof fsx.unlinkSync === 'function') fsx.unlinkSync(file); } catch { /* existiert ggf. nicht */ }
        await raiseAlarm(err);
        throw err;
      }
    },
  };
}

module.exports = {
  SUPABASE_BACKUP_KEY,
  backupConfig,
  createSupabaseBackupJob,
  evaluateBackupStaleness,
  readLastBackupOk,
};
