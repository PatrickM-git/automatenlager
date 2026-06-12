'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WF4_PATH = path.join(__dirname, '..', '..', 'WF4 - MDB Produktzuordnung bearbeiten.json');
const MIGRATION_PATH = path.join(__dirname, '..', '..', '..', 'homelab', 'infra', 'postgres', 'migrations', '0019_pgw_proposal_resolved.sql');

function loadWf4() {
  return JSON.parse(fs.readFileSync(WF4_PATH, 'utf8'));
}

// ── WF4 Struktur ─────────────────────────────────────────────────────────────

test('AC-WF4-1: WF4 hat einen Webhook-Trigger-Node', () => {
  const wf = loadWf4();
  const webhookNode = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  assert.ok(webhookNode, 'Kein Webhook-Node in WF4 gefunden');
  assert.equal(webhookNode.name, 'Webhook');
});

test('AC-WF4-2: WF4 Webhook leitet in einen Routing-Node, nicht direkt zu Config - WF4', () => {
  const wf = loadWf4();
  const webhookConnections = wf.connections['Webhook'];
  assert.ok(webhookConnections, 'Keine Connections vom Webhook-Node');
  const targets = webhookConnections.main.flat().map((c) => c.node);
  assert.ok(
    !targets.includes('Config - WF4'),
    `Webhook darf nicht direkt zu "Config - WF4" verbunden sein; aktuell: ${targets.join(', ')}`,
  );
  assert.ok(targets.length > 0, 'Webhook muss mindestens eine Verbindung haben');
});

test('AC-WF4-3: WF4 hat einen Korrektur-Aktions-Pfad der zu WF-PGW führt', () => {
  const wf = loadWf4();
  const allNodes = wf.nodes.map((n) => n.name);
  const hasCorrectionCode = allNodes.some((n) =>
    n.toLowerCase().includes('correction') || n.toLowerCase().includes('corr') || n.toLowerCase().includes('korrektur'),
  );
  assert.ok(hasCorrectionCode, `Kein Korrektur-Aktions-Node gefunden. Nodes: ${allNodes.join(', ')}`);
});

test('AC-WF4-4: WF4 referenziert WF-PGW korrekt (ID Sajezv8tJll0CLIv)', () => {
  const wf = loadWf4();
  const pgwNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.ok(pgwNodes.length > 0, 'Kein executeWorkflow-Node in WF4');
  const correctIds = pgwNodes.filter((n) => {
    const wfId = n.parameters?.workflowId?.value ?? n.parameters?.workflowId;
    return wfId === 'Sajezv8tJll0CLIv';
  });
  assert.ok(correctIds.length > 0, 'Kein WF-PGW-Node mit korrekter ID Sajezv8tJll0CLIv');
});

test('AC-WF4-5: WF4 Form-Trigger und Execute-Workflow-Trigger bleiben erhalten', () => {
  const wf = loadWf4();
  const types = wf.nodes.map((n) => n.type);
  assert.ok(types.includes('n8n-nodes-base.formTrigger'), 'Form Trigger fehlt');
  assert.ok(types.includes('n8n-nodes-base.executeWorkflowTrigger'), 'Execute Workflow Trigger fehlt');
});

test('AC-WF4-6: WF4 Korrektur-Code-Node prüft action_key (Idempotenz)', () => {
  const wf = loadWf4();
  const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code' && n.parameters?.jsCode);
  const hasActionKeyCheck = codeNodes.some((n) =>
    n.parameters.jsCode.includes('action_key'),
  );
  assert.ok(hasActionKeyCheck, 'Kein Code-Node prüft action_key für Idempotenz');
});

// ── Migration ─────────────────────────────────────────────────────────────────

// Diese drei AC-MIGRATION-Tests prüfen eine MIGRATION AUSSERHALB dieses Repos
// (altes homelab/infra/postgres aus der n8n-Ära). Existiert das externe
// Verzeichnis nicht (CI, anderer Rechner), wird sauber übersprungen statt
// fehlzuschlagen — sonst sind die Tests „läuft nur auf einem Rechner"-brüchig.
test('AC-MIGRATION-7: Migration 0019_pgw_proposal_resolved.sql existiert', (t) => {
  if (!fs.existsSync(MIGRATION_PATH)) { t.skip(`Externe homelab-Migration nicht vorhanden: ${MIGRATION_PATH}`); return; }
  assert.ok(fs.existsSync(MIGRATION_PATH), `Migration nicht gefunden: ${MIGRATION_PATH}`);
});

test('AC-MIGRATION-8: Migration enthält proposal_resolved Event-Type', (t) => {
  if (!fs.existsSync(MIGRATION_PATH)) { t.skip('Externe homelab-Migration nicht vorhanden.'); return; }
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(sql.includes('proposal_resolved'), 'Migration enthält kein proposal_resolved WHEN-Clause');
});

test('AC-MIGRATION-9: Migration setzt status=resolved idempotent (kein Update wenn bereits resolved)', (t) => {
  if (!fs.existsSync(MIGRATION_PATH)) { t.skip('Externe homelab-Migration nicht vorhanden.'); return; }
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(
    sql.includes('resolved') && (sql.includes('status') || sql.includes('decided_at')),
    'Migration setzt status und decided_at nicht korrekt',
  );
});
