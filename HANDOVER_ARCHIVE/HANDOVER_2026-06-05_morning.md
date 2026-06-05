# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 — Session abgeschlossen: WF3 Auto-Restart + Claude-Proposals

Suite **847/847** (keine neuen Tests; Änderungen sind rein n8n-seitig).

---

### Heute erledigt

#### WF-Val v3: WF3 Auto-Restart (Fan-out-Architektur)

**WF-Val** (`pdIjiyIfVIIPuJIt`) wurde von v2 auf v3 upgegradet:

**Neue Architektur (Fan-out):**
```
Schedule (04:15 UTC)
  → PG: DB-Konsistenzcheck (5 UNION ALL)
  → Code: Aggregieren + restart_flag setzen
    ↓ Fan-out: BEIDE IFs parallel
  IF: WF3 Neustart nötig?          IF: Probleme gefunden?
    JA → HTTP: WF3 starten            JA → Gmail: Alert
    NEIN → NoOp WF3 OK                NEIN → NoOp Alles OK
```

**Key-Entscheidung:** Code-Node sendet seinen Output an BEIDE IF-Nodes gleichzeitig (n8n-Fan-out über ein Output-Port, zwei Ziel-Nodes). Kein Merge-Node nötig.

**WF3 Restart-Mechanismus:**
- HTTP Request POST `https://hp-mini-server.tail573a13.ts.net/api/v1/workflows/wbOhFKXQqBpJWB1w/execute`
- Auth via n8n-Credential "n8n Mini API" (httpHeaderAuth, ID: `sk4oJ1b15NNHkyK3`, X-N8N-API-KEY)
- Feuer-und-vergiss: kein Re-Check im selben Lauf (WF3 läuft sowieso alle 5 Min)
- Email zeigt "WF3 haengt — Auto-Neustart ausgeloest" als orangene Sektion

**SQL-Logik (unverändert ggü. v2):**
- `wf3_stale`: `updated_at < NOW() - 30 Min` (nicht `last_inventory_review_at`)
- `alte_warnungen`: `severity != 'info'` (schliesst BACKUP_OK aus)

**Neue Datei:** `C:\tmp\fix_wfval_v3.py`
**JSON im Repo:** `WF-Val - DB Konsistenz-Check.json` (9 Nodes)

---

#### WF-Claude-Proposals: Stale Proposals automatisch bearbeiten

**Neuer Workflow** (`hU7Aev7G4MaMv2yR`, Name: "WF-Claude-Proposals") — **aktuell DEAKTIVIERT**:

**Flow:**
```
Schedule (04:30 UTC täglich)
  → PG: pending proposals > 14 Tage lesen (max 20)
  → Code: für Claude formatieren (skip=true wenn leer)
  → IF: Proposals vorhanden?
    JA → HTTP: Claude Haiku (claude-haiku-4-5-20251001) bewerten
         → Code: JSON parsen + Batch-UPDATE-SQL + Email bauen
         → PG: Status UPDATE (approve/reject per CASE WHEN)
         → IF: Eskalationen?
           JA → Gmail: Bericht mit approve/reject/escalate
           NEIN → NoOp
    NEIN → NoOp
```

**Claude-Entscheidungslogik:**
- `approve`: Produkt existiert im Katalog + aktiv + klarer Grund
- `reject`: Produkt NICHT im Katalog + >21 Tage alt + unklarer Grund
- `escalate`: Neue Produkte, große Änderungen, Unsicherheit → Email an User

**Sicherheit:** Nur proposal_keys aus der DB-Antwort werden akzeptiert (Whitelist-Filter im Code-Node). SQL via CASE WHEN mit escaped Keys.

**Claude-Credential:** `HykwFghdDuUDa2lu` (Name: "Claude API Key", httpHeaderAuth) — selbe wie WF1

**Aktivieren (nach Prüfung in n8n UI):**
```
POST /api/v1/workflows/hU7Aev7G4MaMv2yR/activate
```

**Neue Dateien:**
- `C:\tmp\create_wf_claude_proposals.py`
- `WF-Claude-Proposals.json` (11 Nodes) — im Repo

---

### Vorherige Session (2026-06-05): Vollständige Google-Sheets→PostgreSQL-Migration

(Archiv: `HANDOVER_ARCHIVE/HANDOVER_2026-06-05.md`)

Alle WF1–WF9 + WF-Val vollständig auf PostgreSQL migriert. WF4/WF7/WF9 Audit-Nodes aktiviert und auf `warnings`-Tabelle umgestellt. WF-Val v2 als DB-Konsistenz-Checker neu gebaut (5 UNION ALL Checks, BACKUP_OK-Fix, updated_at für WF3-Stale-Check).

---

### OFFEN — brauchen strategische User-Entscheidung

| # | Inhalt | Warum offen |
|---|--------|-------------|
| **#9** | v2-Abschaltung | Strategische Entscheidung (wann/wie) |
| homelab **#48** | Rückwirkende Umbuchung betroffener Verkäufe | Komplex, braucht User-Input |
| **WF-Claude-Proposals** | Workflow prüfen + aktivieren | Erstmal deaktiviert — User soll in n8n UI reviewen |

---

### Bekannte Lücken / Folge-Issues

- **WF-Claude-Proposals deaktiviert:** Muss manuell in n8n UI geprüft und dann aktiviert werden. Zum Testen: "Test workflow" Button in n8n nutzen.
- **WF3 Restart-URL intern:** Die HTTP-Request-URL `https://hp-mini-server.tail573a13.ts.net/api/v1/...` wird von WF-Val FROM Mini heraus aufgerufen. Falls das Routing nicht funktioniert (Docker→Tailscale), Fallback auf `http://host.docker.internal:5678/api/v1/...`.
- **WF2 schreibt Preise noch nicht bei Neuanlage** (pgw_write kennt kein `price`-Event). Neue Produkte brauchen manuellen Preis-Insert.

---

### Credentials auf Mini

| Name | ID | Typ | Zweck |
|------|----|-----|-------|
| PostgreSQL | `Jept3990Uq8aN3Tr` | postgres | DB-Verbindung |
| Gmail account | `8zhryCRhHAc2OnKA` | gmailOAuth2 | Alert-Mails |
| Claude API Key | `HykwFghdDuUDa2lu` | httpHeaderAuth | Claude-API (WF1 + WF-Claude-Proposals) |
| n8n Mini API | `sk4oJ1b15NNHkyK3` | httpHeaderAuth | WF3-Restart per n8n-API (WF-Val v3) |

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

### n8n-Workflow-IDs (Mini)

| WF | ID | Status |
|----|----|--------|
| WF1 Rechnungseingang | `wnGAwHhgfXq2ATM8` | aktiv |
| WF2 Produktauswahl | `DPVPtNiByNhpFHzj` | aktiv |
| WF3 Nayax FIFO | `wbOhFKXQqBpJWB1w` | aktiv, alle 5 Min |
| WF4 MDB-Mapping | `6tOZnWsxBNzHaVqA` | aktiv |
| WF5 MHD-Monitor | `9NJlEHCH3JJXHKOH` | aktiv |
| WF7 Nachfüllung | `0oRIiVFr5Q7FF6ow` | aktiv |
| WF8 GuV-Aggregator | `WJ4VkGSgPbZZniG4` | aktiv |
| WF9 Pickliste | `nh8Tmg7klwGVjKui` | aktiv |
| WF-Val DB-Check | `pdIjiyIfVIIPuJIt` | aktiv, 04:15 UTC |
| WF-Claude-Proposals | `hU7Aev7G4MaMv2yR` | **DEAKTIVIERT** |

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
-- WF-Val manuell testen
SELECT check_type, key, message
FROM (
  SELECT 'wf3_stale' AS check_type, workflow_key AS key,
    'WF3 seit ' || ROUND(EXTRACT(EPOCH FROM (NOW()-updated_at))/60,1) || ' Min' AS message
  FROM automatenlager.workflow_state
  WHERE workflow_key = 'WF3_NAYAX_FIFO'
    AND (updated_at IS NULL OR updated_at < NOW() - INTERVAL '30 minutes')
) x;

-- Pending Proposals (fuer Claude-Proposals)
SELECT proposal_key, status, reason, created_at,
  EXTRACT(DAY FROM NOW()-created_at)::int AS days_pending
FROM automatenlager.product_change_proposals
WHERE status = 'pending'
ORDER BY created_at;

-- Workflow-State
SELECT * FROM automatenlager.workflow_state;
```

### Lehren dieser Session
- **n8n Fan-out:** Ein Output-Port kann zu mehreren Nodes verbinden — in `connections` einfach mehrere Einträge im Array: `[[{node:A},{node:B}]]`. Kein Merge-Node nötig.
- **n8n Credential-API:** POST /credentials braucht `allowedDomains` im `data`-Objekt (auch als leerer String `''`).
- **n8n POST /workflows body:** `active`-Feld ist read-only und darf nicht im Body sein.
- **WF3-Restart:** HTTP POST /api/v1/workflows/{id}/execute startet WF3 direkt ohne ExecuteWorkflow-Trigger in WF3 zu benötigen.

---
