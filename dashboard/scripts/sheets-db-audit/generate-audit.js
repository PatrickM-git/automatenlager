'use strict';

// Issue #61: Vollständigkeits-Audit Google Sheets -> SQL-DB vor dem Sheets-Cutover
// (#9). Mappt jede Sheet-Spalte (je Tab) gegen das PostgreSQL-Schema und markiert
// jede Lücke, damit beim Abschalten der Sheets nichts verloren geht.
//
// Reproduzierbar:
//   1. Sheet-Inventur (Snapshot): sheet_inventory.snapshot.json — erzeugt aus dem
//      committeten XLSX-Export via dump-sheet-inventory.js (xlsx-Parser nötig).
//   2. DB-Inventur: db_inventory.snapshot.json — erzeugt live aus der DB via
//      dump-db-inventory.js (PG-Tunnel). Ohne Tunnel wird der Snapshot genutzt.
//   3. node generate-audit.js  -> schreibt docs/data-model/sheets-db-audit.md
//
// Die Tab->Tabelle/Spalten-Zuordnung ist KURATIERT (Namen weichen ab, z. B.
// produktart -> products.category). Neue Sheet-Spalten ohne Eintrag erscheinen
// im Report als „⚠ nicht klassifiziert" und müssen hier ergänzt werden.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const sheets = JSON.parse(fs.readFileSync(path.join(DIR, 'sheet_inventory.snapshot.json'), 'utf8'));
const db = JSON.parse(fs.readFileSync(path.join(DIR, 'db_inventory.snapshot.json'), 'utf8'));

// DB-Spalten je Tabelle als Set (lowercase) für schnellen Lookup.
const dbCols = {};
for (const [t, info] of Object.entries(db)) dbCols[t] = new Set(info.columns.map((c) => c.toLowerCase()));
const dbHas = (table, col) => !!(table && dbCols[table] && dbCols[table].has(String(col).toLowerCase()));

// Spalten-Marker:
//   string         -> DB-Zielspalte in der primären Tabelle des Tabs
//   {t,c}          -> DB-Zielspalte in einer ANDEREN Tabelle (Tab deckt mehrere ab)
//   'META'         -> Sheet-Bookkeeping (created_at/approved/processed/notes …), kein Migrationsgut
//   'STAGING'      -> transienter Workflow-Zwischenstand (regenerierbar), kein Quelldatum
//   'COVERED:#62'  -> Lücke, aber bereits durch Branchen-Anker (#62) in DB übernommen
//   'GAP'          -> bewusst als Lücke markiert (kein DB-Ziel)
const TABS = {
  Produkte: {
    table: 'products', kind: 'source',
    note: 'Stammdaten + aktive Slot-Zuordnung gemischt (DB: products + slot_assignments + prices).',
    map: {
      product_key: 'product_key', nayax_product_name: { t: 'product_aliases', c: 'alias' },
      internal_product_name: 'name', produktart: 'COVERED:#62', notes: 'notes',
      machine_id: { t: 'slot_assignments', c: 'machine_id' }, mdb_code: { t: 'slot_assignments', c: 'mdb_code' },
      product_slot_id: { t: 'slot_assignments', c: 'product_slot_key' }, active: { t: 'slot_assignments', c: 'active' },
      valid_from_datetime: { t: 'slot_assignments', c: 'valid_from' }, valid_to_datetime: { t: 'slot_assignments', c: 'valid_to' },
      valid_from: { t: 'slot_assignments', c: 'valid_from' }, valid_to: { t: 'slot_assignments', c: 'valid_to' },
      min_stock: 'GAP', target_stock: { t: 'slot_assignments', c: 'target_stock' },
      current_machine_qty: { t: 'slot_assignments', c: 'current_machine_qty' }, machine_capacity: { t: 'slot_assignments', c: 'machine_capacity' },
      sale_price_eur: { t: 'prices', c: 'sale_price_gross' }, replenishment_status: 'GAP', stock_source: 'GAP', last_change_id: 'META',
    },
  },
  Lagerchargen: {
    table: 'stock_batches', kind: 'source',
    map: {
      batch_id: 'batch_key', product_key: { t: 'products', c: 'product_key' }, purchase_date: 'received_at',
      mhd: 'mhd_date', initial_qty: 'initial_qty', remaining_qty: 'remaining_qty', unit_cost: 'unit_cost_net',
      supplier: { t: 'invoices', c: 'supplier_id' }, storage_location: 'GAP', status: 'status',
      notes: 'GAP', source_invoice: { t: 'invoices', c: 'invoice_key' }, source_item: { t: 'invoice_items', c: 'description_raw' },
      confidence: 'META',
    },
  },
  Produkt_Aliase: {
    table: 'product_aliases', kind: 'source',
    map: {
      alias_name: 'alias', normalized_alias: 'GAP', product_key: { t: 'products', c: 'product_key' },
      source: 'source', confidence: 'META', approved: 'META', created_at: 'created_at',
      last_seen_at: 'GAP', supplier: 'GAP', invoice_item_example: 'GAP', notes: 'GAP',
    },
  },
  Verarbeitete_Transaktionen: {
    table: 'sales_transactions', kind: 'source',
    map: {
      transaction_id: 'nayax_transaction_id', machine_id: 'machine_id', nayax_product_name: 'product_name_raw',
      product_key: { t: 'products', c: 'product_key' }, quantity: 'quantity', settlement_datetime_gmt: 'settlement_at',
      processed_at: 'imported_at', status: 'processing_status', notes: 'processing_note',
    },
  },
  Fehler_und_Hinweise: {
    table: 'warnings', kind: 'source',
    map: {
      created_at: 'created_at', type: 'warning_type', severity: 'severity', machine_id: 'machine_id',
      product_key: { t: 'products', c: 'product_key' }, nayax_product_name: 'GAP', message: 'message',
      resolved: 'resolved', change_id: 'META',
    },
  },
  Produktwechsel_Log: {
    table: 'stock_movements', kind: 'source',
    note: 'Produktwechsel; DB-Abbildung verteilt auf stock_movements / product_change_proposals.',
    map: {
      changed_at: 'occurred_at', machine_id: { t: 'slot_assignments', c: 'machine_id' }, mdb_code: { t: 'slot_assignments', c: 'mdb_code' },
      old_product_key: 'GAP', new_product_key: 'GAP', reason: 'reason', change_id: 'movement_key',
      changed_at_utc: 'occurred_at', source: 'source', status: 'GAP', notes: 'GAP',
      old_product_name: 'GAP', new_product_name: 'GAP', action_required: 'GAP', detected_reason: 'GAP',
      old_mdb_code: 'GAP', new_mdb_code: 'GAP', change_type_de: 'GAP', change_type_internal: { t: 'product_change_proposals', c: 'proposal_type' },
      valid_from_utc: 'GAP',
    },
  },
  Bestandsaufnahme_Handschrift: {
    table: null, kind: 'source',
    note: 'Manuelle Inventur-Erfassung (29 Zeilen). KEINE DB-Tabelle vorhanden.',
    map: {
      article_written: 'GAP', mapped_product_key: 'GAP', mapped_name: 'GAP', quantity_total: 'GAP',
      mhd: 'GAP', source: 'GAP', confidence: 'GAP', notes: 'GAP',
    },
  },
  Einstellungen: {
    table: null, kind: 'source',
    note: 'Key/Value-Konfiguration (10 Zeilen) — u. a. kleinunternehmer_aktiv, mwst_snack/getraenk. WF8 liest diese aus dem Sheet. DB hat classification_settings (JSONB), aber NICHT als Spiegel dieser Keys.',
    map: { key: 'GAP', value: 'GAP', description: 'GAP' },
  },
  // ── Staging / transient (regenerierbar, kein Quelldatum für Cutover) ──
  Produkt_Aenderungsvorschlaege: { table: 'product_change_proposals', kind: 'staging' },
  Rechnungseingang_Pruefung: { table: 'invoices', kind: 'staging' },
  Lagerchargen_Vorschlaege: { table: 'stock_batches', kind: 'staging' },
  Offene_Eingaben: { table: null, kind: 'staging' },
  // ── Meta / berechnet (kein Migrationsgut) ──
  Dashboard: { kind: 'meta', note: 'Berechnete KPIs.' },
  Workflow_Anpassungen: { kind: 'meta', note: 'Entwicklungs-Notizen.' },
  Quellen_und_Pruefung: { kind: 'meta', note: 'Evidenz/Doku.' },
  System_Status: { kind: 'meta', note: 'Lauf-Zeitstempel der Workflows.' },
};

function classify(table, col, marker) {
  if (marker === 'META') return ['—', 'Sheet-Bookkeeping (kein Migrationsgut)'];
  if (marker === 'STAGING') return ['—', 'Workflow-Zwischenstand (regenerierbar)'];
  if (marker === 'COVERED:#62') return ['✅ via #62', 'products.category (Branchen-Anker)'];
  if (marker === 'GAP') return ['❌ FEHLT', 'keine DB-Zielspalte'];
  if (marker && typeof marker === 'object') {
    return dbHas(marker.t, marker.c) ? ['✅', marker.t + '.' + marker.c] : ['❌ FEHLT', marker.t + '.' + marker.c + ' (nicht vorhanden)'];
  }
  if (typeof marker === 'string') {
    return dbHas(table, marker) ? ['✅', table + '.' + marker] : ['❌ FEHLT', table + '.' + marker + ' (nicht vorhanden)'];
  }
  return ['⚠ ?', 'nicht klassifiziert — Mapping ergänzen'];
}

const lines = [];
const gaps = [];
lines.push('# Vollständigkeits-Audit: Google Sheets → SQL-DB (Issue #61)', '');
lines.push('> Reproduzierbar via `dashboard/scripts/sheets-db-audit/generate-audit.js`.');
lines.push('> Quellen: XLSX-Snapshot (`' + Object.keys(sheets).length + '` Tabs) + Live-DB-Introspektion (`' + Object.keys(db).length + '` Relationen).');
lines.push('> Erzeugt aus committeten Snapshots — Live neu ziehen mit `dump-db-inventory.js` (PG-Tunnel) / `dump-sheet-inventory.js` (XLSX).', '');

const order = Object.keys(TABS).filter((t) => sheets[t]);
for (const tab of order) {
  const cfg = TABS[tab];
  const info = sheets[tab];
  const kindLabel = { source: 'QUELLDATEN', staging: 'STAGING (transient)', meta: 'META/berechnet' }[cfg.kind];
  lines.push('## `' + tab + '`  — ' + kindLabel + '  (' + info.ncols + ' Spalten, ' + info.ndata + '+ Zeilen)');
  if (cfg.note) lines.push('', cfg.note);
  if (cfg.table) lines.push('', 'Primäre DB-Tabelle: `automatenlager.' + cfg.table + '`' + (db[cfg.table] ? ' (' + db[cfg.table].rows + ' Zeilen)' : ''));
  lines.push('');
  if (cfg.kind !== 'source') {
    lines.push('_Nicht Cutover-relevant: ' + (cfg.kind === 'staging' ? 'Workflow-Zwischenstand, wird neu erzeugt.' : 'berechnet/Meta.') + '_', '');
    continue;
  }
  lines.push('| Sheet-Spalte | Status | DB-Ziel / Hinweis |', '|---|---|---|');
  for (const col of info.headers) {
    const marker = cfg.map ? cfg.map[col] : undefined;
    const [status, hint] = classify(cfg.table, col, marker);
    lines.push('| `' + col + '` | ' + status + ' | ' + hint + ' |');
    if (status.startsWith('❌')) gaps.push({ tab, col, hint });
  }
  lines.push('');
}

lines.push('## Lücken-Zusammenfassung (Cutover-Risiko)', '');
lines.push('Spalten mit Quelldaten, die NUR im Sheet leben (kein DB-Ziel) — vor #9 zu schließen:', '');
lines.push('| Tab | Sheet-Spalte | Hinweis |', '|---|---|---|');
for (const g of gaps) lines.push('| `' + g.tab + '` | `' + g.col + '` | ' + g.hint + ' |');
lines.push('', '**' + gaps.length + ' offene Lücken** über ' + new Set(gaps.map((g) => g.tab)).size + ' Tabs. '
  + '`produktart` ist NICHT mehr darunter (über #62 erledigt).', '');

lines.push('## Empfehlung für den Cutover (#9)', '');
lines.push('Nach Migrations-Priorität gruppiert — vor dem Sheets-Abschalten zu schließen:', '');
lines.push('### A. Echte Quelldaten ohne DB-Heimat (HOCH — sonst Datenverlust)');
lines.push('- **`Bestandsaufnahme_Handschrift`** (29 Zeilen): komplette manuelle Inventur-Erfassung, KEINE DB-Tabelle. Braucht ein eigenes Zielmodell (z. B. `inventory_counts`).');
lines.push('- **`Einstellungen`** (Key/Value): Konfig wie `kleinunternehmer_aktiv`, `mwst_snack/getraenk` — WF8 liest sie aus dem Sheet. Single-Source-Lücke (vgl. #56): vor Cutover in DB-Config (`classification_settings` o. ä.) spiegeln, sonst verliert WF8 seine Steuer-/MwSt-Parameter.');
lines.push('- **`Lagerchargen.storage_location`**: Lagerort je Charge — reales Stammdatum, fehlt in `stock_batches`.');
lines.push('');
lines.push('### B. Audit-/Historien-Daten (MITTEL — Nachvollziehbarkeit)');
lines.push('- **`Produktwechsel_Log`** (alt/neu-Produkt, Gründe): `stock_movements` bildet nur Mengenbewegung ab, nicht die Wechsel-Historie. Bei Bedarf erweitern.');
lines.push('- **`Produkt_Aliase`** (`supplier`, `last_seen_at`, `invoice_item_example`): Zusatzkontext zum Alias, fehlt in `product_aliases`.');
lines.push('- **`Lagerchargen.notes`**, **`Fehler_und_Hinweise.nayax_product_name`**: Freitext/Kontext.');
lines.push('');
lines.push('### C. Ableitbar / niedrig (NIEDRIG — meist kein echter Verlust)');
lines.push('- `Produkte.replenishment_status` / `min_stock` / `stock_source`, `Produkt_Aliase.normalized_alias`: berechenbar/ableitbar oder Anzeige-Status; vor Cutover bewerten, ob überhaupt nötig.');
lines.push('');
lines.push('> Nächster Schritt: je Bucket-A-Punkt ein Migrations-Issue unter #9 anlegen (z. B. via `spec-to-issue`). Dieses Audit ist die Grundlage; es verändert KEINE Produktionsdaten.', '');

const outPath = path.join(DIR, '..', '..', '..', 'docs', 'data-model', 'sheets-db-audit.md');
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log('Report geschrieben:', path.relative(path.join(DIR, '..', '..', '..'), outPath));
console.log('Offene Lücken:', gaps.length);
for (const g of gaps) console.log('  -', g.tab + '.' + g.col, '->', g.hint);
