const inputItems = $input.all().map(i => i.json);

const alerts = inputItems.flatMap(item => {
  if (Array.isArray(item.alerts)) return item.alerts;
  return [item];
}).filter(a => a && typeof a === 'object');

const summary = inputItems.reduce((acc, item) => {
  const s = item.summary || {};

  acc.checked_batches += Number(s.checked_batches || 0);
  acc.checked_hint_rows += Number(s.checked_hint_rows || 0);
  acc.alerts_created += Number(s.alerts_created || 0);
  acc.open_hints_today += Number(s.open_hints_today || 0);

  return acc;
}, {
  checked_batches: 0,
  checked_hint_rows: 0,
  alerts_created: 0,
  open_hints_today: 0
});

function clean(value) {
  return String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function esc(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function value(alert, keys) {
  for (const key of keys) {
    const v = clean(alert[key]);
    if (v) return v;
  }
  return '';
}

function parseDate(value) {
  const raw = clean(value);
  if (!raw) return null;

  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;

  const m1 = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m1) return new Date(`${m1[1]}-${m1[2]}-${m1[3]}T00:00:00Z`);

  const m2 = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T00:00:00Z`);

  return null;
}

function formatDate(value) {
  const d = parseDate(value);
  if (!d) return clean(value) || '-';

  return d.toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function todayBerlinIso() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  return [
    parts.find(p => p.type === 'year')?.value,
    parts.find(p => p.type === 'month')?.value,
    parts.find(p => p.type === 'day')?.value,
  ].join('-');
}

function daysUntil(value) {
  const d = parseDate(value);
  if (!d) return null;

  const today = new Date(`${todayBerlinIso()}T00:00:00+01:00`);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);

  return Math.ceil((target - today) / 86400000);
}

function isResolved(alert) {
  const resolved = clean(alert.resolved).toUpperCase();
  return ['TRUE', 'JA', 'YES', '1', 'ERLEDIGT', 'RESOLVED'].includes(resolved);
}

function productName(alert) {
  return value(alert, [
    'product_name',
    'internal_product_name',
    'nayax_product_name',
    'article_name',
    'artikelname',
    'artikelbezeichnung',
    'name',
    'product',
    'item_name',
    'product_key',
  ]) || 'Unbekanntes Produkt';
}

function productKey(alert) {
  return value(alert, ['product_key', 'sku', 'SKU']);
}

function batchId(alert) {
  return value(alert, ['batch_id', 'charge_id', 'lagercharge', 'batch', 'charge']);
}

function machineId(alert) {
  return value(alert, ['machine_id', 'MachineID', 'machine']);
}

function mdbCode(alert) {
  return value(alert, ['mdb_code', 'MDB', 'mdb', 'actual_mdb_code', 'expected_mdb_code']);
}

function remainingQty(alert) {
  return num(
    alert.remaining_qty ??
    alert.current_machine_qty ??
    alert.quantity_left ??
    alert.qty ??
    alert.quantity ??
    alert.bestand ??
    alert.restbestand ??
    alert.remaining ??
    alert.stock
  );
}

function minStock(alert) {
  return num(alert.min_stock ?? alert.minimum_stock ?? alert.mindestbestand);
}

function targetStock(alert) {
  return num(alert.target_stock ?? alert.sollbestand ?? alert.zielbestand);
}

function capacity(alert) {
  return num(alert.machine_capacity ?? alert.capacity ?? alert.slot_capacity);
}

function mhd(alert) {
  return value(alert, [
    'mhd',
    'expiry_date',
    'best_before',
    'valid_until',
    'mhd_date',
    'expiration_date'
  ]);
}

function type(alert) {
  return clean(alert.type).toUpperCase();
}

function severity(alert) {
  return clean(alert.severity).toLowerCase();
}

function message(alert) {
  return clean(alert.message || alert.hinweis || alert.description);
}

const dateText = new Date().toLocaleDateString('de-DE', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const relevantAlerts = alerts.filter(alert => {
  if (!alert || typeof alert !== 'object') return false;
  if (isResolved(alert)) return false;
  return true;
});

// PATCH EMAIL_DEDUP: pro Produkt+Typ nur einmal in der Mail anzeigen.
// Behebt doppelte Eintraege wenn Code-MHD (frische Alerts) und
// Code-Offene-Hinweise (Sheet-Eintraege) dasselbe Produkt enthalten.
// Bevorzugt den Eintrag mit MDB-Code (mehr Info fuer den User).
const _dedupSeen = new Map(); // key -> index in _dedupedAlerts
const _dedupedAlerts = [];
for (const _da of relevantAlerts) {
  const _dk = type(_da) + '::' + (productKey(_da) || productName(_da));
  if (!_dedupSeen.has(_dk)) {
    _dedupSeen.set(_dk, _dedupedAlerts.length);
    _dedupedAlerts.push(_da);
  } else if (!mdbCode(_dedupedAlerts[_dedupSeen.get(_dk)]) && mdbCode(_da)) {
    // Vorhandenen Eintrag durch Version mit MDB-Code ersetzen
    _dedupedAlerts[_dedupSeen.get(_dk)] = _da;
  }
}

const mhdExpired = [];
const mhdSoon = [];
const lowStock = [];
const dataIssues = [];
const otherWarnings = [];

for (const alert of _dedupedAlerts) {
  const t = type(alert);
  const s = severity(alert);
  const msg = message(alert).toLowerCase();
  const mhdValue = mhd(alert);
  const days = daysUntil(mhdValue);

  const isMhd =
    (t.includes('MHD') || t.includes('EXPIRY') || msg.includes('mhd')) &&
    mhdValue &&
    days !== null;

  const isLowStock =
    t.includes('LOW_STOCK') ||
    t.includes('MIN_STOCK') ||
    t.includes('REPLENISHMENT') ||
    t.includes('BESTAND');

  const isDataIssue =
    ['error', 'critical'].includes(s) ||
    t.includes('UNKNOWN') ||
    t.includes('MISSING') ||
    t.includes('MISMATCH') ||
    t.includes('PRODUCT_MAPPING') ||
    t.includes('SLOT') ||
    t.includes('MDB') ||
    msg.includes('fehler') ||
    msg.includes('konnte nicht') ||
    msg.includes('nicht sicher') ||
    msg.includes('keine gueltige') ||
    msg.includes('keine gültige');

  if (isMhd && days < 0) {
    mhdExpired.push(alert);
  } else if (isMhd && days <= 30) {
    mhdSoon.push(alert);
  } else if (isLowStock) {
    lowStock.push(alert);
  } else if (isDataIssue) {
    dataIssues.push(alert);
  } else {
    otherWarnings.push(alert);
  }
}

function sortByMhd(a, b) {
  const da = daysUntil(mhd(a));
  const db = daysUntil(mhd(b));

  if (da !== null && db !== null) return da - db;
  if (da !== null) return -1;
  if (db !== null) return 1;

  return productName(a).localeCompare(productName(b), 'de');
}

function sortByQty(a, b) {
  const qa = remainingQty(a);
  const qb = remainingQty(b);

  if (qa !== null && qb !== null) return qa - qb;
  if (qa !== null) return -1;
  if (qb !== null) return 1;

  return productName(a).localeCompare(productName(b), 'de');
}

mhdExpired.sort(sortByMhd);
mhdSoon.sort(sortByMhd);
lowStock.sort(sortByQty);
dataIssues.sort((a, b) => productName(a).localeCompare(productName(b), 'de'));
otherWarnings.sort((a, b) => productName(a).localeCompare(productName(b), 'de'));

function card(title, count, color) {
  return `
    <td style="width:50%;padding:8px;">
      <div style="border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;padding:14px;">
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">${esc(title)}</div>
        <div style="font-size:26px;font-weight:700;color:${color};">${count}</div>
      </div>
    </td>
  `;
}

function section(title, itemsHtml) {
  if (!itemsHtml) return '';
  return `
    <h2 style="font-size:18px;margin:28px 0 10px;color:#111827;">${esc(title)}</h2>
    <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#ffffff;">
      ${itemsHtml}
    </div>
  `;
}

function itemBlock(lines) {
  return `
    <div style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">
      ${lines.filter(Boolean).map(line => `<div style="margin:4px 0;font-size:14px;line-height:1.35;">${esc(line)}</div>`).join('')}
    </div>
  `;
}

function baseLine(alert) {
  const parts = [productName(alert)];

  if (productKey(alert)) parts.push(`SKU: ${productKey(alert)}`);
  if (batchId(alert)) parts.push(`Charge: ${batchId(alert)}`);
  if (machineId(alert)) parts.push(`Maschine: ${machineId(alert)}`);
  if (mdbCode(alert)) parts.push(`MDB: ${mdbCode(alert)}`);

  return parts.join(' | ');
}

function mhdBlock(alert) {
  const days = daysUntil(mhd(alert));

  const daysText = days !== null
    ? days < 0
      ? `seit ${Math.abs(days)} Tag(en) abgelaufen`
      : `in ${days} Tag(en)`
    : 'Datum prüfen';

  return itemBlock([
    `${esc(value(alert, ['nayax_product_name', 'product_name']))} | Maschine: ${esc(machineId(alert))}`,
    `MHD: ${formatDate(mhd(alert))} | ${daysText}`
  ]);
}

function stockBlock(alert) {
  return itemBlock([
    `${esc(value(alert, ['nayax_product_name', 'product_name']))} | Maschine: ${esc(machineId(alert))}`,
    `Bestand im Automaten: ${remainingQty(alert) ?? '-'}`
  ]);
}

function issueBlock(alert) {
  return itemBlock([
    baseLine(alert),
    `Typ: ${type(alert) || '-'} | Schweregrad: ${severity(alert) || '-'}`,
    message(alert) ? `Hinweis: ${message(alert)}` : ''
  ]);
}

const subjectParts = [];
if (mhdExpired.length) subjectParts.push(`${mhdExpired.length} MHD abgelaufen`);
if (mhdSoon.length) subjectParts.push(`${mhdSoon.length} MHD bald`);
if (lowStock.length) subjectParts.push(`${lowStock.length} niedriger Bestand`);
if (dataIssues.length) subjectParts.push(`${dataIssues.length} Datenfehler`);

const subject = subjectParts.length
  ? `Automatenlager Check ${dateText}: ${subjectParts.join(' · ')}`
  : `Automatenlager Check ${dateText}: keine akuten Punkte`;

const nextSteps = [];
if (mhdExpired.length) nextSteps.push('Abgelaufene Produkte sofort prüfen und aus Automat/Lager entfernen.');
if (mhdSoon.length) nextSteps.push('Produkte mit nahendem MHD priorisiert verkaufen, reduzieren oder austauschen.');
if (lowStock.length) nextSteps.push('Niedrige Bestände für die nächste Befüllung einplanen.');
if (dataIssues.length) nextSteps.push('Daten-/Workflowfehler im Tab Fehler_und_Hinweise prüfen und bereinigen.');
if (!nextSteps.length) nextSteps.push('Keine Aktion erforderlich.');

const html = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;padding:24px;color:#111827;">
  <div style="max-width:780px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;border:1px solid #e5e7eb;">

    <h1 style="font-size:24px;margin:0 0 4px;">Automatenlager Check</h1>
    <div style="font-size:14px;color:#6b7280;margin-bottom:22px;">Datum: ${esc(dateText)}</div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;margin-bottom:18px;">
      <tr>
        ${card('MHD abgelaufen', mhdExpired.length, '#b91c1c')}
        ${card('MHD läuft bald ab', mhdSoon.length, '#b45309')}
      </tr>
      <tr>
        ${card('Niedriger Bestand', lowStock.length, '#1d4ed8')}
        ${card('Daten-/Workflowfehler', dataIssues.length, '#7f1d1d')}
      </tr>
    </table>

    <div style="font-size:14px;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin-bottom:22px;">
      <div><strong>Ausgewertete Alerts:</strong> ${alerts.length}</div>
      <div><strong>Geprüfte Lagerchargen:</strong> ${summary.checked_batches || '-'}</div>
      <div><strong>Geprüfte Hinweiszeilen:</strong> ${summary.checked_hint_rows || '-'}</div>
    </div>

    ${section('MHD abgelaufen', mhdExpired.map(mhdBlock).join(''))}
    ${section('MHD läuft bald ab', mhdSoon.map(mhdBlock).join(''))}
    ${section('Niedriger Bestand', lowStock.map(stockBlock).join(''))}
    ${section('Daten-/Workflowfehler', dataIssues.map(issueBlock).join(''))}
    ${section('Sonstige Hinweise', otherWarnings.map(issueBlock).join(''))}

    <h2 style="font-size:18px;margin:28px 0 10px;">Nächste Schritte</h2>
    <ul style="margin:0;padding-left:20px;">
      ${nextSteps.map(step => `<li style="margin:6px 0;font-size:14px;line-height:1.35;">${esc(step)}</li>`).join('')}
    </ul>

    <div style="font-size:12px;color:#6b7280;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:12px;">
      Automatisch erstellt durch n8n.
    </div>

  </div>
</div>
`;

const text = [
  `Automatenlager Check ${dateText}`,
  '',
  `MHD abgelaufen: ${mhdExpired.length}`,
  `MHD läuft bald ab: ${mhdSoon.length}`,
  `Niedriger Bestand: ${lowStock.length}`,
  `Daten-/Workflowfehler: ${dataIssues.length}`,
].join('\n');

return [{
  json: {
    email_subject: subject,
    email_body: html,
    email_text: text,
    alerts_count: alerts.length,
    mhd_expired_count: mhdExpired.length,
    mhd_soon_count: mhdSoon.length,
    low_stock_count: lowStock.length,
    data_issue_count: dataIssues.length,
    other_warning_count: otherWarnings.length
  }
}];