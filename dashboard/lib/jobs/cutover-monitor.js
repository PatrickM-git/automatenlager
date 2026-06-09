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
// mandantensicher (globale PK workflow_key, #111): DO UPDATE nur für die eigene Zeile.
const STREAK_UPSERT_SQL = `
  INSERT INTO automatenlager.workflow_state (workflow_key, state_json, updated_at, tenant_id)
  VALUES ($2, $3::jsonb, now(), $1)
  ON CONFLICT (workflow_key) DO UPDATE
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
async function runCutoverCheck(db, tenant, { streakKey, label, shadowResult, threshold = DEFAULT_THRESHOLD, mailer, env = process.env } = {}) {
  const equal = !!(shadowResult && shadowResult.equal);
  // Aktivität: der Schatten hat überhaupt Daten gesehen (sonst vakuös).
  const seen = shadowResult ? (Number(shadowResult.fetched || 0) + Number(shadowResult.processed || 0)) : 0;
  const hadActivity = seen > 0;
  const prev = await readStreak(db, tenant, streakKey);
  const { state, shouldAlert } = updateStreak(prev, { equal, hadActivity }, threshold);
  await writeStreak(db, tenant, streakKey, state);
  if (shouldAlert && mailer && typeof mailer.send === 'function') {
    const mail = buildReadinessMail(label, state.streak, threshold);
    await mailer.send({ to: resolveTenantAlertEmail(env, tenant), subject: mail.subject, text: mail.text, html: mail.html });
  }
  return { label, equal, hadActivity, streak: state.streak, alerted: state.alerted, mailed: shouldAlert };
}

/**
 * Worker-Factory. `checks` = [{ streakKey, label, tenant, job }] — `job.run()` ist
 * der bestehende Schatten-Job (liefert {equal, fetched|processed}). Im Cutover-Modus
 * (job liefert mode='cutover') wird die Serie nicht ausgewertet (nichts zu prüfen).
 * @returns {{key:string, run:()=>Promise<any>}}
 */
function createCutoverMonitorJob({ db, env = process.env, mailer, checks = [] } = {}) {
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
        results.push(await runCutoverCheck(db, c.tenant, { streakKey: c.streakKey, label: c.label, shadowResult, threshold, mailer, env }));
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
