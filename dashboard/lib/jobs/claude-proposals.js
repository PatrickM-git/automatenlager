'use strict';

/**
 * WF-Claude-Proposals — In-Process-Port (Issue #162, Stufe 6 Slice 2).
 *
 * Schedule-Job (n8n: cron `0 30 4 * * *` → täglich 04:30): liest pending
 * `product_change_proposals` (älter als 14 Tage), lässt sie von Claude
 * vorentscheiden (approve/reject/escalate), aktualisiert den Status DURCH die
 * Mandanten-Tür und meldet Eskalationen per Mailer.
 *
 * Verhaltensgetreu aus der authoritativen Mini-WF-Definition abgeleitet:
 *   - Modell claude-haiku-4-5-20251001, max_tokens 1024, identischer System-Prompt
 *   - nur Entscheidungen zu proposal_keys, die wirklich aus der DB kamen
 *   - approve→'approved', reject→'rejected' (nur status='pending'); escalate bleibt pending
 *
 * Ebenen: (1) reine Logik buildProposalsPrompt/parseDecisions; (2) read/apply durch
 * die Tür; (3) runForTenant-Orchestrierung; (4) Worker-Factory (per Mandant).
 */

const { resolveTenantAlertEmail } = require('./mailer.js');

const CLAUDE_PROPOSALS_MODEL = 'claude-haiku-4-5-20251001';
const PROPOSAL_KEY = 'claude-proposals';

const SYSTEM_PROMPT = `Du bist Assistent fuer ein Verkaufsautomaten-Unternehmen.
Bearbeite offene Rechnungsvorschlaege nach diesen Regeln:
- approve: Produkt existiert im Katalog (product_name vorhanden) UND ist aktiv UND der Grund ist klar
- reject: Produkt NICHT im Katalog UND Wartezeit > 21 Tage ODER Grund ist voellig unklar
- escalate: Alle anderen Faelle (neue Produkte, grosse Aenderungen, unsicher)
Antworte AUSSCHLIESSLICH als gueltiges JSON-Objekt:
{"decisions":[{"proposal_key":"...","action":"approve|reject|escalate","reason":"..."}]}`;

/** Reine Logik: Prompt + Anthropic-Request-Body aus den Proposals bauen. */
function buildProposalsPrompt(proposals = []) {
  const proposalText = proposals.map((p) => (
    `Proposal: ${p.proposal_key}\n`
    + `Produkt-Key: ${p.product_key}\n`
    + (p.product_name
      ? `Produkt gefunden: ${p.product_name} (aktiv: ${p.product_active}, Kategorie: ${p.category || '?'})`
      : 'PRODUKT NICHT IM KATALOG') + '\n'
    + `Grund: ${p.reason || '(kein Grund angegeben)'}\n`
    + `Wartezeit: ${p.days_pending} Tage`
  )).join('\n\n---\n\n');

  const request_body = {
    model: CLAUDE_PROPOSALS_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `${proposals.length} offene Proposals (aelter als 14 Tage):\n\n${proposalText}\n\nBitte entscheide fuer jeden Proposal.`,
    }],
  };
  return { request_body, inputKeys: proposals.map((p) => p.proposal_key), proposalText, system: SYSTEM_PROMPT };
}

/** Reine Logik: Claude-Antwort parsen, nur DB-Keys vertrauen, nach Aktion splitten. */
function parseDecisions(claudeResponse, inputKeys = []) {
  let decisions = [];
  try {
    const raw = (claudeResponse && claudeResponse.content && claudeResponse.content[0] && claudeResponse.content[0].text) || '{}';
    const match = String(raw).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : '{}');
    decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  } catch {
    decisions = [];
  }
  const keys = new Set(inputKeys);
  const safeDecisions = decisions.filter((d) => d && keys.has(d.proposal_key));
  return {
    safeDecisions,
    approvals: safeDecisions.filter((d) => d.action === 'approve'),
    rejections: safeDecisions.filter((d) => d.action === 'reject'),
    escalations: safeDecisions.filter((d) => d.action === 'escalate'),
  };
}

/** Pending Proposals (älter als N Tage) durch die Tür lesen. */
async function readPendingProposals(db, tenant, { olderThanDays = 14, limit = 20 } = {}) {
  const res = await db.read({
    tenant,
    tables: ['product_change_proposals', 'products', 'slot_assignments'],
    text: `SELECT pcp.proposal_key, pcp.status, pcp.reason, pcp.product_id,
                  p.product_key AS product_key,
                  EXTRACT(DAY FROM NOW() - pcp.created_at)::int AS days_pending,
                  p.name AS product_name,
                  EXISTS (SELECT 1 FROM automatenlager.slot_assignments sa
                           WHERE sa.product_id = pcp.product_id AND sa.active = TRUE
                             AND sa.tenant_id = $1) AS product_active,
                  p.category
             FROM automatenlager.product_change_proposals pcp
             LEFT JOIN automatenlager.products p ON p.product_id = pcp.product_id
            WHERE pcp.tenant_id = $1 AND pcp.status = 'pending'
              AND pcp.created_at < NOW() - ($2 || ' days')::interval
            ORDER BY pcp.created_at ASC
            LIMIT $3`,
    params: [olderThanDays, limit],
  });
  return res.rows;
}

/** approve/reject-Entscheidungen durch die Tür anwenden (nur status='pending', idempotent). */
async function applyProposalDecisions(db, tenant, { decisions = [] } = {}) {
  const decided = decisions.filter((d) => d.action === 'approve' || d.action === 'reject');
  if (!decided.length) return { approved: 0, rejected: 0 };
  return db.tx(tenant, async (door) => {
    let approved = 0; let rejected = 0;
    for (const d of decided) {
      const status = d.action === 'approve' ? 'approved' : 'rejected';
      const r = await door.write({
        tables: ['product_change_proposals'],
        text: `UPDATE automatenlager.product_change_proposals
                  SET status = $2, decided_at = NOW(), decided_by = 'claude_proposals', decision_note = $3
                WHERE tenant_id = $1 AND proposal_key = $4 AND status = 'pending'`,
        params: [status, String(d.reason || ''), String(d.proposal_key)],
      });
      if ((r.rowCount || 0) > 0) { if (status === 'approved') approved += 1; else rejected += 1; }
    }
    return { approved, rejected };
  });
}

function buildEscalationText(escalations, proposalsByKey) {
  const lines = escalations.map((e) => {
    const p = proposalsByKey[e.proposal_key] || {};
    return `- ${e.proposal_key} (${p.product_key || '?'}): ${e.reason || p.reason || ''}`;
  });
  return `Folgende Rechnungsvorschlaege brauchen eine manuelle Entscheidung:\n\n${lines.join('\n')}`;
}

/** Orchestrierung je Mandant: lesen → Claude → anwenden → Eskalationen mailen. */
async function runClaudeProposalsForTenant(db, tenant, { anthropic, mailer, env = process.env } = {}) {
  const proposals = await readPendingProposals(db, tenant, {});
  if (!proposals.length) return { tenant, considered: 0, approved: 0, rejected: 0, escalated: 0 };
  if (!anthropic || typeof anthropic.createMessage !== 'function') {
    return { tenant, considered: proposals.length, approved: 0, rejected: 0, escalated: 0, skipped: 'no_anthropic' };
  }
  const { request_body, inputKeys } = buildProposalsPrompt(proposals);
  const resp = await anthropic.createMessage(request_body);
  const { safeDecisions, escalations } = parseDecisions(resp, inputKeys);
  const applied = await applyProposalDecisions(db, tenant, { decisions: safeDecisions });

  if (escalations.length && mailer && typeof mailer.send === 'function') {
    const byKey = Object.fromEntries(proposals.map((p) => [p.proposal_key, p]));
    await mailer.send({
      to: resolveTenantAlertEmail(env, tenant),
      subject: `[Automatenlager] ${escalations.length} Proposal-Eskalation(en)`,
      text: buildEscalationText(escalations, byKey),
    });
  }
  return { tenant, considered: proposals.length, approved: applied.approved, rejected: applied.rejected, escalated: escalations.length };
}

/** Worker-Factory (per Mandant durch die Tür, #160-Runner). */
function createClaudeProposalsJob({ tenantRunner, anthropic, mailer, env = process.env } = {}) {
  if (!tenantRunner || typeof tenantRunner.runForAll !== 'function') {
    throw new TypeError('claude-proposals: tenantRunner mit runForAll() erforderlich');
  }
  return {
    key: PROPOSAL_KEY,
    run: async () => {
      const res = await tenantRunner.runForAll(
        (db, tenant) => runClaudeProposalsForTenant(db, tenant, { anthropic, mailer, env }),
        { continueOnError: true },
      );
      return res;
    },
  };
}

module.exports = {
  CLAUDE_PROPOSALS_MODEL,
  SYSTEM_PROMPT,
  buildProposalsPrompt,
  parseDecisions,
  readPendingProposals,
  applyProposalDecisions,
  runClaudeProposalsForTenant,
  createClaudeProposalsJob,
};
