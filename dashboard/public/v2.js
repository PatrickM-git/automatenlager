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

// ── Economics / GuV & KPI ────────────────────────────────────────────────────

const ecoState = {
  sortBy: 'revenue_net',
  sortOrder: 'desc',
  machine: '',
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

function renderHeroStrip(totals) {
  const hero = document.querySelector('#ecoHero');
  const marginPct = totals.revenue_net > 0
    ? ((totals.db_net / totals.revenue_net) * 100)
    : 0;
  const marginClass = marginPct >= 60 ? 'v2-eco-kpi--positive' : marginPct < 50 ? 'v2-eco-kpi--warn' : '';

  hero.innerHTML = `
    <div class="v2-eco-kpi">
      <div class="v2-eco-kpi-label">Umsatz netto</div>
      <div class="v2-eco-kpi-value">${fmtEur(totals.revenue_net)}</div>
      <div class="v2-eco-kpi-sub">${totals.qty} Einheiten</div>
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
      <td>${r.product_id}</td>
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
  const url = `/api/v2/economics?sort=${encodeURIComponent(ecoState.sortBy)}&order=${encodeURIComponent(ecoState.sortOrder)}&machine=${encodeURIComponent(machine)}`;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();

    if (!payload.ok || !payload.data) {
      stateEl.innerHTML = `<p style="padding:16px 0;color:var(--v2-error)">${payload.error?.code || 'FEHLER'}: ${payload.error?.message || 'Unbekannter Fehler'}</p>`;
      return;
    }

    renderHeroStrip(payload.data.totals);
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

function initEconomics() {
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
initEconomics();
