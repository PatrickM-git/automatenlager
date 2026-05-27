async function loadV2Overview() {
  const status = document.querySelector('#v2Status');
  try {
    const response = await fetch('/api/v2/overview', { cache: 'no-store' });
    const data = await response.json();
    status.textContent = data.ok
      ? `PG-Datenstand: ${data.generatedAtDisplay || data.generatedAt}`
      : `${data.error.code}: ${data.error.message}`;
  } catch (error) {
    status.textContent = `API nicht erreichbar: ${error.message}`;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function renderInventoryList(el, rows, emptyText, renderRow) {
  if (!rows || !rows.length) {
    el.innerHTML = `<div class="v2-inventory-empty">${emptyText}</div>`;
    return;
  }
  el.innerHTML = rows.map(renderRow).join('');
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
  machineInput.addEventListener('input', onChange);
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
  machineInput.addEventListener('input', onChange);
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
  machineInput.addEventListener('input', () => {
    clearTimeout(debounce);
    ecoState.machine = machineInput.value;
    debounce = setTimeout(loadEconomics, 400);
  });

  loadEconomics();
}

loadV2Overview();
initUploads();
initInventoryMhd();
initAssortmentSlots();
initEconomics();
