# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 — Session abgeschlossen: #31 + #78 + #87 + #91 + #92 + #93

Suite **847/847**. Alle 6 Issues abgearbeitet und geschlossen.

---

### Heute erledigt

#### #31 Feature: Editierbare Schwellwerte
- `settings_thresholds`-Relation, Migration 0002, API + Frontend live. Issue geschlossen.

#### #78: F1 scharfschalten
- `DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1` + `DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16`.
- Live: `:8443` → role=admin. Issue geschlossen.

#### #87: Bestandsdrift-Analyse + fehlgeschlagene Reconciliation
- Erkenntnis: Nayax sieht NUR Automateninhalt, NIE Backstock.
- `remaining_qty` = Automat + Backstock (Gesamt) — NIE auf `current_machine_qty` setzen.
- Fehlgeschlagener Reconciliation-Versuch vollständig rückgängig gemacht (33 Chargen auf Backup-Werte zurückgesetzt).
- Backup: `C:/tmp/backup_remaining_qty_pre_reconciliation_2026-06-05.txt`.
- Issue geschlossen.

#### #93: Echtzeit-remaining_qty — DB-Trigger (Commit `e6f41d0`)
- `trg_deduct_stock_on_machine_sale` auf `slot_assignments.current_machine_qty`.
- Wenn WF3 (alle 5 Min) Nayax-Daten aktualisiert und Wert sinkt → FIFO-Abzug von `stock_batches.remaining_qty`.
- Steigung (Nachfüllung Backstock→Automat) → kein Abzug ✓.
- Produktwechsel am Slot → WHEN-Guard.
- 100 % Nayax-Verkäufe erfasst. Migration `0003-stock-deduct-trigger.sql`. Issue geschlossen.

**WF3 Sheet-Write-Nodes deaktiviert (Commit `4db3d81`):**
- 6 Google-Sheets-Write-Nodes disabled: Lagerchargen aktualisieren, Transaktionen anhängen, Hinweise anhängen, Append row in sheet, letzter Verkaufsworkflow aktualisieren, Produktbestand Update.
- 3 Read-Nodes bleiben aktiv (WF3 liest noch aus Sheets für FIFO-Logik).
- Google Sheets ist keine Schreib-Wahrheitsquelle mehr für Bestand.

#### #92: purchase_date in stock_batches (Commit `15e7e9e`)
- Backfill: 59 Chargen `purchase_date = received_at` ✓.
- `trg_default_purchase_date` (BEFORE INSERT): Fallback für pgw_write.
- WF2 (Mini, `X2RU2cHm78rkIWMf`): sendet `purchase_date` explizit im data-Payload.
- Migration `0004-purchase-date-trigger.sql`. Issue geschlossen.

#### #91: prices-Tabelle befüllt (Commit `15e7e9e`)
- **36 Preise** aus `sales_transactions` Mode-Preis (source=`sales_transactions_mode`).
- **4 Preisschätzungen** für neue Produkte ohne Transaktionen (source=`estimated`):
  - Red Bull Summer Edition: 2.00, Hochwald Eiskaffee: 1.50, Pick Up: 1.00, Milka Oreo: 1.20.
- Alle 40 aktiven Slots haben jetzt Preise → Dashboard zeigt sale_price_gross korrekt.
- WF4/wf4-product-reads.js liest `prices` via LATERAL-Subquery (war schon implementiert).
- Issue geschlossen.

---

### OFFEN — brauchen strategische User-Entscheidung

| # | Inhalt | Warum offen |
|---|--------|-------------|
| **#9** | v2-Abschaltung | Strategische Entscheidung (wann/wie) |
| homelab **#48** | Rückwirkende Umbuchung betroffener Verkäufe | Komplex, braucht User-Input |

---

### Bekannte Lücken / Folge-Issues

- **WF3 liest noch Lagerchargen-remaining_qty aus Sheets** (Read-Nodes aktiv). Sheets-remaining_qty wird jetzt stale (nicht mehr durch WF3 aktualisiert). WF3's FIFO-Logik basiert auf Sheet-Daten — langfristig auf PG umstellen (eigenes Issue wenn relevant).
- **WF2 schreibt Preise noch nicht bei Neuanlage** (pgw_write kennt kein `price`-Event). Neue Produkte brauchen manuellen Preis-Insert oder Folge-Issue.
- **5 Preisschätzungen** (Milka Oreo, Pick Up, Red Bull Summer, Hochwald Eiskaffee) — sollten nach erstem echten Verkauf korrigiert werden (UPDATE prices SET sale_price_gross = ... WHERE source='estimated' AND slot_assignment_id = ...).
- **pgw_write liest purchase_date nicht** aus dem Payload — Trigger (`trg_default_purchase_date`) übernimmt das als Fallback. pgw_write-Update bleibt optional.

---

### ENV-Zustand Mini (homelab/.env)
```
DASHBOARD_ADMIN_LOGIN=patrickmatthes2609@gmail.com
DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16
DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1
```

### DB-Trigger (alle drei aktiv auf Mini)
| Trigger | Tabelle | Funktion |
|---------|---------|----------|
| `trg_deduct_stock_on_machine_sale` | `slot_assignments` (AFTER UPDATE) | FIFO-Abzug remaining_qty bei Nayax-Absenkung |
| `trg_default_purchase_date` | `stock_batches` (BEFORE INSERT) | purchase_date = received_at als Fallback |
| *(kein Name, war vorher)* | — | — |

### Deploy-Weg (Referenz)
SSH via `ssh -F ~/.ssh/config miniserver` (User=patri, Host=100.68.148.46, WSL Ubuntu-24.04).
`wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard"`.
DB-Zugriff: `docker exec -i homelab-postgres psql -U homelab -d homelab < /tmp/file.sql`

### Nützliche Diagnose-Queries
```sql
-- Vollständige Bestands-Übersicht (remaining = Automat + Backstock)
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
```

### Lehren dieser Session
- **Nayax sieht NUR Automateninhalt, NIE Backstock.** `remaining_qty` = Automat+Backstock. NIE auf `current_machine_qty` setzen.
- **Preise aus Mode-Preis** (häufigster Stückpreis) der sales_transactions sind zuverlässiger als Average (Ausreißer durch Qty>1).
- **SSH-Quoting-Falle:** Befehle mit Anführungszeichen immer als `.sql`-Datei via SCP + `psql < /tmp/file.sql`.
- **n8n PUT-API:** nur `name`, `nodes`, `connections`, `settings:{executionOrder}` — keine anderen top-level-Felder.
- **Encoding-Artefakte in WF3:** `anhängen` → `anh?ngen` (U+FFFD). Node-Matching via Operation-Typ (append/update) statt Namens-String.

---
