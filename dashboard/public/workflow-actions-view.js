(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.workflowActionsView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function renderWorkflowActionCards(data, escapeHtml) {
    const actions = data.actions || [];
    const canTriggerActions = data.viewer?.canTriggerActions !== false;

    return actions.map((action) => {
      const stateClass = action.runnable ? 'ok' : action.workflowId ? 'warn' : 'danger';
      const buttonLabel = action.triggerType === 'form'
        ? 'Formular öffnen'
        : action.triggerType === 'webhook'
          ? 'Workflow starten'
          : 'Noch nicht auslösbar';
      const editorButton = canTriggerActions && action.editorUrl
        ? `<a class="button small" href="${escapeHtml(action.editorUrl)}" target="_blank" rel="noreferrer">In n8n öffnen</a>`
        : '';
      const triggerButton = canTriggerActions
        ? `<button class="button primary small" type="button" data-action-id="${escapeHtml(action.id)}" ${action.runnable ? '' : 'disabled'}>${escapeHtml(buttonLabel)}</button>`
        : '<span class="chip info">Read-Only</span>';

      return `
        <article class="action-card">
          <div class="action-card-top">
            <div>
              <span class="chip ${stateClass}">${escapeHtml(action.workflowActive ? 'aktiv' : action.workflowId ? 'inaktiv' : 'fehlt')}</span>
              <h3>${escapeHtml(action.label)}</h3>
            </div>
          </div>
          <p>${escapeHtml(action.description)}</p>
          <div class="action-meta">
            <span class="mono">${escapeHtml(action.workflowName || 'kein Workflow zugeordnet')}</span>
            <span>${escapeHtml(action.status)}</span>
          </div>
          <div class="action-buttons">
            ${triggerButton}
            ${editorButton}
          </div>
        </article>
      `;
    }).join('');
  }

  return { renderWorkflowActionCards };
});
