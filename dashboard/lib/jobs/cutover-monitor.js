'use strict';

/**
 * Cutover-Readiness-Wächter (Stufe 6, Slice 3 → Cutover #198).
 *
 * Die datenkritischen Pfade (WF3, WF1) laufen im Schattenbetrieb (compute+compare,
 * kein Schreiben). Der Cutover ist erst zulässig, wenn die Schatten-Diffs über
 * MEHRERE Tage MIT echter Aktivität deckungsgleich sind (Kriterium: docs/data-model/
 * wf3-nayax-sales-cutover.md). Dieser Worker-Job prüft das täglich, zählt die
 * deckungsgleiche Serie in workflow_state und **mailt aktiv**, sobald das Kriterium
 * erfüllt ist — damit der Cutover nicht „ewig offen" bleibt und niemand dran denken muss.
 *
 * Er ruft die bestehenden Schatten-Jobs (`run()` im Schatten-Modus) read-only auf —
 * KEIN Schreibpfad, nur Streak-Persistenz (workflow_state) durch die Tür. #107-rein.
 */

const { resolveTenantAlertEmail } = require('./mailer.js');

const CUTOVER_MONITOR_KEY = 'cutover-readiness-monitor';
const DEFAULT_THRESHOLD = 7;

/**
 * Reine Logik: Serien-Stand fortschreiben.
 * - keine Aktivität (vakuös) ⇒ Stand UNVERÄNDERT (zählt nicht, setzt nicht zurück).
 * - deckungsgleich + Aktivität ⇒ streak + 1.
 * - ungleich ⇒ streak 0, alerted zurück.
 * shouldAlert nur beim ERSTMALIGEN Erreichen der Schwelle (alerted-Flag verhindert Spam).
 * @returns {{state:{streak:number, alerted:boolean}, shouldAlert:boolean}}
 */
function updateStreak(prev, { equal, hadActivity } = {}, threshold = DEFAULT_THRESHOLD) {
  const cur = { streak: Number((prev && prev.streak) || 0), alerted: !!(prev && prev.alerted) };
  if (!hadActivity) return { state: cur, shouldAlert: false };
  if (!equal) return { state: { streak: 0, alerted: false }, shouldAlert: false };
  const streak = cur.streak + 1;
  const reached = streak >= threshold;
  const shouldAlert = reached && !cur.alerted;
  return { state: { streak, alerted: cur.alerted || reached }, shouldAlert };
}

// Stabile Signatur der Diff-Probe (Schlüssel + Mismatch-Felder), um Tages-Spam zu
// vermeiden: nur bei NEUEM/geändertem Diff mailen.
function diffSignature(diffSample) {
  if (!diffSample) return '';
  try { return JSON.stringify(diffSample); } catch { return String(diffSample); }
}

function buildDiffMail(label, diffSample) {
  const subject = `Schatten-Diff erkannt: ${label} — Port weicht von n8n ab (blockiert Cutover)`;
  const text = [
    `Der Schattenbetrieb für "${label}" ist NICHT deckungsgleich mit n8n — die Serie wurde zurückgesetzt.`,
    'Solange der Diff besteht, wird das Cutover-Kriterium nie erreicht; der Port-Code muss angeglichen werden.',
    '',
    'Diff-Probe (bis zu 5 je Kategorie):',
    JSON.stringify(diffSample, null, 2),
    '',
    'Nächster Schritt: Port-Logik (lib/jobs/*) gegen das n8n-Verhalten prüfen und angleichen,',
    'dann Tests + Redeploy. Der Selbstheilungs-Agent öffnet dafür automatisch einen PR.',
  ].join('\n');
  return { subject, text, html: `<pre>${text.replace(/</g, '&lt;')}</pre>` };
}

function buildDiffIssueBody(label, diffSample) {
  return [
    `## Schatten-Diff: ${label} weicht von n8n ab (blockiert Cutover #198)`,
    '',
    'Der portierte Job rechnet andere Writes als n8n. Solange der Diff besteht, wird die',
    'Deckungsgleichheits-Serie zurückgesetzt und das Cutover-Kriterium nie erreicht — der',
    '**Port-Code muss angeglichen werden** (oder, falls n8n falsch ist, begründet verworfen).',
    '',
    '### Diff-Probe (bis zu 5 Schlüssel je Kategorie)',
    '```json',
    JSON.stringify(diffSample, null, 2),
    '```',
    '',
    '### Vorgehen',
    '- Port (`dashboard/lib/jobs/nayax-sales.js` bzw. `invoice-intake.js`) vs. n8n-Verhalten',
    '  (WF3/WF1-JSONs + `docs/data-model/pgw-write-und-workflow-runs-preflight.md`) vergleichen.',
    '- Port angleichen, Tests (`node --test tests/dashboard-jobs-*.test.js`), PR. **Kein** Auto-Merge/Deploy.',
    '',
    '_Automatisch vom Cutover-Wächter erstellt (Worker, 24/7)._',
  ].join('\n');
}

function buildReadinessMail(label, streak, threshold) {
  const subject = `Cutover-Kriterium erfüllt: ${label} (${streak} deckungsgleiche Schattenläufe)`;
  const text = [
    `Der Schattenbetrieb für "${label}" ist seit ${streak} Läufen (Schwelle ${threshold}) deckungsgleich mit n8n.`,
    '',
    'Das Cutover-Kriterium (siehe docs/data-model/wf3-nayax-sales-cutover.md, Issue #198) ist erfüllt.',
    'Nächster Schritt: das Cutover-Flag setzen (WF3_CUTOVER / WF1_CUTOVER = 1), Worker neu starten,',
    'ersten Schreiblauf prüfen, dann den entsprechenden n8n-Workflow deaktivieren.',
  ].join('\n');
  return { subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` };
}

const STREAK_READ_SQL = `
  SELECT state_json FROM automatenlager.workflow_state WHERE tenant_id = $1 AND workflow_key = $2`;
// mandantensicher: seit #111 (0031) ist der PK (tenant_id, workflow_key); DO UPDATE
// trifft genau die eigene Zeile (WHERE bleibt als Defense-in-depth).
const STREAK_UPSERT_SQL = `
  INSERT INTO automatenlager.workflow_state (workflow_key, state_json, updated_at, tenant_id)
  VALUES ($2, $3::jsonb, now(), $1)
  ON CONFLICT (tenant_id, workflow_key) DO UPDATE
    SET state_json = EXCLUDED.state_json, updated_at = now()
    WHERE workflow_state.tenant_id = $1`;

async function readStreak(db, tenant, streakKey) {
  const r = await db.forTenant(tenant).read({ tables: ['workflow_state'], text: STREAK_READ_SQL, params: [streakKey] });
  const row = r.rows[0];
  return (row && row.state_json) || { streak: 0, alerted: false };
}

async function writeStreak(db, tenant, streakKey, state) {
  return db.tx(tenant, async (door) => {
    await door.write({ tables: ['workflow_state'], text: STREAK_UPSERT_SQL, params: [streakKey, JSON.stringify(state)] });
  });
}

/**
 * Eine Pfad-Prüfung: Schatten-Ergebnis bewerten, Serie fortschreiben, ggf. mailen.
 * @param {object} opts.shadowResult  Rückgabe des Schatten-Job-run() ({equal, fetched|processed, salesDiff?})
 */
async function runCutoverCheck(db, tenant, { streakKey, label, shadowResult, threshold = DEFAULT_THRESHOLD, mailer, issues, env = process.env } = {}) {
  const equal = !!(shadowResult && shadowResult.equal);
  // Aktivität: der Schatten hat überhaupt Daten gesehen (sonst vakuös).
  const seen = shadowResult ? (Number(shadowResult.fetched || 0) + Number(shadowResult.processed || 0)) : 0;
  const hadActivity = seen > 0;
  const prev = await readStreak(db, tenant, streakKey);
  const { state, shouldAlert } = updateStreak(prev, { equal, hadActivity }, threshold);

  // Diff-Alarm (dedupliziert per Signatur): bei Abweichung MIT Aktivität feldgenau melden,
  // damit ein dauerhafter Diff nicht still die Konvergenz verhindert.
  const sample = shadowResult && shadowResult.diffSample;
  const sig = (!equal && hadActivity) ? diffSignature(sample) : '';
  const diffIsNew = sig !== '' && sig !== (prev && prev.lastDiffSig);
  const canMail = mailer && typeof mailer.send === 'function';
  const canIssue = issues && typeof issues.createIssue === 'function';
  let diffIssue = (prev && prev.diffIssue) || null;
  let issueAction = null;

  // GitHub-Issue (24/7, ohne Session): bei neuem Diff eröffnen ODER (wenn schon offen)
  // kommentieren; bei Auflösung kommentieren + Marker löschen. Best-effort (Fehler ⇒ kein Crash).
  if (canIssue) {
    try {
      if (diffIsNew && !diffIssue) {
        diffIssue = await issues.createIssue({
          title: `Cutover-Blocker: ${label} — Schatten-Diff zu n8n (auto)`,
          body: buildDiffIssueBody(label, sample), labels: ['enhancement'],
        });
        issueAction = 'created';
      } else if (diffIsNew && diffIssue) {
        await issues.commentIssue(diffIssue, buildDiffIssueBody(label, sample));
        issueAction = 'commented';
      } else if (equal && hadActivity && diffIssue) {
        await issues.commentIssue(diffIssue, `Diff aufgelöst — ${label} wieder deckungsgleich mit n8n; Serie läuft. (auto)`);
        issueAction = 'resolved'; diffIssue = null;
      }
    } catch (err) {
      issueAction = `error:${String((err && err.message) || err)}`;
    }
  }

  const next = { ...state, lastDiffSig: sig || (equal ? '' : (prev && prev.lastDiffSig) || ''), diffIssue };
  await writeStreak(db, tenant, streakKey, next);

  if (shouldAlert && canMail) {
    const mail = buildReadinessMail(label, state.streak, threshold);
    await mailer.send({ to: resolveTenantAlertEmail(env, tenant), subject: mail.subject, text: mail.text, html: mail.html });
  }
  if (diffIsNew && canMail) {
    const mail = buildDiffMail(label, sample);
    await mailer.send({ to: resolveTenantAlertEmail(env, tenant), subject: mail.subject, text: mail.text, html: mail.html });
  }
  return { label, equal, hadActivity, streak: next.streak, alerted: next.alerted, mailedReady: shouldAlert, mailedDiff: diffIsNew, issueAction, diffIssue, diffSample: sample || null };
}

/**
 * Worker-Factory. `checks` = [{ streakKey, label, tenant, job }] — `job.run()` ist
 * der bestehende Schatten-Job (liefert {equal, fetched|processed}). Im Cutover-Modus
 * (job liefert mode='cutover') wird die Serie nicht ausgewertet (nichts zu prüfen).
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createCutoverMonitorJob({ db, env = process.env, mailer, issues, checks = [] } = {}) {
  if (!db) throw new TypeError('cutover-monitor: db (Mandanten-Tür) erforderlich');
  const threshold = Number(env.CUTOVER_STREAK_THRESHOLD) || DEFAULT_THRESHOLD;
  return {
    key: CUTOVER_MONITOR_KEY,
    run: async () => {
      const results = [];
      for (const c of checks) {
        if (!c || !c.job || typeof c.job.run !== 'function' || !c.tenant) continue;
        let shadowResult;
        try { shadowResult = await c.job.run(); } catch (err) { results.push({ label: c.label, error: String(err && err.message || err) }); continue; }
        if (!shadowResult || shadowResult.mode === 'cutover' || shadowResult.skipped || shadowResult.disabled) {
          results.push({ label: c.label, skipped: shadowResult && (shadowResult.skipped || 'not_shadow') });
          continue;
        }
        results.push(await runCutoverCheck(db, c.tenant, { streakKey: c.streakKey, label: c.label, shadowResult, threshold, mailer, issues, env }));
      }
      return { checks: results.length, results };
    },
  };
}

module.exports = {
  CUTOVER_MONITOR_KEY,
  DEFAULT_THRESHOLD,
  updateStreak,
  buildReadinessMail,
  readStreak,
  writeStreak,
  runCutoverCheck,
  createCutoverMonitorJob,
};
