'use strict';

/**
 * Harter Timeout für externe HTTP-Calls (Audit 2026-06-10).
 *
 * Ohne `signal` hängt ein fetch bis zu den undici-Defaults (~300 s Header/Body)
 * und blockiert so lange einen Worker-Job-Slot. `withTimeout(init, ms)` ergänzt
 * ein frisches `AbortSignal.timeout` (Node >= 17.3); ein vom Aufrufer gesetztes
 * signal hat Vorrang und bleibt unangetastet. Der Timeout-Abbruch wirft im
 * Aufrufer (TimeoutError) und landet damit als normaler Job-Fehler in der
 * Telemetrie (recordRun) — der Worker selbst überlebt (tick fängt ab).
 *
 * Prozessweiter Override: EXTERNAL_FETCH_TIMEOUT_MS (gilt dann für ALLE Clients,
 * auch dort, wo ein Aufrufer einen abweichenden Fallback mitgibt).
 */

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveTimeoutMs(fallbackMs = DEFAULT_TIMEOUT_MS, env = process.env) {
  const raw = Number(env && env.EXTERNAL_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

function withTimeout(init = {}, ms = resolveTimeoutMs()) {
  if (init && init.signal) return init;
  return { ...init, signal: AbortSignal.timeout(ms) };
}

module.exports = { withTimeout, resolveTimeoutMs, DEFAULT_TIMEOUT_MS };
