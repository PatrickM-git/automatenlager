'use strict';

/**
 * WF-Claude-Proposals — In-Process-Port (Issue #162, Stufe 6 Slice 2).
 * Schedule-Job (n8n: cron 0 30 4 → täglich 04:30): pending product_change_proposals
 * (älter als 14 Tage) von Claude vorentscheiden → Status durch die Tür aktualisieren →
 * Eskalationen per Mailer melden. Verhaltensgetreu aus der authoritativen Mini-Definition.
 *
 * Ebene (1) reine Logik: buildProposalsPrompt, parseDecisions.
 * Ebene (2) Live durch die Tür: applyProposalDecisions (acme/globex nicht-vakuös).
 * Ebene (3) Orchestrierung: runClaudeProposalsForTenant mit Fake-Anthropic/-Mailer.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const cp = require('../lib/jobs/claude-proposals.js');
const { inSandbox, applyMigration } = require('./helpers/migration-sandbox.js');
const { createTenantDb } = require('../lib/tenant-db.js');
const { seedAcmeGlobex, sandboxTxPool } = require('./helpers/tenant-fixtures.js');

const NOW = '2026-06-09T10:00:00.000Z';

const PROPOSALS = [
  { proposal_key: 'p1', product_key: 'kitkat', product_name: 'KitKat', product_active: true, category: 'snack', reason: 'Preis geaendert', days_pending: 20 },
  { proposal_key: 'p2', product_key: 'mystery', product_name: null, product_active: false, category: null, reason: 'unklar', days_pending: 30 },
];

// ── Ebene 1: buildProposalsPrompt ────────────────────────────────────────────
test('#162 buildProposalsPrompt: Modell claude-haiku, inputKeys + Proposal-Infos im Prompt', () => {
  const { request_body, inputKeys } = cp.buildProposalsPrompt(PROPOSALS);
  assert.equal(request_body.model, 'claude-haiku-4-5-20251001');
  assert.equal(request_body.max_tokens, 1024);
  assert.ok(request_body.system.includes('approve'), 'System-Prompt nennt die Regeln');
  assert.deepEqual(inputKeys, ['p1', 'p2']);
  const content = request_body.messages[0].content;
  assert.match(content, /p1/);
  assert.match(content, /KitKat/);
  assert.match(content, /PRODUKT NICHT IM KATALOG/); // p2 ohne product_name
});

// ── Ebene 1: parseDecisions ──────────────────────────────────────────────────
test('#162 parseDecisions: splittet approve/reject/escalate, nur DB-Keys vertraut', () => {
  const resp = { content: [{ text: '{"decisions":[{"proposal_key":"p1","action":"approve","reason":"ok"},{"proposal_key":"p2","action":"escalate","reason":"neu"},{"proposal_key":"GEFAELSCHT","action":"approve","reason":"hack"}]}' }] };
  const out = cp.parseDecisions(resp, ['p1', 'p2']);
  assert.equal(out.approvals.length, 1);
  assert.equal(out.approvals[0].proposal_key, 'p1');
  assert.equal(out.escalations.length, 1);
  assert.equal(out.safeDecisions.length, 2, 'GEFAELSCHT (nicht aus DB) verworfen');
});

test('#162 parseDecisions: kaputte/leere Claude-Antwort ⇒ keine Entscheidungen (kein Wurf)', () => {
  assert.deepEqual(cp.parseDecisions({ content: [{ text: 'kein json' }] }, ['p1']).safeDecisions, []);
  assert.deepEqual(cp.parseDecisions({}, ['p1']).safeDecisions, []);
  assert.deepEqual(cp.parseDecisions(null, ['p1']).safeDecisions, []);
});

// ── Ebene 3: Orchestrierung mit Fakes ────────────────────────────────────────
test('#162 runClaudeProposalsForTenant: keine Proposals ⇒ kein Claude-Aufruf, kein Mail', async () => {
  let claudeCalled = false; let mailed = false;
  const db = { read: async () => ({ rows: [], rowCount: 0 }), tx: async () => { throw new Error('tx unerwartet'); } };
  const anthropic = { createMessage: async () => { claudeCalled = true; return {}; } };
  const mailer = { send: async () => { mailed = true; } };
  const res = await cp.runClaudeProposalsForTenant(db, 'acme', { anthropic, mailer, nowIso: NOW });
  assert.equal(res.considered, 0);
  assert.equal(claudeCalled, false);
  assert.equal(mailed, false);
});

test('#162 runClaudeProposalsForTenant: Eskalation ⇒ Mailer wird mit Empfänger gerufen', async () => {
  let mailArg = null;
  const db = {
    read: async () => ({ rows: PROPOSALS, rowCount: PROPOSALS.length }),
    tx: async (_t, fn) => fn({ write: async () => ({ rowCount: 1 }) }),
  };
  const anthropic = { createMessage: async () => ({ content: [{ text: '{"decisions":[{"proposal_key":"p1","action":"approve","reason":"ok"},{"proposal_key":"p2","action":"escalate","reason":"neues Produkt"}]}' }] }) };
  const mailer = { send: async (a) => { mailArg = a; } };
  const res = await cp.runClaudeProposalsForTenant(db, 'acme', { anthropic, mailer, env: { ALERT_EMAIL_DEFAULT: 'ops@example.test' }, nowIso: NOW });
  assert.equal(res.considered, 2);
  assert.equal(res.approved, 1);
  assert.equal(res.escalated, 1);
  assert.ok(mailArg, 'Mailer gerufen');
  assert.equal(mailArg.to, 'ops@example.test');
  assert.match(mailArg.subject, /Eskalation|Proposal/i);
});

// ── Ebene 2: Live durch die Tür ──────────────────────────────────────────────
test('#162 applyProposalDecisions LIVE: approve/reject durch die Tür; globex isoliert', async (t) => {
  await inSandbox(t, async (client) => {
    const { acme, globex } = await seedAcmeGlobex(client);
    for (const ten of [acme, globex]) {
      for (const key of ['pa', 'pr']) {
        await client.query(
          `INSERT INTO automatenlager.product_change_proposals
             (proposal_key, product_id, proposal_type, reason, status, payload, created_at, tenant_id)
           VALUES ($1, $2, 'price_change', 'Grund', 'pending', '{}'::jsonb, NOW() - INTERVAL '20 days', $3)`,
          [`${key}_${ten.tenantId}`, ten.productId, ten.tenantId],
        );
      }
    }
    for (const n of [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) await applyMigration(client, n);
    const db = createTenantDb({ pool: sandboxTxPool(client) });

    const out = await cp.applyProposalDecisions(db, 'acme', {
      decisions: [
        { proposal_key: 'pa_acme', action: 'approve', reason: 'ok' },
        { proposal_key: 'pr_acme', action: 'reject', reason: 'nein' },
      ],
      nowIso: NOW,
    });
    assert.equal(out.approved, 1);
    assert.equal(out.rejected, 1);

    const acmeRows = await db.read({
      tenant: 'acme', tables: ['product_change_proposals'],
      text: `SELECT proposal_key, status, decided_by FROM automatenlager.product_change_proposals WHERE tenant_id = $1 ORDER BY proposal_key`,
    });
    const byKey = Object.fromEntries(acmeRows.rows.map((r) => [r.proposal_key, r]));
    assert.equal(byKey.pa_acme.status, 'approved');
    assert.equal(byKey.pr_acme.status, 'rejected');
    assert.equal(byKey.pa_acme.decided_by, 'claude_proposals');

    // ISOLATION: globex unverändert (beide noch pending)
    const globexRows = await db.read({
      tenant: 'globex', tables: ['product_change_proposals'],
      text: `SELECT count(*)::int AS n FROM automatenlager.product_change_proposals WHERE tenant_id = $1 AND status = 'pending'`,
    });
    assert.equal(globexRows.rows[0].n, 2, 'globex-Proposals unangetastet');
  });
});

// ── Factory ──────────────────────────────────────────────────────────────────
test('#162 createClaudeProposalsJob: ohne tenantRunner ⇒ TypeError (fail-closed)', () => {
  assert.throws(() => cp.createClaudeProposalsJob({}), /tenantRunner/);
});
