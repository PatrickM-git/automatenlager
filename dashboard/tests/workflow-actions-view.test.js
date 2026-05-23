const assert = require('node:assert/strict');
const test = require('node:test');

const { renderWorkflowActionCards } = require('../public/workflow-actions-view');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

test('guest users see action cards without workflow trigger buttons', () => {
  const html = renderWorkflowActionCards({
    viewer: {
      role: 'guest',
      canTriggerActions: false,
    },
    actions: [
      {
        id: 'invoice-intake',
        label: 'Rechnungseingang starten',
        description: 'Neue Rechnungen einlesen.',
        workflowName: 'WF1',
        status: 'Webhook kann ausgelöst werden (POST)',
        triggerType: 'webhook',
        runnable: true,
        workflowId: 'wf1',
        workflowActive: true,
        editorUrl: 'http://n8n.local/workflow/wf1',
      },
    ],
  }, escapeHtml);

  assert.match(html, /Rechnungseingang starten/);
  assert.doesNotMatch(html, /data-action-id=/);
  assert.doesNotMatch(html, /Workflow starten/);
  assert.match(html, /Read-Only/);
});
