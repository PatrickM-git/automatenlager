function clean(v) { return String(v ?? '').replace(/\n/g, ' ').replace(/\s+/g, ' ').replace(/´|`|‘|’/g, "'").trim(); }
function isActive(v) { return ['TRUE','1','JA','YES','AKTIV','ACTIVE'].includes(clean(v).toUpperCase()); }
function num(v) { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; }

const picklist      = $('Code - Claude Response parsen').first().json.items;
const fileName      = $('Code - Datei-ID ermitteln').first().json.fileName;
const allProdukte   = $('Google Sheets - Produkte lesen').all().map(i => i.json);
const allLager      = $('Google Sheets - Lagerchargen lesen').all().map(i => i.json);
const allHinweise   = $('Google Sheets - Hinweise lesen').all().map(i => i.json);

const now = new Date().toISOString();
let tsOffset = 0;
function nextTs() { return new Date(new Date(now).getTime() + tsOffset++).toISOString(); }

// c.status statt c.active (Lagerchargen haben 'status', nicht 'active')
const remainingByKey = {};
for (const c of allLager) {
  if (!isActive(c.status)) continue;
  const qty = num(c.remaining_qty);
  if (!qty || qty <= 0) continue;
  const pk = clean(c.product_key);
  remainingByKey[pk] = (remainingByKey[pk] || 0) + qty;
}

const slotUpdates  = [];
const toResolve    = [];
const auditEntries = [];
const warnings     = [];
const resolvableTypes = ['EMPTY_BATCH', 'LOW_STOCK', 'INSUFFICIENT_BATCH_STOCK', 'LOW_BATCH'];

for (const item of picklist) {
  const nayaxName = clean(item.name || '');
  const pickQty   = num(item.pick);
  if (!nayaxName || !pickQty || pickQty <= 0) continue;

  const slots = allProdukte.filter(p => clean(p.nayax_product_name) === nayaxName && isActive(p.active));
  if (!slots.length) { warnings.push('Nicht gefunden: "' + nayaxName + '"'); continue; }

  const pk             = clean(slots[0].product_key);
  const totalRemaining = remainingByKey[pk] || 0;

  // Verfügbar = Backstock (remaining minus was bereits im Automaten)
  const currentInMachine = slots.reduce((sum, s) => sum + (num(s.current_machine_qty) || 0), 0);
  const availableFill    = Math.max(0, totalRemaining - currentInMachine);
  let effective          = Math.min(pickQty, availableFill);
  const wasCapped        = effective < pickQty;

  const updatedSlots = [];
  for (const slot of slots) {
    if (effective <= 0) break;
    const slotCurrent  = num(slot.current_machine_qty) || 0;
    const capacity     = num(slot.machine_capacity) || 999;
    const slotRoom     = Math.max(0, capacity - slotCurrent);
    const fillThisSlot = Math.min(slotRoom, effective);
    if (fillThisSlot <= 0) continue;
    effective -= fillThisSlot;
    const newQty = slotCurrent + fillThisSlot;
    slotUpdates.push({
      product_slot_id: clean(slot.product_slot_id),
      current_machine_qty: newQty,
      last_stock_update_source: 'WF9_PICKLISTE',
      last_stock_update_at: now
    });
    updatedSlots.push(clean(slot.product_slot_id) + '=' + newQty);
  }

  for (const h of allHinweise) {
    if (['TRUE','JA','YES','1'].includes(clean(h.resolved).toUpperCase())) continue;
    if (clean(h.product_key) === pk && resolvableTypes.includes(clean(h.type))) {
      toResolve.push({ created_at: clean(h.created_at), resolved: 'TRUE' });
    }
  }

  auditEntries.push({
    created_at: nextTs(),
    type: 'PICKLISTE_REFILL',
    severity: 'info',
    machine_id: '457107528',
    product_key: pk,
    nayax_product_name: nayaxName,
    message: nayaxName + ' pick=' + pickQty +
      (wasCapped ? ' (gecappt auf ' + Math.min(pickQty, availableFill) + ', backstock=' + availableFill + ')' : '') +
      '. Slots: ' + (updatedSlots.length ? updatedSlots.join(', ') : 'keine (0 verfügbar)'),
    resolved: 'TRUE'
  });
}

if (warnings.length) {
  auditEntries.push({
    created_at: nextTs(), type: 'PICKLISTE_WARNING', severity: 'warning',
    machine_id: '457107528', product_key: '', nayax_product_name: '',
    message: 'Nicht zugeordnet: ' + warnings.join('; '), resolved: 'FALSE'
  });
}

auditEntries.push({
  created_at: nextTs(), type: 'PICKLISTE_VERARBEITET', severity: 'info',
  machine_id: '457107528', product_key: '', nayax_product_name: '',
  message: 'DATEI:' + fileName + ' - Produkte: ' + (picklist.length - warnings.length) + ', Slots: ' + slotUpdates.length,
  resolved: 'TRUE'
});

return [{ json: { ok: true, fileName, slotUpdates, toResolve, auditEntries, warnings,
  summary: { products_processed: picklist.length - warnings.length, slots_updated: slotUpdates.length,
             hints_resolved: toResolve.length, warnings: warnings.length } } }];
