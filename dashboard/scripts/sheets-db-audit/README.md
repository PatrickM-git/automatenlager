# Sheets→DB-Vollständigkeits-Audit (Issue #61)

Sicherheitsnetz vor dem Google-Sheets-Cutover (#9): listet jede Sheet-Spalte je Tab
und ihren DB-Status, damit nichts verloren geht. **Read-only / analytisch.**

## Erneut laufen lassen

```bash
# 1) DB-Inventur live ziehen (PG-Tunnel nötig)
cd dashboard && set -a; source .env.local; set +a
node scripts/sheets-db-audit/dump-db-inventory.js

# 2) Sheet-Inventur aus dem XLSX-Export ziehen (xlsx-Parser nötig)
node scripts/sheets-db-audit/dump-sheet-inventory.js [pfad/zum/export.xlsx]

# 3) Report neu generieren -> docs/data-model/sheets-db-audit.md
node scripts/sheets-db-audit/generate-audit.js
```

Ohne Tunnel/XLSX werden die committeten `*.snapshot.json` genutzt (Stand im Dateinamen
des XLSX-Exports). Die Tab→Tabelle/Spalten-Zuordnung ist in `generate-audit.js`
kuratiert; neue Sheet-Spalten erscheinen als „⚠ nicht klassifiziert" und sind dort
zu ergänzen.
