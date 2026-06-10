'use strict';

/**
 * Minimaler Anthropic-Messages-Client (Systemgrenze) — Issue #162 (Stufe 6 Slice 2).
 * Ersetzt die n8n-httpRequest-Knoten (WF9-OCR, WF-Claude-Proposals; künftig WF1).
 * Key aus `.env.local` (`ANTHROPIC_API_KEY`). In Tests wird `createMessage` gefaked,
 * d. h. die echte HTTP-Grenze wird nie im Unit-Test berührt.
 */

const { withTimeout, resolveTimeoutMs } = require('./fetch-timeout.js');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// OCR/Proposals mit großen PDFs brauchen länger als der 30s-Default.
const ANTHROPIC_TIMEOUT_MS = 120_000;

/**
 * @param {{apiKey:string, fetchImpl?:Function, url?:string}} opts
 * @returns {(body:object)=>Promise<object>} createMessage — POST /v1/messages, gibt das geparste JSON zurück
 */
function createAnthropicClient({ apiKey, fetchImpl, url = ANTHROPIC_URL } = {}) {
  if (!apiKey) throw new Error('anthropic-client: apiKey erforderlich');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('anthropic-client: fetch nicht verfügbar');
  return async function createMessage(body) {
    const resp = await doFetch(url, withTimeout({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    }, resolveTimeoutMs(ANTHROPIC_TIMEOUT_MS)));
    const text = await resp.text();
    if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
}

/**
 * Provider-Verkabelung aus der Umgebung. `disabled`, wenn kein Key — Jobs laufen
 * weiter, rufen Claude aber nicht (kein fehlender Key bricht den Worker).
 * @returns {{kind:'live'|'disabled', createMessage:Function|null}}
 */
function buildAnthropicFromEnv(env = process.env, { fetchImpl } = {}) {
  const apiKey = String((env && env.ANTHROPIC_API_KEY) || '').trim();
  if (!apiKey) return { kind: 'disabled', createMessage: null };
  return { kind: 'live', createMessage: createAnthropicClient({ apiKey, fetchImpl }) };
}

module.exports = { createAnthropicClient, buildAnthropicFromEnv, ANTHROPIC_URL, ANTHROPIC_VERSION };
