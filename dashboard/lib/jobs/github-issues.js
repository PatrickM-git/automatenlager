'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Minimaler GitHub-Issues-Client (REST) — für den Cutover-Wächter (#198).
//
// Bei einem NEUEN Schatten-Diff (Port WF3/WF1 ≠ n8n) eröffnet/aktualisiert der
// Worker ein Issue, damit der Fix im Backlog auftaucht und `start-issue` ihn
// aufgreift — 24/7, OHNE laufende Claude-Session. Das ist der dauerhafte Ersatz
// für einen unbeaufsichtigten Code-Fixer (den es mit dem vorhandenen Tooling
// nicht gibt).
//
// Kein pg (#107-rein, reiner HTTP-Pfad); fetch + token injizierbar/aus Env.
// Ohne Token/Repo ⇒ null (Feature deaktiviert, bricht nichts).
// ─────────────────────────────────────────────────────────────────────────────

const { withTimeout } = require('../fetch-timeout.js');

const GITHUB_API = 'https://api.github.com';

/**
 * @param {object} opts
 * @param {string} opts.token   GitHub-Token (Issues: write). Aus env (GITHUB_TOKEN).
 * @param {string} opts.repo    "owner/name".
 * @param {Function} [opts.fetchImpl]
 * @returns {{createIssue:Function, commentIssue:Function}|null}  null ⇒ deaktiviert.
 */
function createGithubIssueClient({ token, repo, fetchImpl, apiBase = GITHUB_API } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (!token || !repo || !doFetch) return null;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'automatenlager-worker',
  };
  async function createIssue({ title, body, labels = [] } = {}) {
    const res = await doFetch(`${apiBase}/repos/${repo}/issues`, withTimeout({
      method: 'POST', headers, body: JSON.stringify({ title, body, labels }),
    }));
    if (!res || !res.ok) throw new Error(`github-issues: create HTTP ${res && res.status}`);
    const data = await res.json();
    return data && data.number;
  }
  async function commentIssue(number, body) {
    const res = await doFetch(`${apiBase}/repos/${repo}/issues/${number}/comments`, withTimeout({
      method: 'POST', headers, body: JSON.stringify({ body }),
    }));
    if (!res || !res.ok) throw new Error(`github-issues: comment HTTP ${res && res.status}`);
    return true;
  }
  return { createIssue, commentIssue };
}

/** Issues-Client aus der Env bauen (GITHUB_TOKEN + GITHUB_REPO). null ⇒ deaktiviert. */
function buildGithubIssuesFromEnv(env = process.env, { fetchImpl } = {}) {
  return createGithubIssueClient({
    token: env.GITHUB_TOKEN || env.GH_TOKEN,
    repo: env.GITHUB_REPO,
    fetchImpl,
  });
}

module.exports = { createGithubIssueClient, buildGithubIssuesFromEnv, GITHUB_API };
