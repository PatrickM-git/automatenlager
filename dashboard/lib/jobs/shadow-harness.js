'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Schatten-/Vergleichs-Harness — Issue #160 (Stufe 6, Slice 0).
// SPEC: docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md §"Testing Decisions"
//
// ZWECK: datenkritische Jobs (WF3 Nayax-Verkäufe, WF1/WF2 Rechnungseingang —
// Slice 3) VOR dem Cutover beweisbar machen. Der portierte Job rechnet seine
// BEABSICHTIGTEN Writes (compute-only, schreibt NICHT) und dieser Harness
// vergleicht sie gegen den n8n-Ist-Stand. Erst bei Deckungsgleichheit Cutover.
//
// EISERN: Der Harness hat KEINE Schreibfähigkeit. Er bekommt nur `computeIntended`
// (rechnet) und `readActual` (liest) — niemals einen Schreibpfad. Doppel-Schreiben
// im Schatten ist damit strukturell unmöglich.
//
// Reine Funktionen, kein pg, kein I/O an der Tür vorbei (geht durch injizierte
// Reader). Der #107-Wächter scannt dieses Modul mit (lib/jobs/*) — es trägt
// bewusst kein rohes pg.
// ─────────────────────────────────────────────────────────────────────────────

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// Indexiert eine Menge nach ihrem Identitäts-Schlüssel. Doppelte Schlüssel: der
// letzte gewinnt (deterministisch); ein Job sollte je Schlüssel eine Zeile liefern.
function indexByKey(rows, keyOf) {
  const map = new Map();
  for (const row of rows) map.set(String(keyOf(row)), row);
  return map;
}

/**
 * Vergleicht zwei Write-Mengen (beabsichtigt vs. tatsächlich) strukturell.
 *
 * @param {object[]} intended  beabsichtigte Writes (vom Job berechnet, NICHT geschrieben)
 * @param {object[]} actual    Ist-Stand (n8ns tatsächliche Writes, gelesen)
 * @param {object} opts
 * @param {(row:object)=>string} opts.keyOf   Identitäts-Schlüssel je Zeile
 * @param {string[]} [opts.fields]            zu vergleichende Felder (Default: keine ⇒ nur Existenz)
 * @returns {{equal:boolean, onlyIntended:object[], onlyActual:object[],
 *            mismatched:{key:string,intended:object,actual:object,diffFields:string[]}[],
 *            intendedCount:number, actualCount:number}}
 */
function diffWrites(intended, actual, { keyOf, fields = [] } = {}) {
  if (typeof keyOf !== 'function') {
    throw new TypeError('shadow-harness: diffWrites verlangt opts.keyOf (Identitäts-Schlüssel)');
  }
  const intendedRows = asArray(intended);
  const actualRows = asArray(actual);
  const iIdx = indexByKey(intendedRows, keyOf);
  const aIdx = indexByKey(actualRows, keyOf);

  const onlyIntended = [];
  const onlyActual = [];
  const mismatched = [];

  for (const [key, iRow] of iIdx) {
    if (!aIdx.has(key)) { onlyIntended.push(iRow); continue; }
    const aRow = aIdx.get(key);
    const diffFields = fields.filter((f) => !Object.is(iRow[f], aRow[f]));
    if (diffFields.length) mismatched.push({ key, intended: iRow, actual: aRow, diffFields });
  }
  for (const [key, aRow] of aIdx) {
    if (!iIdx.has(key)) onlyActual.push(aRow);
  }

  return {
    equal: onlyIntended.length === 0 && onlyActual.length === 0 && mismatched.length === 0,
    onlyIntended,
    onlyActual,
    mismatched,
    intendedCount: intendedRows.length,
    actualCount: actualRows.length,
  };
}

/**
 * Orchestriert einen Schattenlauf: rechnen → lesen → vergleichen. SCHREIBT NIE.
 * Fehler aus computeIntended/readActual propagieren (nie still als „gleich" maskiert).
 *
 * @param {object} opts
 * @param {string} opts.workflowKey            Job-Name (für Telemetrie/Report)
 * @param {()=>Promise<object[]>} opts.computeIntended  rechnet beabsichtigte Writes
 * @param {()=>Promise<object[]>} opts.readActual       liest n8n-Ist-Stand
 * @param {(row:object)=>string} opts.keyOf
 * @param {string[]} [opts.fields]
 * @returns {Promise<{workflowKey:string, diff:object, intended:object[], actual:object[]}>}
 */
async function runShadowComparison({ workflowKey, computeIntended, readActual, keyOf, fields = [] } = {}) {
  if (typeof computeIntended !== 'function') {
    throw new TypeError('shadow-harness: computeIntended (rechnet, schreibt nicht) erforderlich');
  }
  if (typeof readActual !== 'function') {
    throw new TypeError('shadow-harness: readActual (liest Ist-Stand) erforderlich');
  }
  const intended = asArray(await computeIntended());
  const actual = asArray(await readActual());
  return {
    workflowKey: workflowKey || null,
    diff: diffWrites(intended, actual, { keyOf, fields }),
    intended,
    actual,
  };
}

module.exports = { diffWrites, runShadowComparison };
