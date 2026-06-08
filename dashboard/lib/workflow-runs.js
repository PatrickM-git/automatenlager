'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// audit.workflow_runs-Schreiber (Lauf-Telemetrie) — Issue #160 (Stufe 6, Slice 0).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Job-Lauf-Telemetrie"
//
// Ersetzt n8ns interne `execution_entity`: der Worker protokolliert je Lauf
// Start/Ende/Status/Fehler (`workflow_key` = Job-Name). Monitoring/Konsistenz-
// Checks (alert-digest, overview-monitoring) lesen `audit.workflow_runs` bereits —
// dieses Modul ist der SCHREIBER.
//
// `audit.workflow_runs` ist SYSTEM-Telemetrie OHNE tenant_id (geteilte Pipeline,
// SPEC). Sie läuft daher über die INFRA-Verbindung (injizierter `exec`), NICHT
// durch die Mandanten-Tür — es gibt keinen Mandanten zu setzen. Genau deshalb
// trägt dieses Modul kein rohes pg (injizierter `exec`) und ist für den
// #107-Wächter sauber.
//
// Telemetrie ist NEBENSACHE: ein Schreibfehler an der Telemetrie darf NIE den Job
// verhindern (Lieferung > Protokoll). Der Job-Fehler selbst propagiert dagegen
// immer (nie verschluckt) — sonst wäre der Lauf fälschlich „erfolgreich".
// ─────────────────────────────────────────────────────────────────────────────

const RUNNING = 'running';
const SUCCESS = 'success';
const ERROR = 'error';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {object} opts
 * @param {(sql:string, params:any[]) => Promise<{rows:any[], rowCount?:number}>} opts.exec
 *        Injizierter DB-Executor (INFRA-Verbindung). Keine Mandanten-Tür (kein tenant_id).
 * @param {() => Date} [opts.now]      Uhr (injizierbar für Tests).
 * @param {(...a:any[]) => void} [opts.logger]  Logger für best-effort-Telemetriefehler.
 * @param {string} [opts.source]       Lauf-Quelle (Default 'worker'); z. B. 'worker'|'cli'|'web'.
 */
function createWorkflowRunRecorder({ exec, now, logger, source = 'worker' } = {}) {
  if (typeof exec !== 'function') {
    throw new TypeError('workflow-runs: exec-Funktion (INFRA-Executor) erforderlich');
  }
  const clock = typeof now === 'function' ? now : () => new Date();
  const log = typeof logger === 'function' ? logger : () => {};

  function assertKey(workflowKey) {
    if (!isNonEmptyString(workflowKey)) {
      throw new Error('workflow-runs: workflow_key (Job-Name) ist Pflicht — kein anonymer Lauf');
    }
  }

  // Start-Zeile (status=running) anlegen, run_id zurückgeben. Best-effort: schlägt
  // das Telemetrie-INSERT fehl, liefert es null (der Job läuft trotzdem weiter).
  async function insertStart(workflowKey, startedAt) {
    try {
      const res = await exec(
        `INSERT INTO audit.workflow_runs (workflow_key, status, started_at, source)
         VALUES ($1, $2, $3, $4) RETURNING run_id`,
        [workflowKey, RUNNING, startedAt, source],
      );
      return (res && res.rows && res.rows[0] && res.rows[0].run_id != null) ? res.rows[0].run_id : null;
    } catch (err) {
      log('workflow-runs: Telemetrie-Start fehlgeschlagen (best-effort, Job läuft weiter):', err && err.message);
      return null;
    }
  }

  // Lauf abschließen. Wenn die Start-Zeile existiert (runId): UPDATE; sonst eine
  // vollständige Zeile nachschreiben. Best-effort (Fehler werden geloggt, nie geworfen).
  async function finish(runId, fields) {
    try {
      if (runId != null) {
        await exec(
          `UPDATE audit.workflow_runs SET status = $2, finished_at = $3, error = $4 WHERE run_id = $1`,
          [runId, fields.status, fields.finishedAt, fields.error],
        );
      } else {
        await writeRun(fields);
      }
    } catch (err) {
      log('workflow-runs: Telemetrie-Ende fehlgeschlagen (best-effort):', err && err.message);
    }
  }

  /**
   * Umschließt einen Job-Lauf mit Telemetrie: Start schreiben → Job ausführen →
   * Ende (success/error) schreiben. Gibt das Job-Ergebnis zurück; ein Job-Fehler
   * wird protokolliert UND weitergeworfen.
   */
  async function recordRun(workflowKey, fn, meta = {}) {
    assertKey(workflowKey);
    if (typeof fn !== 'function') throw new TypeError('workflow-runs: recordRun(workflowKey, fn) verlangt fn');
    const startedAt = clock();
    const runId = await insertStart(workflowKey, startedAt);

    let result;
    let jobErr = null;
    try {
      result = await fn();
    } catch (err) {
      jobErr = err;
    }
    const finishedAt = clock();
    await finish(runId, {
      workflowKey,
      status: jobErr ? ERROR : SUCCESS,
      startedAt,
      finishedAt,
      error: jobErr ? String((jobErr && jobErr.message) || jobErr) : null,
      details: meta && meta.details != null ? meta.details : null,
    });

    if (jobErr) throw jobErr;
    return result;
  }

  /** Vollständige Lauf-Zeile direkt schreiben (z. B. abgeschlossene/externe Läufe). */
  async function writeRun({ workflowKey, status, startedAt, finishedAt = null, error = null, details = null } = {}) {
    assertKey(workflowKey);
    return exec(
      `INSERT INTO audit.workflow_runs (workflow_key, status, started_at, finished_at, error, source, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [workflowKey, status || SUCCESS, startedAt || clock(), finishedAt, error,
       source, details == null ? null : JSON.stringify(details)],
    );
  }

  return { recordRun, writeRun, RUNNING, SUCCESS, ERROR };
}

module.exports = { createWorkflowRunRecorder };
