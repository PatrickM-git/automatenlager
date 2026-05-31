'use strict';

/**
 * Onboarding-Flow — reine Aufbereitung der /api/v2/onboarding-Daten für das
 * v3-Onboarding-Cockpit.
 *
 * Domäne (siehe CLAUDE.md): Produkt-Stammdaten (Name/Einstandspreis/MwSt),
 * Aliase und Lagerchargen (inkl. MHD) gehören WF2 bzw. dem Wareneingang und
 * entstehen über WF1 (Rechnung) -> WF2 (Freigabe). Diese Seite ERFASST keine
 * Stammdaten; sie nimmt Rechnungen an (Upload -> WF1), routet offene Freigaben
 * ins WF2-Formular und stößt unbekannte Nayax-Produkte an. Die Slot-Zuordnung
 * läuft über die Sortiment-Seite und wird hier bewusst NICHT angezeigt.
 *
 * Statuszeile (schlank): Freigabe offen -> Nayax-Verknüpfung offen -> Verkaufsbereit.
 * „Nayax-Verknüpfung offen" entspricht dem Lebenszyklus-Status `bereit_fur_moma`:
 * das Produkt hat einen Alias, aber noch keinen Nayax-Alias.
 */

function buildOnboardingFunnel(data = {}) {
  const d = data || {};
  const byStatus = d.products_by_status || {};
  const approvals = Array.isArray(d.pending_approvals) ? d.pending_approvals : [];
  const unknown = Array.isArray(d.unknown_products) ? d.unknown_products : [];
  const cnt = (key) => (Array.isArray(byStatus[key]) ? byStatus[key].length : 0);

  const approvalsCount = approvals.length;
  const nayaxPendingCount = cnt('bereit_fur_moma');
  const verkaufsbereitCount = cnt('verkaufsbereit');

  return {
    stages: [
      { key: 'approvals',      label: 'Freigabe offen',          count: approvalsCount },
      { key: 'nayax_pending',  label: 'Nayax-Verknüpfung offen', count: nayaxPendingCount },
      { key: 'verkaufsbereit', label: 'Verkaufsbereit',          count: verkaufsbereitCount },
    ],
    approvals: approvals.slice(),
    approvalsCount,
    nayaxPendingCount,
    verkaufsbereitCount,
    unknownProducts: unknown.slice(),
    unknownCount: unknown.length,
    wf2FormUrl: d.wf2_form_url || '',
  };
}

module.exports = { buildOnboardingFunnel };
