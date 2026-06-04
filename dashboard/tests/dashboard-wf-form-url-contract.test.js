'use strict';

// Guard: Form-Trigger-Workflows, die das Dashboard als anklickbare Formular-URL
// anbietet (z. B. WF2 "Rechnungen freigeben", WF4 "Slot-Zuordnung"), müssen in
// ihrer committeten JSON `active: true` UND einen auflösbaren Form-Pfad haben.
//
// Hintergrund: Das Dashboard liest den Workflow-Zustand aus der committeten
// JSON-Datei (nicht live aus n8n) und baut die URL nur, wenn der Workflow
// `active` ist (siehe server.js `firstFormUrl`: `if (!form || !workflow.active)
// return ''`). Fehlt das Flag, zeigt die Kachel still "WF2-Formular-URL nicht
// konfiguriert" — obwohl der Workflow auf dem Mini aktiv ist. Genau dieser
// stille Drift soll hier hart auffallen, statt erst im UI bemerkt zu werden.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function clean(v) {
  return String(v == null ? '' : v).trim();
}

// Mirror von server.js: firstFormUrl / summarizeN8nWorkflow (formPath-Auflösung).
function resolveFormPath(formNode) {
  const p = formNode.parameters || {};
  return clean(
    (p.options && (p.options.path || p.options.formPath)) ||
      p.path ||
      p.formPath ||
      formNode.webhookId
  );
}

function listFormWorkflowFiles() {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((name) => /^WF.*\.json$/.test(name))
    .map((name) => ({ name, json: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, name), 'utf8')) }))
    .filter((wf) => (wf.json.nodes || []).some((n) => n.type === 'n8n-nodes-base.formTrigger'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('Form-Workflows: committete JSON hat active:true (sonst leere Dashboard-URL)', () => {
  const files = listFormWorkflowFiles();
  assert.ok(files.length >= 1, 'Es sollte mindestens einen Form-Trigger-Workflow geben (z. B. WF2/WF4).');
  for (const wf of files) {
    assert.equal(
      wf.json.active === true,
      true,
      `${wf.name}: top-level "active" muss true sein — sonst baut das Dashboard keine Formular-URL ("nicht konfiguriert").`
    );
  }
});

test('Form-Workflows: jeder Form-Trigger hat einen auflösbaren Form-Pfad', () => {
  for (const wf of listFormWorkflowFiles()) {
    const formNodes = (wf.json.nodes || []).filter((n) => n.type === 'n8n-nodes-base.formTrigger');
    const resolvable = formNodes.some((n) => resolveFormPath(n).length > 0);
    assert.ok(
      resolvable,
      `${wf.name}: kein Form-Trigger mit auflösbarem Pfad (options.path / path / webhookId) — Dashboard-URL bliebe leer.`
    );
  }
});
