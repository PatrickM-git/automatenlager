'use strict';

/**
 * Auflösung der PostgreSQL-Verbindungs-URL für Dashboard v2/v3.
 *
 * Regel:
 *  - Ist EINER der PG-Schlüssel in der Prozess-Umgebung GESETZT (auch leer),
 *    hat die Prozess-Umgebung Vorrang — es gibt KEINEN .env.local-Fallback.
 *    (So bleibt ein explizit gesetztes `DASHBOARD_V2_PG_URL=''` „unkonfiguriert",
 *    worauf sich die Server-Tests verlassen.)
 *  - Fehlt der Schlüssel in der Prozess-Umgebung komplett, wird auf die
 *    lokalen .env.local-Werte zurückgegriffen — wie bei der n8n-Konfiguration.
 *
 * Erkennt die Aliase POSTGRES_URL und DATABASE_URL. Reine Funktion, damit die
 * Priorität ohne Datei-/Server-Abhängigkeit testbar ist.
 */

const PG_KEYS = ['DASHBOARD_V2_PG_URL', 'POSTGRES_URL', 'DATABASE_URL'];

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function pick(src) {
  return src.DASHBOARD_V2_PG_URL || src.POSTGRES_URL || src.DATABASE_URL || '';
}

function resolvePgUrl(processEnv, localEnv) {
  const pe = processEnv || {};
  const hasProcessKey = PG_KEYS.some((k) => Object.prototype.hasOwnProperty.call(pe, k));
  if (hasProcessKey) {
    return clean(pick(pe));
  }
  return clean(pick(localEnv || {}));
}

module.exports = { resolvePgUrl };
