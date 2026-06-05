# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 — Session abgeschlossen: WF3-PGW-Bugfix + Chargensuche

Suite **847/847**. Alle offenen Punkte der Session abgearbeitet.

---

### Heute erledigt

#### WF3 Phantom-Sale-Fix (Commit `0c8203d`)
- **Ursache:** `Google Sheets - Transaktionen anhängen` war disabled → n8n passthrough → Items flossen zu `Prepare PGW - sale`.
- Phantom-Rows mit `transaction_id=undefined` → `String(undefined)="undefined"` → pgw_write schlägt alle 5 Min fehl.
- **Fix:** `.filter()` vor `.map()` in `Prepare PGW - sale`: Items mit null/undefined/leerer `transaction_id` oder `machine_id` werden herausgefiltert.
- WF3 auf Mini aktualisiert (ID: `wbOhFKXQqBpJWB1w`), exportiert + committed. Fehler-E-Mails stoppen ab nächstem WF3-Lauf.

#### Red Bull Spring — manuell ausgesondert
- `batch_id=29`, `status='leer'`, `remaining_qty=0` → direkt per SQL auf `status='ausgesondert'` gesetzt.
- Alle Slots (326, 33, 234, 388) bereits `active=f`.

#### Feature: Chargensuche auf /lager (Commit `02acc53`)
- **User-Anfrage:** Produkte suchen und aussortieren auch ohne aktiven Slot.
- `GET /api/v2/inventory/batch-search?q=<search>` — ILIKE auf Produktname, max. 50 Treffer, `status ≠ ausgesondert`.
- Neue Sektion auf `/lager` unterhalb der normalen Bestandstabelle: Freitext-Suche (Debounce 320ms), Ergebnistabelle mit Aussortieren-Button (reuse `openWriteOffDialog`).
- CSS: `v3-lager-search-section` mit Trenner-Border.
- Deploy: Mini via `git pull --ff-only + docker restart`, live verifiziert (Endpunkt + 847 Tests grün).

---

### Technische Architektur-Notiz: MCP vs. Mini-n8n

Die MCP-n8n-Verbindung (im Claude-Interface) zeigt die **lokale** n8n-Instanz (localhost:5678, Workflow-IDs abweichend, alle inactive). Für Produktionsarbeit immer direkt die Mini-API verwenden:

```
BASE: https://hp-mini-server.tail573a13.ts.net/api/v1/...
HEADER: X-N8N-API-KEY: <aus C:\Users\patri\.n8n-api-key>
```

Oder via Bash curl, nicht via MCP-n8n-Tool.

---

### OFFEN — brauchen strategische User-Entscheidung

| # | Inhalt | Warum offen |
|---|--------|-------------|
| **#9** | v2-Abschaltung | Strategische Entscheidung (wann/wie) |
| homelab **#48** | Rückwirkende Umbuchung betroffener Verkäufe | Komplex, braucht User-Input |

---

### Bekannte Lücken / Folge-Issues

- **WF3 liest noch Lagerchargen-remaining_qty aus Sheets** (Read-Nodes aktiv). Sheets-remaining_qty wird jetzt stale. WF3's FIFO-Logik basiert noch auf Sheet-Daten — langfristig auf PG umstellen.
- **WF2 schreibt Preise noch nicht bei Neuanlage** (pgw_write kennt kein `price`-Event). Neue Produkte brauchen manuellen Preis-Insert.
- **4 Preisschätzungen** (source=`estimated`): Red Bull Summer Edition, Hochwald Eiskaffee, Pick Up, Milka Oreo — nach erstem echten Verkauf korrigieren.
- **pgw_write liest `purchase_date` nicht** aus dem Payload — Trigger als Fallback aktiv.
- **Chargensuche zeigt nur status ≠ ausgesondert** — 'leer'-Chargen sind sichtbar + aussortierbar, korrekt so.

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

### Deploy-Weg (Referenz)
SSH: `ssh -i "C:\Users\patri\.ssh\miniserver_key" -o StrictHostKeyChecking=no patri@100.68.148.46`
Deploy: `wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard"`
DB-Zugriff: `wsl -d Ubuntu-24.04 -- docker exec homelab-postgres psql -U homelab -d homelab -c "..."`

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
```

### Lehren dieser Session
- **MCP-n8n zeigt lokale Instanz:** Immer direkt `curl -H "X-N8N-API-KEY: ..." https://hp-mini-server.../api/v1/` für Produktionsarbeit.
- **n8n Passthrough-Falle:** Disabled Nodes leiten alle Input-Items unverändert weiter — nachgelagerte Nodes müssen selbst filtern.
- **Nayax sieht NUR Automateninhalt, NIE Backstock.** `remaining_qty` = Automat+Backstock.
- **SSH-Quoting:** Für bash `-c` mit einfachen Anführungszeichen intern immer doppelte Anführungszeichen für den äußeren SSH-String verwenden.

---
