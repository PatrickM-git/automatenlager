# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 — Session abgeschlossen: Vollständige Google-Sheets→PostgreSQL-Migration

Suite **847/847** (keine neuen Tests; Migration ist rein n8n-seitig).

---

### Heute erledigt

#### Vollständige Sheets→PG-Migration aller n8n-Workflows (WF1–WF9 + WF-Val)

**Ziel:** Google Sheets vollständig aus dem Datenpfad entfernen — SQL als einzige Source of Truth.

**Durchgeführt:**

| WF | Was geändert | Status |
|----|-------------|--------|
| WF3 | Lagerchargen-Read + Transaktionen-Dedup + Workflow-State (Read+Write) → PG | aktiv |
| WF5 | Produkte, Hinweise, Transaktionen, Hinweise-Auflösen → PG; Hinweise-Append disabled | aktiv |
| WF7 | Produkte, Hinweise, Lagerchargen, Slot-Update, Hinweise-Auflösen → PG; Audit-Append disabled | aktiv |
| WF8 | Alle 5 Read-Nodes (Transaktionen, Lagerchargen, Produkte, GuV-Konfig, Tagesposten) → PG; Tagesposten-Append disabled | aktiv |
| WF9 | Hinweise, Produkte, Lagerchargen, Slot-Update, Hinweise-Auflösen → PG; Audit-Append disabled | aktiv |
| WF4 | Alle 5 Sheets-Write-Nodes disabled (DB-Writes laufen bereits via PGW) | aktiv |
| WF1 | Produkte, Lagerchargen, Aliase, Prüfung-Dedup, Prüfung-Insert → PG | aktiv |
| WF2 | Prüfung-Queue (Lesen/Approve/Reject) + Produkte/Aliase/Produkt-Check → PG; Redundante Sheets-Writes disabled | aktiv |
| WF-Val | Alle Sheets-Nodes disabled; Workflow deaktiviert (nach Migration obsolet) | deaktiviert |

**Technische Details:**
- PG-Credential-ID: `Jept3990Uq8aN3Tr` (Name: "PostgreSQL")
- Neue DB-Tabelle: `automatenlager.workflow_state` (DDL: `dashboard/db-migrations/0006-workflow-state.sql`) — ersetzt Sheets-Tab "letzter Verkaufsworkflow"
- Mojibake-Problem gelöst: WF4/WF5/WF7 hatten Latin-1/UTF-8-Doppelencoding in Node-Namen (ä→Ã¤, ö→Ã¶, ü→Ã¼, ß→ÃŸ); WF4 über Type-Iteration gepatcht, WF5/WF7 über Substring-Match
- WF1 hatte `?`-Zeichen statt Umlaute im Node-Namen → exaktes Literal im Patch verwendet
- n8n PUT-API: nur `name/nodes/connections/settings.executionOrder` erlaubt (kein `binaryMode`)
- Tool: `C:\tmp\patch_wfs.py` (Patch-Generator) + `C:\tmp\upload_wfs.py` (Upload)

**Betroffene SQL-Endpunkte (neu, direkt in WFs):**
- `SQL_PRODUKTE` — slot_assignments + products + machines + prices (LATERAL)
- `SQL_LAGERCHARGEN` — stock_batches + products, status IN ('aktiv','active','reserve')
- `SQL_ALIASE` — product_aliases + products
- `SQL_TRANSAKTIONEN_DEDUP` — sales_transactions, 120-Tage-Fenster
- `SQL_TRANSAKTIONEN_WF5` — sales_transactions mit machine/product/slot join, 90 Tage
- `SQL_TRANSAKTIONEN_WF8` — sales_transactions mit LATERAL batch_key für EK-Schätzung
- `SQL_HINWEISE` — warnings + products + machines, 500 aktuellste
- `SQL_HINWEISE_RESOLVE` — UPDATE warnings SET resolved=TRUE by created_at
- `SQL_WORKFLOW_STATE_READ/WRITE` — workflow_state UPSERT für WF3 Lauf-Tracking
- `SQL_GUV_KONFIG` — classification_settings (JSONB, mandant __default__)
- `SQL_GUV_TAGESPOSTEN` — guv_daily + machines + products, 90 Tage
- `SQL_SLOT_UPDATE` — UPDATE slot_assignments.current_machine_qty by product_slot_key
- `SQL_PRUEFUNG_DEDUP/LESEN/APPROVE/REJECT/INSERT` — product_change_proposals

---

### OFFEN — brauchen strategische User-Entscheidung

| # | Inhalt | Warum offen |
|---|--------|-------------|
| **#9** | v2-Abschaltung | Strategische Entscheidung (wann/wie) |
| homelab **#48** | Rückwirkende Umbuchung betroffener Verkäufe | Komplex, braucht User-Input |
| **WF-Val** | Drift-Check Sheets vs. DB — nach Migration neu schreiben oder archivieren? | Workflow derzeit deaktiviert |

---

### Bekannte Lücken / Folge-Issues

- **WF5 Hinweise-Append deaktiviert:** Warnungs-Schreib-Pfad war bereits via WF-PGW-WF5 in der DB; der Sheets-Append ist jetzt disabled.
- **WF7/WF9 Audit-Append deaktiviert:** Kein DB-Äquivalent vorhanden; Audit-Schreibpfad für Nachfüllung/Pickliste fehlt noch.
- **WF2 schreibt Preise noch nicht bei Neuanlage** (pgw_write kennt kein `price`-Event). Neue Produkte brauchen manuellen Preis-Insert.
- **4 Preisschätzungen** (source=`estimated`): Red Bull Summer Edition, Hochwald Eiskaffee, Pick Up, Milka Oreo — nach erstem echten Verkauf korrigieren.

---

### ENV-Zustand Mini (homelab/.env)
```
DASHBOARD_ADMIN_LOGIN=patrickmatthes2609@gmail.com
DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16
DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1
```

### DB-Trigger (alle aktiv auf Mini)
| Trigger | Tabelle | Funktion |
|---------|---------|----------|
| `trg_deduct_stock_on_machine_sale` | `slot_assignments` (AFTER UPDATE) | FIFO-Abzug remaining_qty bei Nayax-Absenkung |
| `trg_default_purchase_date` | `stock_batches` (BEFORE INSERT) | purchase_date = received_at als Fallback |
| `trg_apply_stock_movement` | `stock_movements` (AFTER INSERT) | wendet stock_movement auf stock_batches.remaining_qty an |

### Deploy-Weg (Referenz)
SSH: `ssh -i "C:\Users\patri\.ssh\miniserver_key" -o StrictHostKeyChecking=no patri@100.68.148.46`
Deploy: `wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard"`
DB-Zugriff: `wsl -d Ubuntu-24.04 -- docker exec homelab-postgres psql -U homelab -d homelab -c "..."`
DDL-Migration (0006): `wsl -d Ubuntu-24.04 -- docker exec homelab-postgres psql -U homelab -d homelab -f /repo/dashboard/db-migrations/0006-workflow-state.sql`

### Mini n8n API
```
BASE: https://hp-mini-server.tail573a13.ts.net/api/v1/
HEADER: X-N8N-API-KEY: $(cat C:\Users\patri\.n8n-api-key)
```
Wichtig: MCP-n8n-Tool zeigt NICHT die Mini-Instanz, sondern localhost:5678 (lokal, veraltet).

### Nützliche Diagnose-Queries
```sql
-- Vollständige Bestands-Übersicht
SELECT p.name,
  SUM(sb.initial_qty)    AS initial,
  SUM(sb.remaining_qty)  AS db_gesamt,
  COALESCE(SUM(sa.current_machine_qty),0) AS nayax_automat,
  SUM(sb.remaining_qty) - COALESCE(SUM(sa.current_machine_qty),0) AS backstock_errechnet
FROM automatenlager.stock_batches sb
JOIN automatenlager.products p ON p.product_id=sb.product_id
LEFT JOIN automatenlager.slot_assignments sa ON sa.product_id=sb.product_id AND sa.active=TRUE
WHERE sb.status NOT IN ('ausgesondert','leer','ausgebaut')
GROUP BY p.name ORDER BY p.name;

-- Preise aller aktiven Slots
SELECT p.name, pr.sale_price_gross, pr.source
FROM automatenlager.prices pr
JOIN automatenlager.slot_assignments sa ON sa.slot_assignment_id = pr.slot_assignment_id
JOIN automatenlager.products p ON p.product_id = sa.product_id
WHERE sa.active = TRUE AND pr.valid_to IS NULL
ORDER BY p.name;

-- Workflow-State lesen
SELECT * FROM automatenlager.workflow_state;
```

### Lehren dieser Session
- **Mojibake in n8n-JSON:** WF4/5/7 hatten doppelt-encodierte Umlaute (Latin-1→UTF-8-Fehler); Node-Namen per Type-Iteration oder Substring-Match patchen, nicht per exaktem Unicode-String.
- **n8n PUT-API erlaubt nur 4 Felder:** `name`, `nodes`, `connections`, `settings.executionOrder` — kein `binaryMode` oder andere `settings`-Keys.
- **WF-Val deaktiviert:** Nach vollständiger Sheets-Migration ist der Drift-Check obsolet.

---
