'use strict';

/**
 * GitHub-Issues-Client (#198): bei einem Schatten-Diff ein Issue eröffnen/kommentieren,
 * damit der Fix im Backlog auftaucht (start-issue greift ihn auf) — 24/7 ohne Session.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const gh = require('../lib/jobs/github-issues.js');

test('#198 createGithubIssueClient: ohne Token/Repo ⇒ null (deaktiviert)', () => {
  assert.equal(gh.createGithubIssueClient({ fetchImpl: async () => ({}) }), null);
  assert.equal(gh.buildGithubIssuesFromEnv({}, { fetchImpl: async () => ({}) }), null);
});

test('#198 createIssue: POST /repos/{repo}/issues mit Bearer-Auth, gibt Nummer zurück', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ number: 207 }) }; };
  const client = gh.createGithubIssueClient({ token: 'TOK', repo: 'me/repo', fetchImpl: fakeFetch });
  const n = await client.createIssue({ title: 'T', body: 'B', labels: ['enhancement'] });
  assert.equal(n, 207);
  assert.match(calls[0].url, /\/repos\/me\/repo\/issues$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer TOK');
  assert.deepEqual(JSON.parse(calls[0].opts.body).labels, ['enhancement']);
});

test('#198 commentIssue: POST .../issues/{n}/comments; HTTP-Fehler wirft', async () => {
  const client = gh.createGithubIssueClient({ token: 'T', repo: 'me/repo', fetchImpl: async (url) => ({ ok: /comments$/.test(url), status: 422, json: async () => ({}) }) });
  assert.equal(await client.commentIssue(5, 'hi'), true);
  const bad = gh.createGithubIssueClient({ token: 'T', repo: 'me/repo', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await assert.rejects(() => bad.createIssue({ title: 'x', body: 'y' }), /HTTP 500/);
});
