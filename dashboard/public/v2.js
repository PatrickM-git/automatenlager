function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ampelLabel(state) {
  if (state === 'red') return 'kritisch';
  if (state === 'yellow') return 'beobachten';
  return 'ok';
}

function renderAmpelGrid(containerSelector, ampels) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  if (!ampels || !ampels.length) {
    container.innerHTML = '<div class="v2-priority-empty">Keine Monitoring-Daten vorhanden.</div>';
    return;
  }

  container.innerHTML = ampels.map((item) => `
    <div class="v2-ampel-card v2-ampel-card--${escapeHtml(item.state)}">
      <div class="v2-ampel-head">
        <span class="v2-ampel-dot" aria-hidden="true"></span>
        <strong>${escapeHtml(item.label)}</strong>
      </div>
      <p class="v2-ampel-state">${escapeHtml(ampelLabel(item.state))}</p>
      <p class="v2-ampel-message">${escapeHtml(item.message || '')}</p>
    </div>
  `).join('');
}

function renderOverview(payload) {
  const data = payload?.data || {};
  const prioritiesEl = document.querySelector('#overviewPriorities');
  const staleEl = document.querySelector('#overviewStaleState');

  if (staleEl) {
    staleEl.textContent = data.stale?.message || 'Datenstand wird geladen.';
    staleEl.dataset.state = data.stale?.isStale ? 'stale' : 'fresh';
  }

  const priorities = data.priorities || [];
  if (prioritiesEl) {
    if (!priorities.length) {
      prioritiesEl.innerHTML = '<div class="v2-priority-empty">Keine offenen Prioritaeten fuer heute.</div>';
    } else {
      prioritiesEl.innerHTML = priorities.map((item) => `
        <div class="v2-priority-item v2-priority-item--${escapeHtml(item.severity)}">
          <div class="v2-priority-main">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.message)}</span>
          </div>
          <span class="v2-priority-count">${escapeHtml(item.count)}</span>
        </div>
      `).join('');
    }
  }

  renderAmpelGrid('#overviewAmpels', data.ampels || []);
}

async function loadV2Overview() {
  const status = document.querySelector('#v2Status');
  try {
    const response = await fetch('/api/v2/overview', { cache: 'no-store' });
    const payload = await response.json();
    if (!payload.ok || !payload.data) {
      if (status) {
        status.textContent = `${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}`;
      }
      renderOverview({ data: { priorities: [], ampels: [], stale: { isStale: true, message: 'FEHLER: Overview-Daten konnten nicht geladen werden.' } } });
      return;
    }

    if (status) {
      status.textContent = `PG-Datenstand: ${payload.generatedAtDisplay || payload.generatedAt}`;
    }
    renderOverview(payload);
  } catch (error) {
    if (status) status.textContent = `FEHLER: API nicht erreichbar: ${error.message}`;
    renderOverview({ data: { priorities: [], ampels: [], stale: { isStale: true, message: `FEHLER: ${error.message}` } } });
  }
}

async function loadMonitoring() {
  const stateEl = document.querySelector('#monitoringState');
  try {
    const response = await fetch('/api/v2/monitoring', { cache: 'no-store' });
    const payload = await response.json();
    if (!payload.ok || !payload.data) {
      if (stateEl) {
        stateEl.textContent = `${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}`;
      }
      renderAmpelGrid('#monitoringAmpelList', []);
      return;
    }

    const stale = payload.data.stale?.isStale;
    if (stateEl) {
      stateEl.textContent = stale
        ? payload.data.stale.message
        : `Stand: ${payload.generatedAtDisplay || payload.generatedAt}`;
    }
    renderAmpelGrid('#monitoringAmpelList', payload.data.ampels || []);
  } catch (error) {
    if (stateEl) stateEl.textContent = `FEHLER: API nicht erreichbar: ${error.message}`;
    renderAmpelGrid('#monitoringAmpelList', []);
  }
}

// ── Inventory / Bestand & MHD ────────────────────────────────────────────────

const inventoryState = {
  location: '',
  machine: '',
};

function severityLabel(severity) {
  if (severity === 'critical' || severity === 'error') return 'kritisch';
  if (severity === 'warning') return 'Warnung';
  return 'Info';
}

const INVENTORY_COLLAPSE_AFTER = 5;

function renderInventoryList(el, rows, emptyText, renderRow) {
  if (!rows || !rows.length) {
    el.innerHTML = `<div class="v2-inventory-empty">${emptyText}</div>`;
    return;
  }

  if (rows.length <= INVENTORY_COLLAPSE_AFTER) {
    el.innerHTML = rows.map(renderRow).join('');
    return;
  }

  const visibleHtml = rows.slice(0, INVENTORY_COLLAPSE_AFTER).map(renderRow).join('');
  const hiddenHtml  = rows.slice(INVENTORY_COLLAPSE_AFTER).map(renderRow).join('');
  const remaining   = rows.length - INVENTORY_COLLAPSE_AFTER;

  el.innerHTML = `
    ${visibleHtml}
    <div class="v2-inventory-expanded" hidden>${hiddenHtml}</div>
    <button class="v2-inventory-expand-btn" type="button">
      <span class="v2-expand-label">+ ${remaining} weitere anzeigen</span>
      <span class="v2-inventory-expand-count">${rows.length} gesamt</span>
    </button>`;

  const btn       = el.querySelector('.v2-inventory-expand-btn');
  const expandDiv = el.querySelector('.v2-inventory-expanded');

  btn.addEventListener('click', () => {
    const nowOpen = expandDiv.hidden;
    expandDiv.hidden = !nowOpen;
    btn.querySelector('.v2-expand-label').textContent = nowOpen
      ? `− weniger anzeigen`
      : `+ ${remaining} weitere anzeigen`;
  });
}

function renderMhdRow(row) {
  return `
    <div class="v2-inventory-row v2-inventory-row--${escapeHtml(row.severity)}">
      <div class="v2-inventory-main">
        <strong>${escapeHtml(row.product_name)}</strong>
        <span>${escapeHtml(row.location_name || row.location_id)} · ${escapeHtml(row.machine_name || row.machine_id)} · MDB ${escapeHtml(row.mdb_code)}</span>
      </div>
      <div class="v2-inventory-meta">
        <span class="v2-inventory-date">${escapeHtml(row.mhd_date)}</span>
        <span class="v2-inventory-pill">${escapeHtml(severityLabel(row.severity))}</span>
        <span>${escapeHtml(row.remaining_qty)} Stk.</span>
      </div>
    </div>`;
}

function renderLowStockRow(row) {
  return `
    <div class="v2-inventory-row">
      <div class="v2-inventory-main">
        <strong>${escapeHtml(row.product_name)}</strong>
        <span>${escapeHtml(row.location_name || row.location_id)} · ${escapeHtml(row.machine_name || row.machine_id)} · MDB ${escapeHtml(row.mdb_code)}</span>
      </div>
      <div class="v2-inventory-meta">
        <span>${escapeHtml(row.current_machine_qty)} / ${escapeHtml(row.target_stock)} im Slot</span>
        <span class="v2-inventory-pill">${escapeHtml(row.refill_gap)} nachfüllen</span>
        <span>${escapeHtml(row.urgency_label)}</span>
      </div>
    </div>`;
}

async function loadInventoryMhd() {
  const stateEl = document.querySelector('#inventoryState');
  const contentEl = document.querySelector('#inventoryContent');
  const mhdList = document.querySelector('#inventoryMhdList');
  const lowStockList = document.querySelector('#inventoryLowStockList');
  const location = inventoryState.location.trim();
  const machine = inventoryState.machine.trim();
  const url = `/api/v2/inventory-mhd?location=${encodeURIComponent(location)}&machine=${encodeURIComponent(machine)}`;

  stateEl.hidden = false;
  contentEl.hidden = true;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();

    if (!payload.ok || !payload.data) {
      stateEl.textContent = `${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}`;
      return;
    }

    renderInventoryList(mhdList, payload.data.mhdRisks, 'Keine MHD-Risiken für diesen Filter.', renderMhdRow);
    renderInventoryList(lowStockList, payload.data.lowStock, 'Keine niedrigen Bestände für diesen Filter.', renderLowStockRow);
    stateEl.hidden = true;
    contentEl.hidden = false;
  } catch (err) {
    stateEl.textContent = `API nicht erreichbar: ${err.message}`;
  }
}

function initInventoryMhd() {
  const locationInput = document.querySelector('#inventoryLocationFilter');
  const machineInput = document.querySelector('#inventoryMachineFilter');
  if (!locationInput || !machineInput) return;

  let debounce;
  const onChange = () => {
    clearTimeout(debounce);
    inventoryState.location = locationInput.value;
    inventoryState.machine = machineInput.value;
    debounce = setTimeout(loadInventoryMhd, 300);
  };
  locationInput.addEventListener('input', onChange);
  machineInput.addEventListener('change', onChange);
  loadInventoryMhd();
}

// ── Assortment / Sortiment & Slots ───────────────────────────────────────────

const assortmentState = {
  location: '',
  machine: '',
};

function renderIndicatorChips(indicators) {
  if (!indicators || !indicators.length) {
    return '<span class="v2-indicator-empty">keine Signale</span>';
  }
  return indicators.map((item) => `
    <span class="v2-indicator-chip v2-indicator-chip--${escapeHtml(item.source)}" title="${escapeHtml(item.evidence)}">
      ${escapeHtml(item.label)}
    </span>`).join('');
}

function renderAssortmentLegend(items) {
  const legend = document.querySelector('#assortmentIndicatorLegend');
  legend.innerHTML = `
    <span class="v2-indicator-note">Indikatoren sind Signale, keine automatischen Empfehlungen.</span>
    ${(items || []).map((item) => `
      <span class="v2-indicator-chip v2-indicator-chip--${escapeHtml(item.source)}">${escapeHtml(item.label)}</span>
    `).join('')}`;
}

function renderAssortmentSlots(rows) {
  const list = document.querySelector('#assortmentSlotList');
  if (!rows || !rows.length) {
    list.innerHTML = '<div class="v2-inventory-empty">Keine Slot-Belegung für diesen Filter.</div>';
    return;
  }
  list.innerHTML = rows.map((row) => `
    <div class="v2-assortment-row">
      <div class="v2-assortment-slot">
        <span class="v2-assortment-mdb">MDB ${escapeHtml(row.mdb_code)}</span>
        <strong>${escapeHtml(row.product_name)}</strong>
        <span>${escapeHtml(row.location_name || row.location_id)} · ${escapeHtml(row.machine_name || row.machine_id)}</span>
      </div>
      <div class="v2-assortment-occupancy">
        <span>${escapeHtml(row.occupancy.label)}</span>
        <span>${escapeHtml(row.occupancy.fill_pct)} % Füllung</span>
        <span>${escapeHtml(row.qty)} Stk. verkauft</span>
      </div>
      <div class="v2-assortment-indicators">
        ${renderIndicatorChips(row.indicators)}
      </div>
    </div>`).join('');
}

async function loadAssortmentSlots() {
  const stateEl = document.querySelector('#assortmentState');
  const contentEl = document.querySelector('#assortmentContent');
  const location = assortmentState.location.trim();
  const machine = assortmentState.machine.trim();
  const url = `/api/v2/assortment-slots?location=${encodeURIComponent(location)}&machine=${encodeURIComponent(machine)}`;

  stateEl.hidden = false;
  contentEl.hidden = true;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();

    if (!payload.ok || !payload.data) {
      stateEl.textContent = `${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}`;
      return;
    }

    renderAssortmentLegend(payload.data.indicatorLegend);
    renderAssortmentSlots(payload.data.slots);
    stateEl.hidden = true;
    contentEl.hidden = false;
  } catch (err) {
    stateEl.textContent = `API nicht erreichbar: ${err.message}`;
  }
}

function initAssortmentSlots() {
  const locationInput = document.querySelector('#assortmentLocationFilter');
  const machineInput = document.querySelector('#assortmentMachineFilter');
  if (!locationInput || !machineInput) return;

  let debounce;
  const onChange = () => {
    clearTimeout(debounce);
    assortmentState.location = locationInput.value;
    assortmentState.machine = machineInput.value;
    debounce = setTimeout(loadAssortmentSlots, 300);
  };
  locationInput.addEventListener('input', onChange);
  machineInput.addEventListener('change', onChange);
  loadAssortmentSlots();
}

function setUploadStatus(target, message, state = '') {
  const statusEl = document.querySelector(`#${target}UploadStatus`);
  if (!statusEl) return;
  statusEl.textContent = message || '';
  if (state) {
    statusEl.dataset.state = state;
  } else {
    delete statusEl.dataset.state;
  }
}

function setUploadUiEnabled(enabled) {
  document.querySelectorAll('#uploads input, #uploads button').forEach((element) => {
    element.disabled = !enabled;
  });
}

async function loadUploadCapabilities() {
  const section = document.querySelector('#uploads');
  const meta = document.querySelector('#v2UploadMeta');
  if (!section || !meta) return;

  section.hidden = true;
  setUploadUiEnabled(false);

  try {
    const response = await fetch('/api/v2/upload-capabilities', { cache: 'no-store' });
    const payload = await response.json();
    if (!payload.ok || !payload.canUpload) return;

    const invoiceTarget = (payload.targets || []).find((item) => item.id === 'invoice');
    const picklistTarget = (payload.targets || []).find((item) => item.id === 'picklist');
    meta.textContent = `Max ${Math.round((invoiceTarget?.maxBytes || 0) / (1024 * 1024))} MB Rechnung, ${Math.round((picklistTarget?.maxBytes || 0) / (1024 * 1024))} MB Pickliste`;

    section.hidden = false;
    setUploadUiEnabled(true);
  } catch (error) {
    meta.textContent = `Upload-Konfiguration nicht erreichbar: ${error.message}`;
  }
}

async function submitUpload(target) {
  const input = document.querySelector(`#${target}UploadFile`);
  if (!input) return;

  const file = input.files && input.files[0];
  if (!file) {
    setUploadStatus(target, 'Bitte zuerst eine Datei waehlen.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('target', target);
  formData.append('file', file, file.name);
  setUploadStatus(target, 'Upload laeuft ...');

  try {
    const response = await fetch(`/api/v2/uploads/${encodeURIComponent(target)}`, {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      setUploadStatus(target, `${payload.error?.code || 'UPLOAD_ERROR'}: ${payload.error?.message || 'Upload fehlgeschlagen.'}`, 'error');
      return;
    }

    const wfRef = payload.workflow?.id ? `${payload.workflow.name || payload.workflow.id} (${payload.workflow.id})` : 'Workflow';
    setUploadStatus(target, `Upload uebergeben an ${wfRef}.`, 'ok');
    input.value = '';
  } catch (error) {
    setUploadStatus(target, `Upload fehlgeschlagen: ${error.message}`, 'error');
  }
}

function initUploads() {
  const invoiceForm = document.querySelector('#invoiceUploadForm');
  const picklistForm = document.querySelector('#picklistUploadForm');
  if (!invoiceForm || !picklistForm) return;

  invoiceForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitUpload('invoice');
  });
  picklistForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitUpload('picklist');
  });

  loadUploadCapabilities();
}

// ── Economics / GuV & KPI ────────────────────────────────────────────────────

function currentBerlinMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date()).slice(0, 7);
}

function formatMonthLabel(yyyyMm) {
  const [y, m] = yyyyMm.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('de-DE', {
    month: 'long',
    year: 'numeric',
  });
}

const ecoState = {
  sortBy: 'revenue_net',
  sortOrder: 'desc',
  machine: '',
  month: currentBerlinMonth(),
};

function fmtEur(value) {
  return Number(value).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtPct(value) {
  return Number(value).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
}

function renderSortIndicators() {
  document.querySelectorAll('.v2-sort-btn').forEach((btn) => {
    btn.classList.remove('v2-sort-btn--asc', 'v2-sort-btn--desc');
    if (btn.dataset.sort === ecoState.sortBy) {
      btn.classList.add(ecoState.sortOrder === 'asc' ? 'v2-sort-btn--asc' : 'v2-sort-btn--desc');
    }
  });
}

function renderHeroStrip(totals, period) {
  const hero = document.querySelector('#ecoHero');
  const marginPct = totals.revenue_net > 0
    ? ((totals.db_net / totals.revenue_net) * 100)
    : 0;
  const marginClass = marginPct >= 60 ? 'v2-eco-kpi--positive' : marginPct < 50 ? 'v2-eco-kpi--warn' : '';
  const periodLabel = period ? formatMonthLabel(period.from) : '';

  hero.innerHTML = `
    <div class="v2-eco-kpi">
      <div class="v2-eco-kpi-label">Umsatz netto</div>
      <div class="v2-eco-kpi-value">${fmtEur(totals.revenue_net)}</div>
      <div class="v2-eco-kpi-sub">${periodLabel ? `${periodLabel} · ` : ''}${totals.qty} Einheiten</div>
    </div>
    <div class="v2-eco-kpi">
      <div class="v2-eco-kpi-label">Deckungsbeitrag</div>
      <div class="v2-eco-kpi-value">${fmtEur(totals.db_net)}</div>
      <div class="v2-eco-kpi-sub">nach Wareneinsatz</div>
    </div>
    <div class="v2-eco-kpi ${marginClass}">
      <div class="v2-eco-kpi-label">Marge</div>
      <div class="v2-eco-kpi-value">${fmtPct(marginPct)}</div>
      <div class="v2-eco-kpi-sub">DB / Umsatz</div>
    </div>`;
}

function renderTotalsBar(totals, timestamp) {
  const bar = document.querySelector('#ecoTotalsBar');
  bar.innerHTML = `
    <span class="v2-totals-item">
      <span class="v2-totals-label">Σ Umsatz</span>
      <span class="v2-totals-value">${fmtEur(totals.revenue_net)}</span>
    </span>
    <span class="v2-totals-sep" aria-hidden="true">·</span>
    <span class="v2-totals-item">
      <span class="v2-totals-label">Σ DB</span>
      <span class="v2-totals-value">${fmtEur(totals.db_net)}</span>
    </span>
    <span class="v2-totals-sep" aria-hidden="true">·</span>
    <span class="v2-totals-item">
      <span class="v2-totals-label">Σ Stück</span>
      <span class="v2-totals-value">${totals.qty}</span>
    </span>
    <span class="v2-totals-timestamp">Stand: ${timestamp}</span>`;
}

function renderProductTable(rows) {
  const tbody = document.querySelector('#ecoProductBody');
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="v2-kpi-empty">Keine Produkt-Daten für diesen Filter.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.product_name}</td>
      <td class="v2-kpi-num">${fmtEur(r.revenue_net)}</td>
      <td class="v2-kpi-num">${fmtEur(r.db_net)}</td>
      <td class="v2-kpi-num">${fmtPct(r.margin_pct)}</td>
      <td class="v2-kpi-num">${r.qty}</td>
    </tr>`).join('');
}

function renderSlotTable(rows) {
  const tbody = document.querySelector('#ecoSlotBody');
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="v2-kpi-empty">Keine Slot-Daten für diesen Filter.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.machine_id}</td>
      <td class="v2-kpi-num">${r.mdb_code}</td>
      <td class="v2-kpi-num">${fmtEur(r.revenue_net)}</td>
      <td class="v2-kpi-num">${fmtEur(r.db_net)}</td>
      <td class="v2-kpi-num">${r.qty}</td>
    </tr>`).join('');
}

async function loadEconomics() {
  const stateEl = document.querySelector('#ecoState');
  const contentEl = document.querySelector('#ecoContent');

  stateEl.hidden = false;
  contentEl.hidden = true;

  const machine = ecoState.machine.trim();
  const url = `/api/v2/economics?sort=${encodeURIComponent(ecoState.sortBy)}&order=${encodeURIComponent(ecoState.sortOrder)}&machine=${encodeURIComponent(machine)}&from=${encodeURIComponent(ecoState.month)}&to=${encodeURIComponent(ecoState.month)}`;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();

    if (!payload.ok || !payload.data) {
      stateEl.innerHTML = `<p style="padding:16px 0;color:var(--v2-error)">${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}</p>`;
      return;
    }

    renderHeroStrip(payload.data.totals, payload.data.period);
    renderProductTable(payload.data.byProduct);
    renderSlotTable(payload.data.bySlot);
    renderTotalsBar(payload.data.totals, payload.generatedAtDisplay);
    renderSortIndicators();

    stateEl.hidden = true;
    contentEl.hidden = false;
  } catch (err) {
    stateEl.innerHTML = `<p style="padding:16px 0;color:var(--v2-error)">API nicht erreichbar: ${err.message}</p>`;
  }
}

function initMonthSelector() {
  const select = document.querySelector('#ecoMonthSelect');
  if (!select) return;

  const current = currentBerlinMonth();
  const [y, m] = current.split('-').map(Number);

  for (let i = 0; i < 12; i++) {
    let month = m - i;
    let year = y;
    while (month <= 0) { month += 12; year -= 1; }
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const opt = document.createElement('option');
    opt.value = ym;
    opt.textContent = formatMonthLabel(ym);
    if (ym === ecoState.month) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    ecoState.month = select.value;
    loadEconomics();
  });
}

function initEconomics() {
  initMonthSelector();

  document.querySelectorAll('.v2-sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.sort === ecoState.sortBy) {
        ecoState.sortOrder = ecoState.sortOrder === 'desc' ? 'asc' : 'desc';
      } else {
        ecoState.sortBy = btn.dataset.sort;
        ecoState.sortOrder = 'desc';
      }
      loadEconomics();
    });
  });

  const machineInput = document.querySelector('#ecoMachineFilter');
  let debounce;
  machineInput.addEventListener('change', () => {
    clearTimeout(debounce);
    ecoState.machine = machineInput.value;
    debounce = setTimeout(loadEconomics, 400);
  });

  loadEconomics();
}

// ── Refill Drawer ────────────────────────────────────────────────────────────

const refillState = {
  step: 1,
  query: '',
  allSlots: null,
  selected: null,
  details: null,
  qty: 0,
};

function setRefillStep(step) {
  refillState.step = step;

  document.querySelector('#v2RefillStep1').hidden = step !== 1;
  document.querySelector('#v2RefillStep2').hidden = step !== 2;
  document.querySelector('#v2RefillStep3').hidden = step !== 3;

  const tabs = [
    document.querySelector('#v2StepTab1'),
    document.querySelector('#v2StepTab2'),
    document.querySelector('#v2StepTab3'),
  ];
  tabs.forEach((tab, i) => {
    tab.classList.remove('active', 'done');
    if (i + 1 === step) tab.classList.add('active');
    else if (i + 1 < step) tab.classList.add('done');
  });
}

function openRefillDrawer() {
  const backdrop = document.querySelector('#v2RefillBackdrop');
  const openBtn = document.querySelector('#v2RefillOpen');
  backdrop.hidden = false;
  openBtn.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
  setRefillStep(1);
  refillState.selected = null;
  refillState.details = null;
  refillState.qty = 0;
  const searchInput = document.querySelector('#v2RefillSearch');
  if (searchInput) {
    searchInput.value = '';
    setTimeout(() => searchInput.focus(), 240);
  }
  renderRefillResults([]);
}

function closeRefillDrawer() {
  const backdrop = document.querySelector('#v2RefillBackdrop');
  const openBtn = document.querySelector('#v2RefillOpen');
  backdrop.hidden = true;
  openBtn.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

async function fetchRefillSearch(query) {
  const resultsEl = document.querySelector('#v2RefillResults');
  if (!query || query.length < 2) {
    renderRefillResults([]);
    return;
  }

  resultsEl.innerHTML = '<div class="v2-refill-loading"><div class="v2-refill-skel"></div><div class="v2-refill-skel"></div></div>';

  try {
    const response = await fetch(`/api/v2/refill/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
    const payload = await response.json();
    renderRefillResults(payload.ok ? (payload.results || []) : []);
  } catch {
    renderRefillResults([]);
  }
}

function renderRefillResults(results) {
  const el = document.querySelector('#v2RefillResults');
  if (!results || !results.length) {
    const query = refillState.query;
    el.innerHTML = query.length >= 2
      ? '<div class="v2-refill-empty">Kein Slot gefunden für diese Suche.</div>'
      : '';
    return;
  }

  el.innerHTML = results.map((r, i) => `
    <button
      class="v2-refill-result-item"
      data-index="${i}"
      role="option"
      aria-selected="false"
      tabindex="0"
    >
      <div>
        <div class="v2-refill-result-name">${escapeHtml(r.product_name)}</div>
        <div class="v2-refill-result-sub">${escapeHtml(r.machine_label || r.machine_id)} · ${escapeHtml(r.location_name || '')} · MDB ${escapeHtml(String(r.mdb_code))}</div>
      </div>
      <span class="v2-refill-result-mdb">MDB ${escapeHtml(String(r.mdb_code))}</span>
    </button>
  `).join('');

  el.querySelectorAll('.v2-refill-result-item').forEach((btn, i) => {
    btn.addEventListener('click', () => selectRefillSlot(results[i]));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRefillSlot(results[i]); }
    });
  });
}

async function selectRefillSlot(slot) {
  refillState.selected = slot;
  setRefillStep(2);

  document.querySelector('#v2RefillSlotName').textContent = slot.product_name || '—';
  document.querySelector('#v2RefillSlotMeta').textContent =
    `${slot.machine_label || slot.machine_id} · MDB ${slot.mdb_code}`;

  document.querySelector('#v2RefillKpis').innerHTML =
    '<div class="v2-refill-skel" style="height:72px;grid-column:1/-1"></div>';
  document.querySelector('#v2RefillBatches').innerHTML =
    '<div class="v2-refill-skel" style="margin:10px"></div>';

  const qtyInput = document.querySelector('#v2RefillQty');
  qtyInput.value = '';
  document.querySelector('#v2RefillQtyNext').disabled = true;
  document.querySelector('#v2RefillQtyWarnings').innerHTML = '';

  try {
    const response = await fetch(
      `/api/v2/refill/details?machine_id=${encodeURIComponent(slot.machine_id)}&mdb_code=${encodeURIComponent(slot.mdb_code)}`,
      { cache: 'no-store' },
    );
    const payload = await response.json();
    if (payload.ok && payload.data) {
      refillState.details = payload.data;
      renderRefillDetails(payload.data);
    } else {
      document.querySelector('#v2RefillKpis').innerHTML =
        '<div class="v2-refill-empty" style="grid-column:1/-1">Details konnten nicht geladen werden.</div>';
    }
  } catch (err) {
    document.querySelector('#v2RefillKpis').innerHTML =
      `<div class="v2-refill-empty" style="grid-column:1/-1">API nicht erreichbar: ${escapeHtml(err.message)}</div>`;
  }
}

function kpiClass(val, warn, danger) {
  if (val <= danger) return 'v2-refill-kpi--empty';
  if (val <= warn) return 'v2-refill-kpi--warn';
  return 'v2-refill-kpi--ok';
}

function batchDateClass(daysLeft) {
  if (daysLeft <= 7) return 'critical';
  if (daysLeft <= 21) return 'warn';
  return '';
}

function renderRefillDetails(data) {
  const { slot, backstock, mhd_batches } = data;
  const freeCap = (slot.capacity || 0) - (slot.current_machine_qty || 0);

  document.querySelector('#v2RefillKpis').innerHTML = `
    <div class="v2-refill-kpi ${kpiClass(slot.current_machine_qty, slot.target_stock * 0.4, 0)}">
      <div class="v2-refill-kpi-label">Im Automaten</div>
      <div class="v2-refill-kpi-value">${slot.current_machine_qty}</div>
      <div class="v2-refill-kpi-sub">Ziel: ${slot.target_stock || '—'}</div>
    </div>
    <div class="v2-refill-kpi ${freeCap <= 0 ? 'v2-refill-kpi--empty' : freeCap < 3 ? 'v2-refill-kpi--warn' : 'v2-refill-kpi--ok'}">
      <div class="v2-refill-kpi-label">Freie Kapaz.</div>
      <div class="v2-refill-kpi-value">${Math.max(0, freeCap)}</div>
      <div class="v2-refill-kpi-sub">max. ${slot.capacity || '—'}</div>
    </div>
    <div class="v2-refill-kpi ${backstock.total_qty <= 0 ? 'v2-refill-kpi--empty' : 'v2-refill-kpi--ok'}">
      <div class="v2-refill-kpi-label">Backstock</div>
      <div class="v2-refill-kpi-value">${backstock.total_qty}</div>
      <div class="v2-refill-kpi-sub">${backstock.batches_count} Charge${backstock.batches_count !== 1 ? 'n' : ''}</div>
    </div>
  `;

  const batchesEl = document.querySelector('#v2RefillBatches');
  if (!mhd_batches || !mhd_batches.length) {
    batchesEl.innerHTML = '<div class="v2-refill-no-batches">Keine Chargen mit MHD-Datum vorhanden.</div>';
  } else {
    batchesEl.innerHTML = mhd_batches.map((b) => {
      const cls = batchDateClass(b.days_until_mhd);
      return `
        <div class="v2-refill-batch-row">
          <span class="v2-refill-batch-date v2-refill-batch-date--${cls}">${escapeHtml(b.mhd_date)}</span>
          <span class="v2-refill-batch-qty">${escapeHtml(String(b.remaining_qty))} Stk.</span>
          <span class="v2-refill-batch-days v2-refill-batch-days--${cls}">${b.days_until_mhd >= 0 ? `${b.days_until_mhd} T.` : 'abgelaufen'}</span>
        </div>`;
    }).join('');
  }
}

function validateQtyLive(qty) {
  const details = refillState.details;
  const warnings = [];
  const errors = [];

  if (!qty || qty <= 0) {
    errors.push('Menge muss mindestens 1 sein.');
  }
  if (details) {
    const freeCap = (details.slot.capacity || 0) - (details.slot.current_machine_qty || 0);
    if (qty > freeCap) {
      warnings.push(`Übersteigt freie Kapazität (${freeCap} frei). Das kann trotzdem gespeichert werden.`);
    }
    if (details.backstock.total_qty <= 0) {
      warnings.push('Kein Backstock verfügbar — Waren vorhanden?');
    }
    if (qty > details.backstock.total_qty && details.backstock.total_qty > 0) {
      warnings.push(`Menge übersteigt Backstock (${details.backstock.total_qty} Stk. verfügbar).`);
    }
  }

  const warningsEl = document.querySelector('#v2RefillQtyWarnings');
  const nextBtn = document.querySelector('#v2RefillQtyNext');
  const qtyInput = document.querySelector('#v2RefillQty');

  if (errors.length) {
    qtyInput.classList.add('invalid');
    nextBtn.disabled = true;
  } else {
    qtyInput.classList.remove('invalid');
    nextBtn.disabled = false;
  }

  warningsEl.innerHTML = [
    ...errors.map((e) => `<div class="v2-refill-warn-item v2-refill-warn-item--error"><i class="v2-refill-warn-icon">✕</i>${escapeHtml(e)}</div>`),
    ...warnings.map((w) => `<div class="v2-refill-warn-item v2-refill-warn-item--warn"><i class="v2-refill-warn-icon">!</i>${escapeHtml(w)}</div>`),
  ].join('');

  return errors.length === 0;
}

function goToConfirm() {
  const qty = parseInt(document.querySelector('#v2RefillQty').value, 10);
  if (!validateQtyLive(qty)) return;

  refillState.qty = qty;
  const slot = refillState.selected;

  document.querySelector('#v2RefillSummary').innerHTML = `
    <p class="v2-refill-summary-title">Zusammenfassung</p>
    <div class="v2-refill-summary-row">
      <span class="v2-refill-summary-key">Produkt</span>
      <span class="v2-refill-summary-val">${escapeHtml(slot.product_name)}</span>
    </div>
    <div class="v2-refill-summary-row">
      <span class="v2-refill-summary-key">Automat / MDB</span>
      <span class="v2-refill-summary-val">${escapeHtml(slot.machine_label || slot.machine_id)} · MDB ${escapeHtml(String(slot.mdb_code))}</span>
    </div>
    <div class="v2-refill-summary-row">
      <span class="v2-refill-summary-key">Menge</span>
      <span class="v2-refill-summary-val">${qty} Stück</span>
    </div>
  `;

  document.querySelector('#v2RefillResultBox').classList.remove('visible');
  document.querySelector('#v2RefillConfirm').disabled = false;
  document.querySelector('#v2RefillConfirmLabel').textContent = 'Jetzt nachfüllen';
  setRefillStep(3);
}

async function confirmRefill() {
  const btn = document.querySelector('#v2RefillConfirm');
  const label = document.querySelector('#v2RefillConfirmLabel');
  const resultBox = document.querySelector('#v2RefillResultBox');
  const slot = refillState.selected;

  btn.disabled = true;
  btn.classList.add('v2-refill-confirm-btn--loading');
  label.textContent = 'Wird übermittelt …';
  resultBox.classList.remove('visible');

  try {
    const response = await fetch('/api/v2/refill/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: slot.machine_id,
        mdb_code: slot.mdb_code,
        product_id: slot.product_id,
        product_name: slot.product_name,
        qty: refillState.qty,
      }),
    });

    const payload = await response.json();
    btn.classList.remove('v2-refill-confirm-btn--loading');

    if (response.ok && payload.ok) {
      label.textContent = '✓ Übermittelt';
      resultBox.className = 'v2-refill-result-box v2-refill-result-box--ok visible';
      resultBox.innerHTML = `
        <div class="v2-refill-result-title">Nachfüllung erfolgreich übermittelt</div>
        <div>Der WF7-Workflow wurde gestartet. Bitte trage die Nachfüllung im Automaten ein.</div>
        ${payload.status_ref ? `<div class="v2-refill-result-ref">Ref: ${escapeHtml(payload.status_ref)}</div>` : ''}
      `;
    } else if (response.status === 403) {
      label.textContent = 'Nicht erlaubt';
      resultBox.className = 'v2-refill-result-box v2-refill-result-box--error visible';
      resultBox.innerHTML = '<div class="v2-refill-result-title">Keine Berechtigung</div><div>Read-Only-Benutzer dürfen keine Nachfüllung auslösen.</div>';
      btn.disabled = false;
    } else {
      label.textContent = 'Fehler – erneut versuchen';
      resultBox.className = 'v2-refill-result-box v2-refill-result-box--error visible';
      resultBox.innerHTML = `
        <div class="v2-refill-result-title">Übermittlung fehlgeschlagen</div>
        <div>${escapeHtml(payload.error?.message || 'Unbekannter Fehler')}</div>
      `;
      btn.disabled = false;
    }
  } catch (err) {
    btn.classList.remove('v2-refill-confirm-btn--loading');
    label.textContent = 'Fehler – erneut versuchen';
    resultBox.className = 'v2-refill-result-box v2-refill-result-box--error visible';
    resultBox.innerHTML = `<div class="v2-refill-result-title">API nicht erreichbar</div><div>${escapeHtml(err.message)}</div>`;
    btn.disabled = false;
  }
}

function initRefillDrawer() {
  document.querySelector('#v2RefillOpen').addEventListener('click', openRefillDrawer);
  document.querySelector('#v2RefillClose').addEventListener('click', closeRefillDrawer);
  document.querySelector('#v2RefillBackdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRefillDrawer();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('#v2RefillBackdrop').hidden) {
      closeRefillDrawer();
    }
  });

  document.querySelector('#v2RefillBack').addEventListener('click', () => setRefillStep(1));
  document.querySelector('#v2RefillBackToDetails').addEventListener('click', () => setRefillStep(2));
  document.querySelector('#v2RefillConfirm').addEventListener('click', confirmRefill);
  document.querySelector('#v2RefillQtyNext').addEventListener('click', goToConfirm);

  const searchInput = document.querySelector('#v2RefillSearch');
  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    refillState.query = searchInput.value;
    searchDebounce = setTimeout(() => fetchRefillSearch(refillState.query), 250);
  });

  const qtyInput = document.querySelector('#v2RefillQty');
  qtyInput.addEventListener('input', () => {
    const qty = parseInt(qtyInput.value, 10);
    refillState.qty = qty;
    validateQtyLive(qty);
  });
  qtyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToConfirm();
  });
}

loadV2Overview();
loadMonitoring();
initUploads();
initInventoryMhd();
initAssortmentSlots();
initEconomics();
initRefillDrawer();
loadMachineProfiles();

/* ═══════════════════════════════════════════════════════════════════════════
   Slot-Change Drawer
   ═══════════════════════════════════════════════════════════════════════════ */
(function initSlotChangeDrawer() {
  'use strict';

  let _slot = null;
  let _searchTimer = null;

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }

  function openSlotChangeDrawer() {
    const backdrop = $('v2SlotChangeBackdrop');
    if (!backdrop) return;
    backdrop.hidden = false;
    $('v2SlotChangeOpen')?.setAttribute('aria-expanded', 'true');
    showSlotChangeStep(1);
    _slot = null;
    const search = $('v2ScSearch');
    if (search) { search.value = ''; search.focus(); }
    const results = $('v2ScResults');
    if (results) results.innerHTML = '';
  }

  function closeSlotChangeDrawer() {
    const backdrop = $('v2SlotChangeBackdrop');
    if (!backdrop) return;
    backdrop.hidden = true;
    $('v2SlotChangeOpen')?.setAttribute('aria-expanded', 'false');
    _slot = null;
  }

  function showSlotChangeStep(n) {
    [1, 2, 3, 4].forEach((i) => {
      const step = $(`v2SlotChangeStep${i}`);
      const tab  = $(`v2ScStepTab${i}`);
      if (step) step.hidden = i !== n;
      if (tab)  { tab.classList.toggle('active', i === n); tab.classList.toggle('done', i < n); }
    });
  }

  function handleSlotChangeSearch() {
    const q = ($('v2ScSearch')?.value ?? '').trim();
    const resultsEl = $('v2ScResults');
    if (!resultsEl) return;
    if (q.length < 2) { resultsEl.innerHTML = ''; return; }
    resultsEl.innerHTML = '<p class="v2-sc-hint">Suche läuft…</p>';
    fetch(`/api/v2/refill/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok || !data.results?.length) {
          resultsEl.innerHTML = '<p class="v2-sc-hint">Keine Slots gefunden.</p>';
          return;
        }
        resultsEl.innerHTML = data.results.map((s) => `
          <div class="v2-sc-result-item" role="option" tabindex="0"
            data-sid="${esc(s.slot_assignment_id ?? '')}"
            data-machine="${esc(s.machine_id)}"
            data-mdb="${esc(s.mdb_code)}"
            data-pid="${esc(s.product_id)}"
            data-pname="${esc(s.product_name)}"
            data-mlabel="${esc(s.machine_label || s.machine_id)}"
            data-loc="${esc(s.location_name || '')}"
            data-qty="${s.current_machine_qty ?? 0}"
            data-cap="${s.capacity ?? s.target_stock ?? 0}">
            <div class="v2-sc-result-name">${esc(s.product_name)}</div>
            <div class="v2-sc-result-sub">${esc(s.machine_label || s.machine_id)} · MDB ${esc(s.mdb_code)} · ${esc(s.location_name || '')}</div>
          </div>`).join('');
        resultsEl.querySelectorAll('.v2-sc-result-item').forEach((el) => {
          el.addEventListener('click', () => onSlotSelect(el));
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onSlotSelect(el); });
        });
      })
      .catch(() => { resultsEl.innerHTML = '<p class="v2-sc-hint">Fehler bei der Suche.</p>'; });
  }

  function onSlotSelect(el) {
    _slot = {
      slot_assignment_id: el.dataset.sid || null,
      machine_id: el.dataset.machine,
      mdb_code: el.dataset.mdb,
      product_id: el.dataset.pid,
      product_name: el.dataset.pname,
      machine_label: el.dataset.mlabel,
      location_name: el.dataset.loc,
      current_machine_qty: Number(el.dataset.qty),
      capacity: Number(el.dataset.cap),
    };
    loadStep2();
  }

  function loadStep2() {
    if (!_slot) return;
    showSlotChangeStep(2);
    renderCurrentCard();
    const dateInput = $('v2ScStartDate');
    if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
    const isAdmin = !!window.v2IsAdmin;
    const notice = $('v2ScReadonlyNotice');
    const nextBtn = $('v2ScToStep3');
    if (notice) notice.hidden = isAdmin;
    if (!isAdmin && nextBtn) nextBtn.disabled = true;
    const productSel = $('v2ScProductSelect');
    if (productSel) productSel.innerHTML = '<option value="">Lade Produkte…</option>';
    const params = _slot.slot_assignment_id
      ? `slot_assignment_id=${encodeURIComponent(_slot.slot_assignment_id)}`
      : `machine_id=${encodeURIComponent(_slot.machine_id)}&mdb_code=${encodeURIComponent(_slot.mdb_code)}`;
    fetch(`/api/v2/slot-change/preview?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (!productSel) return;
        if (!data.ok || !data.products?.length) {
          productSel.innerHTML = '<option value="">Keine Produkte verfügbar</option>';
          return;
        }
        productSel.innerHTML = '<option value="">— Produkt wählen —</option>'
          + data.products.map((p) => `<option value="${esc(p.product_id)}">${esc(p.name)}</option>`).join('');
        validateStep2();
      })
      .catch(() => { if (productSel) productSel.innerHTML = '<option value="">Fehler beim Laden</option>'; });
    validateStep2();
  }

  function renderCurrentCard() {
    const card = $('v2ScCurrentSlot');
    if (!card || !_slot) return;
    card.innerHTML = `
      <div class="v2-sc-card-product">${esc(_slot.product_name)}</div>
      <div class="v2-sc-card-meta">${esc(_slot.machine_label)} · MDB ${esc(_slot.mdb_code)} · ${esc(_slot.location_name)}${_slot.current_machine_qty != null ? ` · ${_slot.current_machine_qty} / ${_slot.capacity || '?'} Stk.` : ''}</div>`;
  }

  function validateStep2() {
    const nextBtn = $('v2ScToStep3');
    if (!nextBtn || !window.v2IsAdmin) return;
    const prod = $('v2ScProductSelect')?.value;
    const qty  = $('v2ScNewQty')?.value;
    const date = $('v2ScStartDate')?.value;
    nextBtn.disabled = !prod || !date || qty === '' || Number(qty) < 0;
  }

  function buildConfirmSummary() {
    const sel     = $('v2ScProductSelect');
    const newName = sel?.options[sel.selectedIndex]?.text || '—';
    const newQty  = $('v2ScNewQty')?.value || '—';
    const date    = $('v2ScStartDate')?.value || '—';
    const el      = $('v2ScConfirmSummary');
    if (!el || !_slot) return;
    el.innerHTML = `
      <div class="v2-sc-change-row">
        <div class="v2-sc-change-before">
          <div class="v2-sc-change-product">${esc(_slot.product_name)}</div>
          <div class="v2-sc-change-meta">${_slot.current_machine_qty} Stk. aktuell</div>
        </div>
        <div class="v2-sc-change-arrow">→</div>
        <div class="v2-sc-change-after">
          <div class="v2-sc-change-product">${esc(newName)}</div>
          <div class="v2-sc-change-meta">${esc(newQty)} Stk. ab Start</div>
        </div>
      </div>
      <div class="v2-sc-confirm-detail">
        ${esc(_slot.machine_label)} · MDB ${esc(_slot.mdb_code)} · ${esc(_slot.location_name)}<br>
        Startdatum: <strong>${esc(date)}</strong>
      </div>`;
  }

  async function handleSlotChangeConfirm() {
    if (!_slot || !window.v2IsAdmin) return;
    const confirmBtn = $('v2ScConfirmBtn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Wird übertragen…'; }
    const newProductId = $('v2ScProductSelect')?.value;
    const newQty       = Number($('v2ScNewQty')?.value);
    const startDate    = $('v2ScStartDate')?.value;
    let data;
    try {
      const res = await fetch('/api/v2/slot-change/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot_assignment_id: _slot.slot_assignment_id,
          machine_id: _slot.machine_id,
          mdb_code: _slot.mdb_code,
          new_product_id: newProductId,
          new_qty: newQty,
          start_date: startDate,
        }),
      });
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: { message: err.message } };
    }
    showSlotChangeStep(4);
    const resultEl = $('v2ScResultMsg');
    if (!resultEl) return;
    if (data.ok) {
      resultEl.className = 'v2-sc-result-card is-success';
      resultEl.innerHTML = `<div class="v2-sc-result-icon">✓</div><div class="v2-sc-result-title">Produktwechsel registriert</div><div>${esc(data.message || 'Wechsel erfolgreich übertragen.')}</div>${data.status_ref ? `<div class="v2-sc-result-ref">Ref: ${esc(data.status_ref)}</div>` : ''}`;
    } else {
      resultEl.className = 'v2-sc-result-card is-error';
      resultEl.innerHTML = `<div class="v2-sc-result-icon">✗</div><div class="v2-sc-result-title">Fehler beim Wechsel</div><div>${esc(data.error?.message || 'Unbekannter Fehler.')}</div>`;
    }
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Wechsel durchführen'; }
  }

  $('v2SlotChangeOpen')?.addEventListener('click', openSlotChangeDrawer);
  $('v2SlotChangeClose')?.addEventListener('click', closeSlotChangeDrawer);
  $('v2SlotChangeBackdrop')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSlotChangeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('v2SlotChangeBackdrop')?.hidden) closeSlotChangeDrawer(); });

  $('v2ScSearch')?.addEventListener('input', () => { clearTimeout(_searchTimer); _searchTimer = setTimeout(handleSlotChangeSearch, 260); });
  $('v2ScBack')?.addEventListener('click', () => showSlotChangeStep(1));
  $('v2ScBackFromStep3')?.addEventListener('click', () => showSlotChangeStep(2));
  $('v2ScDoneBtn')?.addEventListener('click', closeSlotChangeDrawer);
  $('v2ScProductSelect')?.addEventListener('change', validateStep2);
  $('v2ScNewQty')?.addEventListener('input', validateStep2);
  $('v2ScStartDate')?.addEventListener('change', validateStep2);
  $('v2ScToStep3')?.addEventListener('click', () => { buildConfirmSummary(); showSlotChangeStep(3); });
  $('v2ScConfirmBtn')?.addEventListener('click', handleSlotChangeConfirm);
})();

// ── Product Onboarding ───────────────────────────────────────────────────────

(function initOnboarding() {
  const esc = escapeHtml;

  const STATUS_META = {
    intern_erstellt:  { label: 'Intern erstellt',  sub: 'Noch keine Nayax-Zuordnung',   cls: 'intern_erstellt' },
    bereit_fur_moma:  { label: 'Bereit für Moma',  sub: 'Hat interne Aliasse',           cls: 'bereit_fur_moma' },
    slot_offen:       { label: 'Slot-Zuordnung offen', sub: 'In Nayax, kein aktiver Slot', cls: 'slot_offen' },
    verkaufsbereit:   { label: 'Verkaufsbereit',   sub: 'Hat aktiven Slot',              cls: 'verkaufsbereit' },
  };

  function setPipelineBadge(id, count, pending) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count != null ? String(count) : '—';
    const stageEl = el.closest('.v2-ob-stage');
    if (stageEl) {
      stageEl.classList.toggle('v2-ob-stage--pending', pending && count > 0);
    }
  }

  function animateConnectors(data) {
    const connectors = document.querySelectorAll('.v2-ob-connector');
    const hasPendingApprovals = (data.pending_approvals || []).length > 0;
    const hasMoma = (data.products_by_status?.bereit_fur_moma || []).length > 0;
    const hasSlotOffen = (data.products_by_status?.slot_offen || []).length > 0;
    // connectors: [wf1→approval, approval→moma, moma→slot, slot→ready]
    if (connectors[0]) connectors[0].classList.toggle('v2-ob-connector--active', hasPendingApprovals);
    if (connectors[1]) connectors[1].classList.toggle('v2-ob-connector--active', hasMoma);
    if (connectors[2]) connectors[2].classList.toggle('v2-ob-connector--active', hasSlotOffen);
  }

  function renderApprovalList(approvals, wf2Url, isAdmin) {
    const list = document.getElementById('obApprovalList');
    const badge = document.getElementById('obApprovalCount');
    if (!list) return;

    if (badge) badge.textContent = String(approvals.length);

    if (!approvals.length) {
      list.innerHTML = '<div class="v2-ob-empty">Keine offenen Freigaben – alles bearbeitet.</div>';
      return;
    }

    list.innerHTML = approvals.map((item) => {
      const btnHtml = wf2Url
        ? `<a class="v2-ob-approval-btn${isAdmin ? '' : ' v2-ob-approval-btn--readonly'}" href="${esc(wf2Url)}" target="_blank" rel="noopener noreferrer" ${isAdmin ? '' : 'aria-disabled="true" tabindex="-1"'}>WF2 öffnen ↗</a>`
        : `<span class="v2-ob-approval-btn v2-ob-approval-btn--readonly">WF2 nicht konfiguriert</span>`;
      return `
        <div class="v2-ob-approval-row" role="listitem">
          <div class="v2-ob-approval-main">
            <div class="v2-ob-approval-title">Rechnung ${esc(item.invoice_number || item.invoice_key)}</div>
            <div class="v2-ob-approval-meta">
              <span>${esc(item.supplier_name || '—')}</span>
              <span>${esc(item.invoice_date || '—')}</span>
              <span class="v2-ob-approval-badge">${esc(String(item.open_items))} offen</span>
            </div>
          </div>
          ${btnHtml}
        </div>`;
    }).join('');
  }

  function renderUnknownList(unknowns) {
    const list = document.getElementById('obUnknownList');
    const badge = document.getElementById('obUnknownCount');
    if (!list) return;

    if (badge) badge.textContent = String(unknowns.length);

    if (!unknowns.length) {
      list.innerHTML = '<div class="v2-ob-empty">Keine unbekannten Nayax-Produkte.</div>';
      return;
    }

    list.innerHTML = unknowns.map((item) => `
      <div class="v2-ob-unknown-row" role="listitem">
        <div>
          <div class="v2-ob-unknown-key">${esc(item.product_key || item.nayax_product_name || '—')}</div>
          <div class="v2-ob-unknown-hint">Produkt anlegen via WF1/WF2</div>
        </div>
        <span class="v2-ob-unknown-tx">${esc(String(item.tx_count))} Tx</span>
      </div>`).join('');
  }

  function renderStatusGrid(productsByStatus) {
    const grid = document.getElementById('obStatusGrid');
    if (!grid) return;

    const order = ['intern_erstellt', 'bereit_fur_moma', 'slot_offen', 'verkaufsbereit'];
    grid.innerHTML = order.map((key) => {
      const meta = STATUS_META[key];
      const products = productsByStatus?.[key] || [];
      return `
        <div class="v2-ob-status-card v2-ob-status-card--${esc(meta.cls)}">
          <div class="v2-ob-status-label">${esc(meta.label)}</div>
          <div class="v2-ob-status-count">${products.length}</div>
          <div class="v2-ob-status-sublabel">${esc(meta.sub)}</div>
        </div>`;
    }).join('');
  }

  function renderOnboarding(data, wf2Url, isAdmin) {
    const byStatus = data.products_by_status || {};

    // Pipeline badges
    setPipelineBadge('obBadgeWf1',      data.total_invoices ?? 0,            false);
    setPipelineBadge('obBadgeApproval', (data.pending_approvals || []).length, true);
    setPipelineBadge('obBadgeMoma',     (byStatus.bereit_fur_moma || []).length, true);
    setPipelineBadge('obBadgeSlot',     (byStatus.slot_offen || []).length,     true);
    setPipelineBadge('obBadgeReady',    (byStatus.verkaufsbereit || []).length, false);

    animateConnectors(data);
    renderApprovalList(data.pending_approvals || [], wf2Url, isAdmin);
    renderUnknownList(data.unknown_products || []);
    renderStatusGrid(byStatus);

    const content = document.getElementById('onboardingContent');
    if (content) content.hidden = false;
  }

  async function loadOnboarding() {
    const stateEl = document.getElementById('onboardingState');
    try {
      const response = await fetch('/api/v2/onboarding', { cache: 'no-store' });
      const payload = await response.json();

      if (!payload.ok || !payload.data) {
        if (stateEl) stateEl.textContent = `${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}`;
        return;
      }

      if (stateEl) {
        stateEl.textContent = payload.generatedAtDisplay
          ? `Stand: ${payload.generatedAtDisplay}`
          : 'Daten geladen.';
      }

      renderOnboarding(
        payload.data,
        payload.data.wf2_form_url || '',
        payload.data.is_admin || false,
      );
    } catch (err) {
      if (stateEl) stateEl.textContent = `FEHLER: API nicht erreichbar: ${err.message}`;
    }
  }

  loadOnboarding();
}());

// ── CSV Export ────────────────────────────────────────────────────────────────
(function () {
  const btn = document.getElementById('csvExportBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const monthSelect = document.getElementById('ecoMonthSelect');
    const month = monthSelect ? monthSelect.value : new Date().toISOString().slice(0, 7);
    const url = `/api/v2/reports/export?format=csv&from=${encodeURIComponent(month)}&to=${encodeURIComponent(month)}`;

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        const data = await response.json();
        alert(`Export fehlgeschlagen: ${data.error?.message || response.status}`);
        return;
      }
      const blob = await response.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `kpi-bericht-${month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(`Export fehlgeschlagen: ${err.message}`);
    }
  });
}());

// ── Locations Panel ───────────────────────────────────────────────────────────
(function () {
  async function loadLocations() {
    const stateEl = document.getElementById('locationsState');
    const contentEl = document.getElementById('locationsContent');
    const bodyEl = document.getElementById('locationsBody');

    try {
      const response = await fetch('/api/v2/locations', { cache: 'no-store' });
      const payload = await response.json();

      if (!payload.ok || !payload.data) {
        if (stateEl) stateEl.textContent = `${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}`;
        return;
      }

      if (stateEl) stateEl.textContent = '';
      if (contentEl) contentEl.hidden = false;

      if (bodyEl) {
        bodyEl.innerHTML = payload.data.map((loc) => {
          const kpis = loc.kpis;
          return `<tr>
            <td>${loc.name}</td>
            <td>${loc.status}</td>
            <td>${(loc.machine_ids || []).join(', ') || '—'}</td>
            <td>${kpis ? kpis.revenue_net.toFixed(2) + ' €' : '—'}</td>
            <td>${kpis ? kpis.db_net.toFixed(2) + ' €' : '—'}</td>
            <td>${kpis ? kpis.margin_pct.toFixed(1) + ' %' : '—'}</td>
            <td>${kpis ? kpis.qty : '—'}</td>
          </tr>`;
        }).join('');
      }
    } catch (err) {
      if (stateEl) stateEl.textContent = `FEHLER: ${err.message}`;
    }
  }

  loadLocations();
}());

// ── Correction Cases ──────────────────────────────────────────────────────────

(function initCorrectionCases() {
  const panel  = document.getElementById('correctionCases');
  const state  = document.getElementById('correctionState');
  const body   = document.getElementById('correctionBody');
  const badge  = document.getElementById('correctionBadge');
  if (!panel) return;

  const TYPE_META = {
    mdb_proposal:       { label: 'MDB-Mismatch', cls: 'proposal',  icon: '⇄' },
    unknown_product:    { label: 'Unbekannt',     cls: 'unknown',   icon: '?' },
    correction_warning: { label: 'Warnung',       cls: 'warning-c', icon: '!' },
  };

  function formatDate(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildHint(c) {
    if (c.case_type === 'mdb_proposal' && c.wf4_auto_start) {
      return `<div class="cc-hint cc-hint--green"><span class="cc-hint-icon">✓</span><span>WF4 hat automatisch einen Korrekturvorschlag erstellt.</span></div>`;
    }
    if (c.case_type === 'unknown_product') {
      return `<div class="cc-hint cc-hint--amber"><span class="cc-hint-icon">⚑</span><span>Produkt noch nicht im System – Onboarding erforderlich.</span></div>`;
    }
    return '';
  }

  function buildDetailFields(c) {
    const fields = [];
    if (c.machine_id)           fields.push(['Automat',   `<span class="cc-field-value cc-field-value--mono">${esc(c.machine_id)}</span>`]);
    if (c.mdb_code != null)     fields.push(['MDB-Slot',  `<span class="cc-field-value cc-field-value--mono">${esc(c.mdb_code)}</span>`]);
    if (c.expected_product)     fields.push(['Erwartet',  `<span class="cc-field-value">${esc(c.expected_product)}</span>`]);
    if (c.suggested_product_name) fields.push(['Vorschlag', `<span class="cc-field-value">${esc(c.suggested_product_name)}</span>`]);
    if (c.product_key)          fields.push(['Nayax-Key', `<span class="cc-field-value cc-field-value--mono">${esc(c.product_key)}</span>`]);
    if (c.warning_type)         fields.push(['Typ',       `<span class="cc-field-value cc-field-value--mono">${esc(c.warning_type)}</span>`]);
    const txCls = (c.affected_tx_count > 0) ? ' cc-tx-count--nonzero' : '';
    fields.push(['Transaktionen', `<span class="cc-field-value${txCls}">${esc(c.affected_tx_count ?? 0)}</span>`]);
    if (c.created_at)           fields.push(['Erstellt',  `<span class="cc-field-value">${formatDate(c.created_at)}</span>`]);
    return fields.map(([label, val]) => `<div><p class="cc-field-label">${esc(label)}</p>${val}</div>`).join('');
  }

  function buildCaseItem(c, idx, isAdmin) {
    const meta   = TYPE_META[c.case_type] || TYPE_META.correction_warning;
    const txCls  = (c.affected_tx_count > 0) ? ' cc-tx-count--nonzero' : '';
    const txBadge = c.affected_tx_count > 0 ? `<span class="cc-tx-count${txCls}">${esc(c.affected_tx_count)} Tx</span>` : '';
    const fixBtn = isAdmin
      ? `<button class="cc-fix-btn" data-action="fix" data-case-id="${esc(c.case_id)}" aria-label="Fall beheben">Beheben ▶</button>`
      : '';
    return `<li class="cc-item cc-item--${meta.cls}" style="--cc-i:${idx}" data-case-id="${esc(c.case_id)}">
      <button class="cc-trigger" aria-expanded="false" aria-controls="cc-detail-${esc(c.case_id)}">
        <span class="cc-chip cc-chip--${meta.cls}">${esc(meta.icon)} ${esc(meta.label)}</span>
        <span class="cc-summary">${esc(c.nayax_report || c.message || '–')}</span>
        <span class="cc-meta">
          <span class="cc-date">${formatDate(c.created_at)}</span>
          ${txBadge}
          ${fixBtn}
          <span class="cc-chevron">▾</span>
        </span>
      </button>
      <div class="cc-detail" id="cc-detail-${esc(c.case_id)}" role="region" aria-hidden="true">
        <div class="cc-detail-inner">
          <button class="cc-close" aria-label="Schließen" title="Schließen">✕</button>
          <div class="cc-fields">${buildDetailFields(c)}</div>
          ${buildHint(c)}
        </div>
      </div>
    </li>`;
  }

  function renderEmpty() {
    body.innerHTML = `<div class="cc-empty">
      <div class="cc-empty-icon">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <polyline points="4,12 9,17 18,7" stroke="var(--color-success,#16a34a)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
      </div>
      <p class="cc-empty-text">Keine offenen Fälle – alles in Ordnung</p>
    </div>`;
  }

  function expandItem(item) {
    item.setAttribute('data-open', '');
    const trigger = item.querySelector('.cc-trigger');
    const detail  = item.querySelector('.cc-detail');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (detail)  detail.setAttribute('aria-hidden', 'false');
  }

  function collapseItem(item) {
    item.removeAttribute('data-open');
    const trigger = item.querySelector('.cc-trigger');
    const detail  = item.querySelector('.cc-detail');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (detail)  detail.setAttribute('aria-hidden', 'true');
  }

  let _casesData = [];

  function renderCases(data) {
    const { cases, counts } = data;
    const isAdmin = !!data.is_admin;
    _casesData = cases;

    badge.removeAttribute('hidden');
    badge.textContent = counts.total;
    badge.className = counts.total === 0 ? 'cc-badge cc-badge--ok' : 'cc-badge amber-pulse';

    if (counts.total === 0) { renderEmpty(); return; }

    const groups = [
      { items: cases.filter((c) => c.case_type === 'mdb_proposal'),       label: 'MDB-Abweichungen' },
      { items: cases.filter((c) => c.case_type === 'unknown_product'),    label: 'Unbekannte Produkte' },
      { items: cases.filter((c) => c.case_type === 'correction_warning'), label: 'Warnungen' },
    ].filter((g) => g.items.length > 0);

    let idx = 0;
    let html = '';
    for (const g of groups) {
      if (groups.length > 1) html += `<p class="cc-section-label">${esc(g.label)}</p>`;
      html += '<ul class="cc-list">';
      for (const c of g.items) html += buildCaseItem(c, idx++, isAdmin);
      html += '</ul>';
    }
    body.innerHTML = html;

    body.addEventListener('click', (e) => {
      const fixBtn = e.target.closest('[data-action="fix"]');
      if (fixBtn) {
        e.stopPropagation();
        const caseId = fixBtn.dataset.caseId;
        const caseData = _casesData.find((c) => c.case_id === caseId) || { case_id: caseId };
        if (typeof window.openCorrectionDrawer === 'function') window.openCorrectionDrawer(caseData);
        return;
      }
      const closeBtn = e.target.closest('.cc-close');
      if (closeBtn) { const item = closeBtn.closest('.cc-item'); if (item) collapseItem(item); return; }
      const trigger = e.target.closest('.cc-trigger');
      if (!trigger) return;
      const item = trigger.closest('.cc-item');
      if (!item) return;
      const isOpen = item.hasAttribute('data-open');
      body.querySelectorAll('.cc-item[data-open]').forEach(collapseItem);
      if (!isOpen) expandItem(item);
    });
  }

  async function loadCorrectionCases() {
    state.textContent = 'Lade Korrekturfälle …';
    state.removeAttribute('hidden');
    body.setAttribute('hidden', '');
    try {
      const res  = await fetch('/api/v2/correction-cases');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Fehler beim Laden');
      state.setAttribute('hidden', '');
      body.removeAttribute('hidden');
      renderCases(data);
    } catch (err) {
      state.textContent = `Korrekturfälle konnten nicht geladen werden: ${err.message}`;
    }
  }

  loadCorrectionCases();
  window._reloadCorrectionCases = loadCorrectionCases;
}());

/* ═══════════════════════════════════════════════════════════════════════════
   Correction Action Drawer
   ═══════════════════════════════════════════════════════════════════════════ */

(function initCorrectionActionDrawer() {
  const backdrop   = document.getElementById('v2CaBackdrop');
  const caseIdEl   = document.getElementById('v2CaCaseId');
  const loadingEl  = document.getElementById('v2CaLoading');
  const contentEl  = document.getElementById('v2CaContent');
  const infoGrid   = document.getElementById('v2CaInfoGrid');
  const suggestWrap= document.getElementById('v2CaSuggestWrap');
  const suggestName= document.getElementById('v2CaSuggestName');
  const productSel = document.getElementById('v2CaProductSelect');
  const confirmBtn = document.getElementById('v2CaConfirmBtn');
  const btnText    = confirmBtn?.querySelector('.v2-ca-btn-text');
  const btnSpinner = confirmBtn?.querySelector('.v2-ca-btn-spinner');
  const cancelBtn  = document.getElementById('v2CaCancel');
  const closeBtn   = document.getElementById('v2CaClose');
  const errorEl    = document.getElementById('v2CaError');
  const successEl  = document.getElementById('v2CaSuccess');
  const successMsg = document.getElementById('v2CaSuccessMsg');
  if (!backdrop) return;

  let _currentCase = null;
  let _pending = false;

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showLoading() {
    loadingEl.removeAttribute('hidden');
    contentEl.setAttribute('hidden', '');
  }

  function showContent() {
    loadingEl.setAttribute('hidden', '');
    contentEl.removeAttribute('hidden');
  }

  function setPending(on) {
    _pending = on;
    confirmBtn.disabled = on;
    if (btnText)    btnText.hidden    = on;
    if (btnSpinner) btnSpinner.hidden = !on;
  }

  function showError(msg) {
    errorEl.textContent = `${msg}  Bitte erneut versuchen oder Drawer schließen.`;
    errorEl.removeAttribute('hidden');
    errorEl.classList.remove('v2-ca-error--shake');
    void errorEl.offsetWidth;
    errorEl.classList.add('v2-ca-error--shake');
  }

  function hideError() {
    errorEl.setAttribute('hidden', '');
    errorEl.className = 'v2-ca-error';
  }

  window.openCorrectionDrawer = async function openCorrectionDrawer(caseData) {
    _currentCase = caseData;
    _pending = false;

    caseIdEl.textContent = caseData.case_id || '';
    infoGrid.innerHTML = '';
    suggestWrap.setAttribute('hidden', '');
    errorEl.setAttribute('hidden', '');
    successEl.setAttribute('hidden', '');
    productSel.innerHTML = '<option value="">— Produkt auswählen —</option>';
    confirmBtn.disabled = false;
    if (btnText)    btnText.hidden    = false;
    if (btnSpinner) btnSpinner.hidden = true;
    // Reset elements hidden on previous success
    const fieldEl   = contentEl?.querySelector('.v2-ca-field');
    const actionsEl = contentEl?.querySelector('.v2-ca-actions');
    if (fieldEl)   fieldEl.removeAttribute('hidden');
    if (actionsEl) actionsEl.removeAttribute('hidden');

    // Info grid
    const fields = [
      ['Automat',      caseData.machine_id ?? '–'],
      ['MDB-Code',     caseData.mdb_code   ?? '–'],
      ['Produkt',      caseData.expected_product || caseData.product_id || '–'],
      ['Transaktionen',caseData.affected_tx_count ?? 0],
    ];
    infoGrid.innerHTML = fields.map(([l, v]) =>
      `<div class="v2-ca-info-item"><p class="v2-ca-info-label">${esc(l)}</p><p class="v2-ca-info-value">${esc(v)}</p></div>`
    ).join('');

    backdrop.removeAttribute('hidden');
    backdrop.focus?.();
    showLoading();

    try {
      const res = await fetch(`/api/v2/correction-action/suggest?case_id=${encodeURIComponent(caseData.case_id)}`);
      const data = await res.json();

      if (data.suggestion) {
        suggestName.textContent = data.suggestion.name;
        suggestWrap.removeAttribute('hidden');
      }

      const products = data.products || [];
      productSel.innerHTML = '<option value="">— Produkt auswählen —</option>' +
        products.map((p) => `<option value="${esc(p.product_id)}">${esc(p.name)}</option>`).join('');

      if (data.suggestion?.product_id) {
        productSel.value = String(data.suggestion.product_id);
      }
    } catch (_) {
      // Non-critical: show empty select, user can still pick
    }

    showContent();
  };

  window.closeCorrectionDrawer = function closeCorrectionDrawer() {
    backdrop.setAttribute('hidden', '');
    _currentCase = null;
    _pending = false;
  };

  window.submitCorrectionAction = async function submitCorrectionAction() {
    if (_pending || !_currentCase) return;
    const confirmedProductId = Number(productSel.value);
    if (!confirmedProductId) {
      showError('Bitte ein Produkt auswählen.');
      return;
    }
    hideError();
    setPending(true);

    const body = {
      case_id:              _currentCase.case_id,
      case_type:            _currentCase.case_type,
      machine_id:           _currentCase.machine_id,
      mdb_code:             _currentCase.mdb_code,
      old_product_id:       _currentCase.product_id,
      slot_assignment_id:   _currentCase.slot_assignment_id,
      confirmed_product_id: confirmedProductId,
    };

    try {
      const res = await fetch('/api/v2/correction-action/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.ok) {
        setPending(false);
        successMsg.textContent = data.message || 'Korrektur erfolgreich gespeichert.';
        contentEl.querySelector('.v2-ca-field').setAttribute('hidden', '');
        contentEl.querySelector('.v2-ca-actions').setAttribute('hidden', '');
        successEl.removeAttribute('hidden');
        setTimeout(() => {
          window.closeCorrectionDrawer();
          if (typeof window._reloadCorrectionCases === 'function') window._reloadCorrectionCases();
        }, 2000);
      } else {
        setPending(false);
        showError(data.error?.message || 'Korrektur fehlgeschlagen.');
      }
    } catch (err) {
      setPending(false);
      showError(`Verbindungsfehler: ${err.message}`);
    }
  };

  // Event listeners
  if (closeBtn) closeBtn.addEventListener('click', window.closeCorrectionDrawer);
  if (cancelBtn) cancelBtn.addEventListener('click', window.closeCorrectionDrawer);
  if (confirmBtn) confirmBtn.addEventListener('click', window.submitCorrectionAction);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) window.closeCorrectionDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.hidden) window.closeCorrectionDrawer();
  });
}());

/* ═══════════════════════════════════════════════════════════════════════════
   Machine Profiles – global loader + panel
   ═══════════════════════════════════════════════════════════════════════════ */

let _machineProfilesCache = null;

async function loadMachineProfiles() {
  try {
    const res = await fetch('/api/v2/machine-profiles');
    const data = await res.json();
    if (!data.ok) return;
    _machineProfilesCache = data;
    populateMachineSelects(data.data || []);
    window.dispatchEvent(new CustomEvent('machineProfilesLoaded', { detail: data }));
  } catch (_) {
    // non-critical; selects stay with "alle" fallback
  }
}

function populateMachineSelects(profiles) {
  const selects = document.querySelectorAll(
    '#inventoryMachineFilter, #assortmentMachineFilter, #ecoMachineFilter'
  );
  selects.forEach((sel) => {
    const current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    profiles.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.machine_id;
      opt.textContent = p.label || p.machine_id;
      sel.appendChild(opt);
    });
    if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  });
}

(function initMachineProfiles() {
  const panel = document.querySelector('#machineProfilesPanel');
  if (!panel) return;

  const stateEl = document.querySelector('#machineProfilesState');
  const contentEl = document.querySelector('#machineProfilesContent');
  const bodyEl = document.querySelector('#machineProfilesBody');
  const emptyEl = document.querySelector('#mpEmptyState');
  const adminTools = document.querySelector('#mpAdminTools');
  const editHeader = document.querySelector('#mpEditHeader');
  const addBtn = document.querySelector('#mpAddBtn');
  const formContainer = document.querySelector('#mpFormContainer');

  function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function badgeHtml(label) {
    const parts = label.split('·').map((p) => p.trim());
    if (parts.length <= 1) return `<span class="v2-mp-badge">${escHtml(label)}</span>`;
    return `<span class="v2-mp-badge">${parts.map((p, i) => (i > 0 ? `<span class="v2-mp-badge-dot">·</span>${escHtml(p)}` : escHtml(p))).join('')}</span>`;
  }

  function renderProfiles(profiles, isAdmin) {
    if (editHeader) editHeader.hidden = !isAdmin;
    if (adminTools) adminTools.hidden = !isAdmin;

    if (profiles.length === 0) {
      bodyEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    bodyEl.innerHTML = profiles.map((p) => `
      <tr data-machine-id="${escHtml(p.machine_id)}">
        <td><span class="v2-mp-id">${escHtml(p.machine_id)}</span></td>
        <td>${badgeHtml(p.label || p.machine_id)}</td>
        <td>${escHtml(p.area ?? '—')}</td>
        <td>${escHtml(p.type ?? '—')}</td>
        <td>${escHtml(p.position ?? '—')}</td>
        <td>${escHtml(p.nickname ?? '—')}</td>
        ${isAdmin ? `<td><button class="v2-mp-edit-btn" data-action="edit" data-machine-id="${escHtml(p.machine_id)}">Bearbeiten</button></td>` : ''}
      </tr>
    `).join('');
  }

  function buildFormHtml(profile, options) {
    const { types = [], positions = [], areas = [] } = options || {};
    const p = profile || {};

    function selectOpts(list, current) {
      return list.map((v) => `<option value="${escHtml(v)}"${current === v ? ' selected' : ''}>${escHtml(v)}</option>`).join('');
    }

    const areaIsCustom = p.area && !areas.includes(p.area);
    const typeIsCustom = p.type && !types.includes(p.type);
    const posIsCustom = p.position && !positions.includes(p.position);

    return `
      <div class="v2-mp-form" id="mpForm">
        <p class="v2-mp-form-title">
          ${p.machine_id ? `Profil bearbeiten – <span class="v2-mp-id">${escHtml(p.machine_id)}</span>` : 'Neues Profil anlegen'}
          <button class="v2-mp-form-close" id="mpFormClose" type="button" aria-label="Formular schließen">✕</button>
        </p>
        <div class="v2-mp-form-grid">
          <div class="v2-mp-field v2-mp-field--full">
            <label for="mpFieldMachineId">Maschinen-ID <span style="color:var(--v2-error)">*</span></label>
            <input type="text" id="mpFieldMachineId" value="${escHtml(p.machine_id ?? '')}" placeholder="z.B. ABC-12345" ${p.machine_id ? 'readonly' : ''}>
          </div>
          <div class="v2-mp-field">
            <label for="mpFieldArea">Bereich / Etage</label>
            <select id="mpFieldArea">
              <option value="">– keine Angabe –</option>
              ${selectOpts(areas, areaIsCustom ? 'Sonstiges' : (p.area ?? ''))}
            </select>
            <input class="v2-mp-sonstiges" type="text" id="mpFieldAreaCustom" placeholder="Freitext Bereich …" value="${areaIsCustom ? escHtml(p.area) : ''}" ${!areaIsCustom ? 'hidden' : ''}>
          </div>
          <div class="v2-mp-field">
            <label for="mpFieldType">Typ</label>
            <select id="mpFieldType">
              <option value="">– keine Angabe –</option>
              ${selectOpts(types, typeIsCustom ? 'Sonstiges' : (p.type ?? ''))}
            </select>
            <input class="v2-mp-sonstiges" type="text" id="mpFieldTypeCustom" placeholder="Freitext Typ …" value="${typeIsCustom ? escHtml(p.type) : ''}" ${!typeIsCustom ? 'hidden' : ''}>
          </div>
          <div class="v2-mp-field">
            <label for="mpFieldPosition">Position</label>
            <select id="mpFieldPosition">
              <option value="">– keine Angabe –</option>
              ${selectOpts(positions, posIsCustom ? 'Sonstiges' : (p.position ?? ''))}
            </select>
            <input class="v2-mp-sonstiges" type="text" id="mpFieldPositionCustom" placeholder="Freitext Position …" value="${posIsCustom ? escHtml(p.position) : ''}" ${!posIsCustom ? 'hidden' : ''}>
          </div>
          <div class="v2-mp-field">
            <label for="mpFieldNickname">Spitzname (optional)</label>
            <input type="text" id="mpFieldNickname" value="${escHtml(p.nickname ?? '')}" placeholder="z.B. Hauptautomat">
          </div>
        </div>
        <div class="v2-mp-form-actions">
          <button class="v2-mp-cancel-btn" id="mpCancelBtn" type="button">Abbrechen</button>
          <button class="v2-mp-save-btn" id="mpSaveBtn" type="button">Speichern</button>
        </div>
        <p class="v2-mp-form-status" id="mpFormStatus"></p>
      </div>
    `;
  }

  function wireFormToggle(field, customInput) {
    const sel = document.querySelector(field);
    const inp = document.querySelector(customInput);
    if (!sel || !inp) return;
    sel.addEventListener('change', () => {
      inp.hidden = sel.value !== 'Sonstiges';
      if (inp.hidden) inp.value = '';
    });
  }

  function openForm(profile) {
    const options = _machineProfilesCache?.options || {};
    formContainer.innerHTML = buildFormHtml(profile, options);
    formContainer.hidden = false;
    if (addBtn) addBtn.hidden = true;

    wireFormToggle('#mpFieldArea', '#mpFieldAreaCustom');
    wireFormToggle('#mpFieldType', '#mpFieldTypeCustom');
    wireFormToggle('#mpFieldPosition', '#mpFieldPositionCustom');

    document.querySelector('#mpFormClose')?.addEventListener('click', closeForm);
    document.querySelector('#mpCancelBtn')?.addEventListener('click', closeForm);
    document.querySelector('#mpSaveBtn')?.addEventListener('click', saveProfile);
  }

  function closeForm() {
    formContainer.innerHTML = '';
    formContainer.hidden = true;
    if (adminTools && !adminTools.hidden) addBtn.hidden = false;
  }

  function resolveField(selId, customId) {
    const sel = document.querySelector(selId);
    if (!sel) return null;
    if (sel.value === 'Sonstiges') {
      const custom = document.querySelector(customId);
      return custom?.value.trim() || null;
    }
    return sel.value || null;
  }

  async function saveProfile() {
    const machineId = document.querySelector('#mpFieldMachineId')?.value.trim();
    const statusEl = document.querySelector('#mpFormStatus');
    if (!machineId) {
      statusEl.textContent = 'Maschinen-ID ist erforderlich.';
      statusEl.className = 'v2-mp-form-status v2-mp-form-status--err';
      return;
    }
    const payload = {
      machine_id: machineId,
      area: resolveField('#mpFieldArea', '#mpFieldAreaCustom'),
      type: resolveField('#mpFieldType', '#mpFieldTypeCustom'),
      position: resolveField('#mpFieldPosition', '#mpFieldPositionCustom'),
      nickname: document.querySelector('#mpFieldNickname')?.value.trim() || null,
    };
    const saveBtn = document.querySelector('#mpSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Speichert …'; }
    try {
      const res = await fetch('/api/v2/machine-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message || 'Fehler beim Speichern');
      statusEl.textContent = 'Gespeichert.';
      statusEl.className = 'v2-mp-form-status v2-mp-form-status--ok';
      await loadMachineProfiles();
      setTimeout(() => { closeForm(); reloadPanel(); }, 800);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'v2-mp-form-status v2-mp-form-status--err';
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Speichern'; }
    }
  }

  function reloadPanel() {
    if (_machineProfilesCache) {
      renderProfiles(_machineProfilesCache.data || [], _isAdmin);
    }
  }

  let _isAdmin = false;

  async function loadPanel() {
    stateEl.textContent = 'Lade Automaten-Profile …';
    stateEl.hidden = false;
    contentEl.hidden = true;
    try {
      const res = await fetch('/api/v2/machine-profiles');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error?.message || 'Fehler');
      _machineProfilesCache = data;
      _isAdmin = data.is_admin || false;
      populateMachineSelects(data.data || []);
      renderProfiles(data.data || [], _isAdmin);
      stateEl.hidden = true;
      contentEl.hidden = false;
    } catch (err) {
      stateEl.textContent = `Automaten-Profile konnten nicht geladen werden: ${err.message}`;
    }
  }

  bodyEl?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-action="edit"]');
    if (!editBtn) return;
    const machineId = editBtn.dataset.machineId;
    const profile = (_machineProfilesCache?.data || []).find((p) => p.machine_id === machineId);
    if (profile) openForm(profile);
  });

  addBtn?.addEventListener('click', () => openForm(null));

  window.addEventListener('machineProfilesLoaded', (e) => {
    const data = e.detail;
    _isAdmin = data.is_admin || false;
    if (!contentEl.hidden) renderProfiles(data.data || [], _isAdmin);
  });

  loadPanel();
}());
