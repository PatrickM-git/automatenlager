'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Schreib-Pfad-Eingangswächter (Issue #131, Stufe 4 — Slice 0 „Fundament").
// SPEC: docs/specs/multi-tenant-write-isolation-stufe-4-v1.md §"Mandant-Herkunft"
//
// Mandant-Herkunft = Privilege-Escalation-Verteidigung: Der Mandant einer
// Schreibung wird NIE aus dem Request-Body, sondern IMMER aus dem Viewer
// (viewer.tenantId) bestimmt. Ein Client hat NIE einen legitimen Grund, den
// Mandanten zu schicken — jedes Vorkommen ist Bug oder Angriff und wird hart
// abgelehnt (400 Bad Request) und auditiert.
//
// Reines, DB-freies Modul: KEIN rohes pg (der #107-Wächter findet es nicht).
// In Slice 0 nur gebaut + unit-getestet; die Verkabelung an die schreibenden
// Endpunkte erfolgt in den Slice-2/3-Issues (#133–#138).
// ─────────────────────────────────────────────────────────────────────────────

// Verbotene Mandanten-Felder im Body (beide Schreibweisen — historisch mandant_id,
// kanonisch tenant_id). Erstes Vorkommen genügt, um abzulehnen.
const TENANT_BODY_FIELDS = Object.freeze(['tenant_id', 'mandant_id']);

/**
 * Strukturelle Erkennung: trägt der Body ein Mandanten-Feld?
 * @param {any} body  geparster Request-Body
 * @returns {string|null}  Name des verletzenden Feldes oder null (sauber)
 */
function detectBodyTenant(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const field of TENANT_BODY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return field;
  }
  return null;
}

/**
 * Endpunkt-Helper: lehnt einen Body mit tenant_id/mandant_id mit 400 + Audit ab.
 * Sauberer Body ⇒ durchlässig (false). Die HTTP-/Audit-Senken werden injiziert,
 * damit der Helper ohne Server/DB unit-testbar ist (Systemgrenzen außen).
 *
 * @param {any} body
 * @param {object} sinks
 * @param {object} sinks.res                 HTTP-Response (an sendJson weitergereicht)
 * @param {object} [sinks.viewer]            aktueller Viewer (fürs Audit)
 * @param {(res:object,status:number,payload:object)=>void} sinks.sendJson
 * @param {(viewer:object,event:string,details:object)=>void} [sinks.audit]
 * @returns {boolean}  true = abgelehnt (Antwort gesendet); false = sauber (weiter)
 */
function rejectBodyTenant(body, { res, viewer, sendJson, audit } = {}) {
  const field = detectBodyTenant(body);
  if (!field) return false; // sauber ⇒ durchlässig
  if (typeof audit === 'function') {
    audit(viewer, 'body_tenant_rejected', { field });
  }
  if (res && typeof sendJson === 'function') {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: 'TENANT_IN_BODY',
        message: 'Mandant darf nicht im Request-Body übergeben werden.',
      },
    });
  }
  return true; // abgelehnt
}

module.exports = { TENANT_BODY_FIELDS, detectBodyTenant, rejectBodyTenant };
