'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sentry-lite — Issue #217 (Cloud-Slice 3, zentrales Error-Tracking).
//
// Minimaler Sentry-Store-API-Client OHNE npm-Dependency (gleiche Philosophie
// wie der Resend-Mailer: HTTPS über das globale fetch, injizierbar, deploybar
// ohne npm install). Erfasst unbehandelte Fehler aus Backend und Jobs zentral.
//
// Verhaltensgarantien:
//  - Ohne SENTRY_DSN: enabled=false, alles ist ein No-op (Dev/Mini unverändert).
//  - captureException WIRFT NIE (Error-Tracking darf nie selbst der Fehler sein)
//    und hat einen harten Timeout (fetch-timeout-Muster).
//  - installProcessHandlers: uncaughtException/unhandledRejection werden
//    gemeldet; das bestehende Crash-/Log-Verhalten bleibt unangetastet
//    (wir loggen und melden, wir verschlucken nicht).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto');

const SENTRY_CLIENT = 'faltrix-sentry-lite/1.0';

// DSN: https://<publicKey>@<host>/<projectId>
function parseDsn(dsn) {
  const raw = String(dsn == null ? '' : dsn).trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const publicKey = u.username;
  const projectId = u.pathname.replace(/^\/+/, '');
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  return {
    publicKey,
    projectId,
    storeUrl: `${u.protocol}//${u.host}/api/${projectId}/store/`,
  };
}

function stackFrames(err) {
  const stack = err && typeof err.stack === 'string' ? err.stack : '';
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!m) continue;
    frames.push({ function: m[1] || '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return frames.reverse(); // Sentry erwartet äußerste zuerst
}

/**
 * @param {object} opts { dsn, environment, release, fetchImpl, logger, timeoutMs }
 * @returns {{enabled:boolean, captureException:Function, installProcessHandlers:Function}}
 */
function createSentry({ dsn, environment, release, fetchImpl, logger, timeoutMs = 10_000 } = {}) {
  const cfg = parseDsn(dsn);
  const log = typeof logger === 'function' ? logger : (...a) => console.warn('[sentry-lite]', ...a);
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);

  if (!cfg || !doFetch) {
    return { enabled: false, captureException: async () => {}, installProcessHandlers: () => {} };
  }

  async function captureException(err, extra = {}) {
    try {
      const e = err instanceof Error ? err : new Error(String(err));
      const event = {
        event_id: crypto.randomUUID().replace(/-/g, ''),
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: 'error',
        environment: environment || (process.env.RENDER ? 'render' : 'local'),
        release: release || undefined,
        server_name: process.env.RENDER_SERVICE_NAME || undefined,
        exception: {
          values: [{
            type: e.name || 'Error',
            value: String(e.message || e),
            stacktrace: { frames: stackFrames(e) },
          }],
        },
        extra,
      };
      await doFetch(cfg.storeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': SENTRY_CLIENT,
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=${SENTRY_CLIENT}, sentry_key=${cfg.publicKey}`,
        },
        body: JSON.stringify(event),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (sendErr) {
      // NIE werfen — nur leise loggen (Error-Tracking darf nie selbst krachen).
      log('Versand fehlgeschlagen:', sendErr && sendErr.message);
    }
  }

  function installProcessHandlers(proc = process) {
    proc.on('uncaughtException', (err) => {
      log('uncaughtException:', err && err.message);
      captureException(err, { handler: 'uncaughtException' });
    });
    proc.on('unhandledRejection', (reason) => {
      log('unhandledRejection:', reason && (reason.message || reason));
      captureException(reason, { handler: 'unhandledRejection' });
    });
  }

  return { enabled: true, captureException, installProcessHandlers };
}

// Prozessweiter Singleton (lazy; DSN aus der Umgebung). server.js/worker.js
// holen sich dieselbe Instanz — eine Konfiguration, ein Verhalten.
let singleton = null;
function getSentry(env = process.env) {
  if (!singleton) {
    singleton = createSentry({ dsn: env.SENTRY_DSN, environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV });
  }
  return singleton;
}

module.exports = { parseDsn, createSentry, getSentry };
