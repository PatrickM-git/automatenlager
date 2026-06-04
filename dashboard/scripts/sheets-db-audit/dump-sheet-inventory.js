'use strict';
// XLSX-Export -> sheet_inventory.snapshot.json (Tabs, Spalten-Header, Füllstände).
// Braucht den 'xlsx'-Parser (npm i xlsx --no-save). Pfad zum XLSX als argv[2] oder
// Default: neuestes *.xlsx im Repo-Root.
const fs = require('fs');
const path = require('path');
let XLSX; try { XLSX = require('xlsx'); } catch { console.error("Bitte 'xlsx' bereitstellen (npm i xlsx --no-save) oder Pfad anpassen."); process.exit(2); }
const root = path.join(__dirname, '..', '..', '..');
const file = process.argv[2] || fs.readdirSync(root).filter((f) => f.endsWith('.xlsx')).sort().pop();
const wb = XLSX.readFile(path.join(root, file), { sheetRows: 200 });
const out = {};
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
  const headers = (rows[0] || []).map((h) => String(h).trim()).filter(Boolean);
  const data = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  const fill = {}; headers.forEach((h, i) => { fill[h] = data.filter((r) => String(r[i] ?? '').trim() !== '').length; });
  out[name] = { ncols: headers.length, ndata: data.length, headers, fill };
}
fs.writeFileSync(path.join(__dirname, 'sheet_inventory.snapshot.json'), JSON.stringify(out, null, 1));
console.log('sheet_inventory.snapshot.json aktualisiert aus', file, '(', wb.SheetNames.length, 'Tabs )');
