'use strict';

/**
 * Fetch-Timeout-Helper (Audit 2026-06-10): externe HTTP-Calls bekommen ein
 * AbortSignal.timeout, damit ein hängender Dienst keinen Worker-Job-Slot bis zu
 * den undici-Defaults (~300 s) blockiert. Aufrufer-Signal hat Vorrang;
 * EXTERNAL_FETCH_TIMEOUT_MS ist der prozessweite Override.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { withTimeout, resolveTimeoutMs, DEFAULT_TIMEOUT_MS } = require('../lib/fetch-timeout.js');
const { createAnthropicClient } = require('../lib/anthropic-client.js');
const { createGithubIssueClient } = require('../lib/jobs/github-issues.js');

test('withTimeout: ergänzt ein AbortSignal, wenn keines gesetzt ist', () => {
  const init = withTimeout({ method: 'GET' });
  assert.equal(init.method, 'GET');
  assert.ok(init.signal instanceof AbortSignal, 'signal ist ein AbortSignal');
});

test('withTimeout: Aufrufer-Signal hat Vorrang (wird nicht überschrieben)', () => {
  const own = new AbortController().signal;
  const init = withTimeout({ signal: own });
  assert.equal(init.signal, own, 'vorhandenes signal bleibt unangetastet');
});

test('resolveTimeoutMs: Fallback gilt, EXTERNAL_FETCH_TIMEOUT_MS überschreibt, Müll wird ignoriert', () => {
  assert.equal(resolveTimeoutMs(undefined, {}), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(120_000, {}), 120_000);
  assert.equal(resolveTimeoutMs(120_000, { EXTERNAL_FETCH_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(resolveTimeoutMs(120_000, { EXTERNAL_FETCH_TIMEOUT_MS: 'quatsch' }), 120_000);
  assert.equal(resolveTimeoutMs(120_000, { EXTERNAL_FETCH_TIMEOUT_MS: '-1' }), 120_000);
});

test('anthropic-client: fetch bekommt ein Timeout-Signal mit', async () => {
  let seen = null;
  const fetchImpl = async (_url, init) => {
    seen = init;
    return { ok: true, text: async () => '{"id":"msg_1"}' };
  };
  const createMessage = createAnthropicClient({ apiKey: 'k', fetchImpl });
  await createMessage({ model: 'claude-fable-5' });
  assert.ok(seen && seen.signal instanceof AbortSignal, 'signal wird an fetch durchgereicht');
});

test('github-issues: fetch bekommt ein Timeout-Signal mit', async () => {
  let seen = null;
  const fetchImpl = async (_url, init) => {
    seen = init;
    return { ok: true, json: async () => ({ number: 1 }) };
  };
  const client = createGithubIssueClient({ token: 't', repo: 'o/r', fetchImpl });
  await client.createIssue({ title: 'x', body: 'y' });
  assert.ok(seen && seen.signal instanceof AbortSignal, 'signal wird an fetch durchgereicht');
});
