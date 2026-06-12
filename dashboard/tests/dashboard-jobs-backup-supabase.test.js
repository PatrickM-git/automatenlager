'use strict';

/**
 * Issue #216 — Off-Site-Backup der Supabase-DB (geplanter pg_dump + Alarm).
 * --------------------------------------------------------------------------
 * DB-/Netz-freie Unit-Tests gegen lib/jobs/backup-supabase.js: pg_dump/
 * pg_restore werden als injizierter runCmd simuliert, das Dateisystem als
 * fsImpl, die Warning-/Mail-Senke als exec/mailer-Stubs. Geprüft:
 *  - fehlende Konfiguration ⇒ sauberer Skip (kein Wurf, kein Alarm)
 *  - Erfolgsfall: Dump + Validierung (pg_restore --list) + Size-Guard +
 *    Retention-Pruning + offene BACKUP_FAIL-Warnungen werden aufgelöst
 *  - Fehlerfälle (pg_dump kracht / Dump zu klein / Validierung kracht) ⇒
 *    wirft UND schreibt BACKUP_FAIL-Warnung UND mailt (best effort)
 *  - evaluateBackupStaleness: ausbleibender Lauf ⇒ BACKUP_STALE (Alarmkette
 *    über den Anomalie-Monitor, der BACKUP_*-Warnungen bereits kritisch mailt)
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSupabaseBackupJob,
  evaluateBackupStaleness,
  SUPABASE_BACKUP_KEY,
} = require('../lib/jobs/backup-supabase.js');

const ENV_OK = {
  SUPABASE_PG_URL_SESSION: 'postgresql://postgres.x:pw@pooler.test:5432/postgres',
  SUPABASE_BACKUP_DIR: '/backups/supabase',
  SUPABASE_BACKUP_MIN_BYTES: '1000',
  SUPABASE_BACKUP_RETENTION_DAYS: '30',
  ALERT_EMAIL_DEFAULT: 'ops@example.test', // ohne Empfänger keine Alarm-Mail (by design)
};

// Fake-Dateisystem: nur die vom Job genutzten Operationen.
function makeFs({ dumpBytes = 5000, oldFiles = [] } = {}) {
  const calls = { mkdir: [], unlinked: [] };
  return {
    calls,
    mkdirSync: (dir) => calls.mkdir.push(dir),
    statSync: () => ({ size: dumpBytes, mtimeMs: Date.now() }),
    readdirSync: () => oldFiles.map((f) => f.name),
    statFile: null,
    // Retention: der Job fragt mtime je Datei ab — über statSyncFor simulieren.
    statSyncFor: (file) => {
      const found = oldFiles.find((f) => file.endsWith(f.name));
      return { size: 1, mtimeMs: found ? found.mtimeMs : Date.now() };
    },
    unlinkSync: (file) => calls.unlinked.push(file),
  };
}

function makeExec() {
  const queries = [];
  return { queries, exec: async (sql, params) => { queries.push({ sql: String(sql), params }); return { rows: [], rowCount: 0 }; } };
}

function makeMailer() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { ok: true }; } };
}

const TOC_OK = Array.from({ length: 60 }, (_, i) => `${i + 1}; 1259 200${i} TABLE automatenlager t${i} postgres`).join('\n');

test('#216 fehlende Konfiguration ⇒ Skip ohne Wurf/Alarm', async () => {
  const { exec, queries } = makeExec();
  const mailer = makeMailer();
  const job = createSupabaseBackupJob({ exec, mailer, env: {}, runCmd: async () => ({ stdout: '' }), fsImpl: makeFs() });
  assert.equal(job.key, SUPABASE_BACKUP_KEY);
  const r = await job.run();
  assert.equal(r.skipped, true);
  assert.equal(queries.length, 0);
  assert.equal(mailer.sent.length, 0);
});

test('#216 Erfolg: pg_dump + Validierung + Pruning + FAIL-Warnungen aufgelöst', async () => {
  const { exec, queries } = makeExec();
  const mailer = makeMailer();
  const cmds = [];
  const old = Date.now() - 40 * 24 * 3600 * 1000; // 40 Tage alt > Retention 30
  const fsImpl = makeFs({ dumpBytes: 5000, oldFiles: [
    { name: 'supabase-automatenlager-alt.dump', mtimeMs: old },
    { name: 'supabase-automatenlager-frisch.dump', mtimeMs: Date.now() },
  ] });
  const job = createSupabaseBackupJob({
    exec, mailer, env: ENV_OK, fsImpl,
    runCmd: async (cmd, args) => { cmds.push({ cmd, args }); return { stdout: cmd.includes('pg_restore') ? TOC_OK : '' }; },
  });
  const r = await job.run();
  assert.equal(r.ok, true);
  assert.ok(r.bytes >= 1000);
  assert.ok(r.tocEntries >= 40, 'Validierung zählt TOC-Einträge');
  // pg_dump mit custom-Format + beiden Schemas; pg_restore --list zur Validierung.
  assert.ok(cmds[0].cmd.includes('pg_dump'));
  assert.ok(cmds[0].args.includes('--format=custom'));
  assert.ok(cmds[0].args.includes('automatenlager') && cmds[0].args.includes('audit'));
  assert.ok(cmds[1].cmd.includes('pg_restore'));
  assert.ok(cmds[1].args.includes('--list'));
  // Retention: alte Datei gelöscht, frische bleibt.
  assert.equal(r.pruned, 1);
  assert.ok(fsImpl.calls.unlinked[0].includes('alt'));
  // Offene BACKUP_FAIL-Warnungen werden bei Erfolg aufgelöst (Alarm verstummt).
  assert.ok(queries.some((q) => /UPDATE\s+automatenlager\.warnings/i.test(q.sql) && /BACKUP_FAIL/.test(q.sql)));
  assert.equal(mailer.sent.length, 0, 'Erfolg mailt nicht');
});

async function expectAlarm(jobOpts, expectMessageRe) {
  const { exec, queries } = makeExec();
  const mailer = makeMailer();
  const job = createSupabaseBackupJob({ exec, mailer, env: ENV_OK, ...jobOpts });
  await assert.rejects(() => job.run(), expectMessageRe);
  const ins = queries.find((q) => /INSERT INTO automatenlager\.warnings/i.test(q.sql));
  assert.ok(ins, 'BACKUP_FAIL-Warnung wird geschrieben');
  assert.ok(/BACKUP_FAIL/.test(ins.sql + String(ins.params)), 'warning_type BACKUP_FAIL');
  assert.equal(mailer.sent.length, 1, 'Fehler mailt direkt (best effort)');
  assert.match(mailer.sent[0].subject, /Backup/i);
}

test('#216 pg_dump-Fehler ⇒ wirft + BACKUP_FAIL-Warnung + Mail', async () => {
  await expectAlarm({
    fsImpl: makeFs(),
    runCmd: async (cmd) => { if (cmd.includes('pg_dump')) throw new Error('connection refused'); return { stdout: TOC_OK }; },
  }, /connection refused/);
});

test('#216 zu kleiner Dump ⇒ wirft + Alarm (Size-Guard)', async () => {
  await expectAlarm({
    fsImpl: makeFs({ dumpBytes: 12 }),
    runCmd: async (cmd) => ({ stdout: cmd.includes('pg_restore') ? TOC_OK : '' }),
  }, /klein|size/i);
});

test('#216 kaputter Dump (Validierung) ⇒ wirft + Alarm', async () => {
  await expectAlarm({
    fsImpl: makeFs(),
    runCmd: async (cmd) => { if (cmd.includes('pg_restore')) throw new Error('input file does not appear to be a valid archive'); return { stdout: '' }; },
  }, /valid archive/);
});

test('#216 Mail-Fehler verschluckt den eigentlichen Fehler NICHT', async () => {
  const { exec } = makeExec();
  const job = createSupabaseBackupJob({
    exec, env: ENV_OK, fsImpl: makeFs(),
    mailer: { send: async () => { throw new Error('resend down'); } },
    runCmd: async () => { throw new Error('dump kaputt'); },
  });
  await assert.rejects(() => job.run(), /dump kaputt/);
});

// ── Staleness (ausbleibender Lauf ⇒ Alarmkette über den Anomalie-Monitor) ────

test('#216 evaluateBackupStaleness: frischer Lauf ⇒ kein Alarm; alter/fehlender ⇒ BACKUP_STALE', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  // Nicht konfiguriert ⇒ nie Alarm (Dev/Tests ohne Backup-Ziel).
  assert.equal(evaluateBackupStaleness({ configured: false, lastOkAt: null, now }), null);
  // Frisch (vor 2 h) ⇒ kein Alarm.
  assert.equal(evaluateBackupStaleness({ configured: true, lastOkAt: '2026-06-12T10:00:00Z', now, maxAgeH: 30 }), null);
  // 40 h alt ⇒ BACKUP_STALE.
  const stale = evaluateBackupStaleness({ configured: true, lastOkAt: '2026-06-10T18:00:00Z', now, maxAgeH: 30 });
  assert.equal(stale.warning_type, 'BACKUP_STALE');
  assert.match(stale.message, /42/, 'Alter in Stunden in der Meldung');
  // Noch NIE gelaufen ⇒ BACKUP_STALE.
  const never = evaluateBackupStaleness({ configured: true, lastOkAt: null, now, maxAgeH: 30 });
  assert.equal(never.warning_type, 'BACKUP_STALE');
});
