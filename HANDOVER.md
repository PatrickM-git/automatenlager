# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 Nachmittag — Prävention/Robustheit (4 Maßnahmen) + WF-Monitor-Reparatur

Suite **852/852 grün** (inkl. WF4-Mojibake-Fix, siehe Punkt 5).

Nach dem WF3-Crash-Fix vom Mittag: vier Präventionsmaßnahmen umgesetzt, dabei die **eigentliche Wurzel** des unbemerkten Crashes gefunden.

### 1. Akut: restliche `to_char`-DDTHH-Bugs gefixt
Derselbe PostgreSQL-Ordinal-Suffix-Bug (`'YYYY-MM-DDTHH24:MI:SS'`) steckte noch in **WF2, WF5, WF7, WF9** (24 Vorkommen). Alle auf `'YYYY-MM-DD"T"HH24:MI:SS'` umgestellt (T als Literal escaped). Live + Repo gefixt. Besonders kritisch: die `WHERE to_char(...) = '{{ $json.created_at }}'`-Vergleiche (Warnungen auflösen in WF5/7/9) matchten nur, weil der Bug auf beiden Seiten identisch war — der globale Replace fixt beide Seiten konsistent. Backups: `C:\tmp\backup_WF{2,5,7,9}_pre_ddthh_fix.json`.

### 2. Früher alarmieren: WF-Monitor repariert + gehärtet — **DIE WURZEL DES VORFALLS**
WF-Monitor (`EdgUfv1lMcE25Z3K`, alle 5 Min) war **komplett blind** für Workflow-Fehler — deshalb blieb der WF3-Crash 3 h unbemerkt. Drei verkettete Defekte:
- **(a) Schema-Bruch durch n8n 2.22.5:** Die `Postgres - n8n Execution Check`-Query nutzte `e.data::text` (auth-Erkennung). In 2.22.5 liegt die Spalte nicht mehr in `execution_entity`, sondern in der Tabelle `execution_data`. → ganze Query failte (`column e.data does not exist`), Node fing den Fehler still ab, Report bekam leere Daten → meldete „alles ok". **Fix:** `LEFT JOIN execution_data ed ON ed."executionId" = e.id`, `e.data` → `ed.data`.
- **(b) Henne-Ei-Blockade:** `Postgres - Existing Today Warnings` liefert an einem sauberen Tag 0 Zeilen → der nachgelagerte `Code - Build Monitoring Report` wurde von n8n übersprungen (0 Input-Items). Der Monitor konnte eine erste Warnung nur erzeugen, wenn schon eine existierte. **Fix:** `alwaysOutputData: true` auf allen 4 Lese-Postgres-Nodes.
- **(c) WF3 nicht überwacht:** WF3 fehlte in der `critical_workflow_last_runs`-Liste (letzter-Lauf-Check). **Fix:** WF3-ID ergänzt.
- **Zusätzlich:** Crash-/Ausfall-Alarme (WORKFLOW_ERROR, WORKFLOW_DAILY_FAIL, ERROR_RATE_SPIKE, AUTH_ERROR, CONTAINER_DOWN, PG_UNREACHABLE) deduplizieren jetzt **stündlich** statt täglich (`dedupBucket`/`isoHour`) → ein Dauer-Crash erinnert 1×/h statt 1×/Tag (ging vorher unter). Bestandsthemen weiter täglich.
- **Feintuning:** auth-Pattern `%401%` (zu breit, matchte jede Zahl mit „401" → falsche AUTH_ERROR-Klassifikation) → `%httpCode":401%`.
- **Verifiziert:** Nächster Lauf erkennt die WF3-Fehler (`status=alert, shouldSendMail=True`, Build Report läuft, 13 statt 8 Nodes).

### 3. Bug-Klasse verhindern: SQL-Date-Guard
- **Suite-Test** `dashboard/tests/sql-date-format-guard.test.js`: scannt alle `WF*.json` nach ungeschütztem `DDTHH` in `to_char`. Grün.
- **Projekt-Hook** `.claude/hooks/wf-sql-date-guard.js` (PostToolUse, registriert in `.claude/settings.json`): blockt das Schreiben von WF-JSON mit ungeschütztem `DDTHH` — analog zu `wf-encoding-guard.js`. Funktional getestet (exit 2 bei Bug, exit 0 bei korrekt).

### 4. Code robuster: `safeDate`-Helper in WF3
`Code - FIFO berechnen` hat einen `safeDate(value, fallback)`-Helper: kaputte/ungültige Datumswerte (Watermark, Cutover, Verkaufsdatum) fallen jetzt auf einen Fallback zurück statt `RangeError` zu werfen — ein einzelner kaputter Datensatz killt nicht mehr den ganzen Lauf. Syntax via `node --check` validiert, live verifiziert (WF3 läuft success).

### 5. WF4-Mojibake gefixt (beim Suite-Lauf entdeckt, auf User-Freigabe behoben)
**WF4 (`6tOZnWsxBNzHaVqA`) hatte Mojibake** in `normalize()`-Regexes UND Node-Namen — `Ã¼` statt `ü` (analog ä/ö/Ä/Ö/Ü/ß), 126 Vorkommen, Live + Repo (seit Migration c5579c0/f7d8a6b). Effekt: normalize mappte Umlaute nicht (`Müller`→`müller` statt `mueller`) — mildere Variante von Issue #15 (dort verschwand der Umlaut ganz). **Fix:** Roundtrip-Umkehrung `raw.encode('cp1252').decode('utf-8')` (Mojibake = UTF-8-Bytes als CP1252 fehlinterpretiert). Strenge Validierung vor Deploy: JSON valide, Node-Anzahl unverändert, 0 `Ã`-Marker, normalize-Test grün (`mueller groesse spass oel`), alle jsCode-Nodes `node --check`. Live deployt + Repo aktualisiert. Skript: `C:\tmp\fix_wf4_mojibake.py`, Backup: `C:\tmp\backup_WF4_pre_mojibake.json`. Suite jetzt **852/852**.

### 6. Mojibake-Guard gebaut + WF2/5/7/9 mit-saniert
Der erweiterte Guard deckte sofort auf, dass das Mojibake nicht nur WF4 betraf:
- **Hook** `wf-encoding-guard.js` erweitert: prüft jetzt zusätzlich zur U+FFFD-Variante den Mojibake-Marker `U+00C3` (Ã). ASCII-Escape `Ã` in der Regex (kein literales Mojibake im Hook selbst). Funktional getestet (Mojibake→exit 2, U+FFFD→exit 2, sauber→exit 0).
- **Suite-Test** `encoding-umlaut-fix.test.js` erweitert: „Kein WF-Export enthält Mojibake (U+00C3)" via `String.fromCharCode(0xC3)`.
- **Aufgedeckt + gefixt:** WF2/WF5/WF7/WF9 hatten dasselbe Mojibake (Live+Repo), teils in funktionalem Code (normalize-Regexes!). Alle per cp1252-Roundtrip saniert, Live-Vollscan jetzt 0 betroffen. **WF2 hatte DOPPELTES Mojibake** (zweimal cp1252-fehlinterpretiert, codepoints `Ã ƒ Â`) → 2 Roundtrip-Iterationen nötig (Logik: wiederholen bis Inhalt stabil/0, mit Validierung pro Schritt). normalize-Test bei WF2+WF4 grün (`mueller groesse spass`). Batch-Skript `C:\tmp\fix_mojibake_batch.py`, WF2 `C:\tmp\backup_WF2_pre_mojibake2.json`, Backups je `C:\tmp\backup_WF{2,5,7,9}_pre_mojibake*.json`.
- Suite **853/853** (config-secret-Test bei Volllast gelegentlich flaky mit ECONNRESET — isoliert grün).

---

### 8. Zwei Rand-Fixes (alert-digest self-healing + flaky Test)
- **alert-digest self-healing:** Die tägliche Alert-Mail (`lib/alert-digest.js`) nutzte die reconcile-Logik NICHT → veraltete WF5-Warnungen wären in die Mail gelandet. Jetzt `liveWarningReconcileSql(mhdDays)` in die Warnungs-Query eingebaut (Alias `w`, mhdDays Default 30) — identisch zum Cockpit. Kein Import-Zyklus.
- **Flaky config-secret-Test:** `req()`-Helper in `dashboard-config-secret.test.js` macht jetzt Retry (5×, backoff) gegen transiente `ECONNRESET` unter paralleler Last. Suite jetzt stabil **854/854** im Volllauf (vorher gelegentlich 1 Fail).

### 7. Self-Healing-Warnungen: aussortierte Produkte (Red Bull Spring)
User-Report: „Red Bull Spring wird als leer gemeldet" (aussortiertes Produkt). Befund: Produkt sauber ausgesondert (0 aktive Slots, Charge `ausgesondert`/0 Stück), aber eine `LOW_BATCH`-Warnung von WF5 (02.06.) hing verwaist → einziges vollständig-aussortiertes Produkt mit offener Warnung. **Wurzel:** `liveWarningReconcileSql` in `lib/overview-monitoring.js` hatte für LOW_BATCH `SUM(aktive Chargen) <= 5` — bei 0 aktivem Bestand (aussortiert) ist `0 <= 5` TRUE → Dauer-„leer". **Fix:** LOW_BATCH zusätzlich `EXISTS(aktiver Slot)` verlangt (MHD_NEAR/LOW_STOCK waren schon korrekt self-healing). Live-DB-verifiziert: Red Bull Spring→ausgeblendet, Skittles (aktiv, 5 Stk)→bleibt sichtbar. Akute Warnung in DB aufgelöst (`resolved_by='self-heal-aussortiert-2026-06-05'`). Test `AC-SELFHEAL` in `dashboard-v2-overview-monitoring.test.js` (liveWarningReconcileSql jetzt exportiert). Suite 854/854 (config-secret weiter gelegentlich flaky via ECONNRESET, isoliert grün). Inaktiv-Verwaltungsansicht bewusst NICHT gebaut (separat geplant).

---

## Stand: 2026-06-05 Mittag — WF3-Crash-Fix + WF8 Live-GuV + WF-Val-Restart-Fix

Suite **847/847** (keine neuen Tests; Änderungen sind rein n8n-seitig).

---

### Heute erledigt

#### WF3-Crash — Root Cause & Fix

**Root Cause:** PostgreSQL `to_char`-Format-String `'YYYY-MM-DDTHH24:MI:SS'` hat einen subtilen Bug:
- `DD` ist ein Muster für den Tag
- `TH` DIREKT nach einer Zahl = Ordinal-Suffix-Modifier (macht `DD` zu `05TH`)
- Der `T` in `DDTHH24` wird nicht als Literal behandelt, sondern als Teil des Ordinal-Suffixes `TH`
- Ergebnis: `"2026-06-05THH24:58:56"` statt `"2026-06-05T06:58:56"` — kein gültiges ISO-Datum
- `new Date("2026-06-05THH24:58:56.000Z")` → `Invalid Date` → `.toISOString()` wirft `RangeError` (Zeile 754 in Code - FIFO berechnen)

**Warum ab 07:50?** Davor war `last_inventory_review_at` in `workflow_state` NULL → COALESCE gab `''` → Fallback auf `inventory_cutover_datetime` (gültiger Wert). Um 07:50 wurde erstmals ein Watermark geschrieben, ab dann trug die buggy SQL-Ausgabe den Crash.

**Fix:** `'YYYY-MM-DDTHH24:MI:SS'` → `'YYYY-MM-DD"T"HH24:MI:SS'` (T in Anführungszeichen = PostgreSQL Literal)

**Gefixt in:**
- WF3 Node "Google Sheets - letzter Verkaufsworkflow lesen" (SQL)
- WF8 Node "Read - Verarbeitete_Transaktionen" (selber Bug, präventiv gefixt)

**Ergebnis:** WF3 läuft seit 11:10 UTC wieder erfolgreich. Alle 7 Transaktionen des Tages (inkl. 2 fehlende "kurz vor 12") sind jetzt in der DB.

---

#### WF8 — Live-GuV (alle 15 Min statt täglich 02:00)

**Problem:** GuV-Dashboard zeigte nur gestrigen Stand; WF8 lief täglich um 02:00 UTC.
**Analyse:** WF8's SQL liest bereits alle Transaktionen der letzten 120 Tage — auch von heute. Nur der Trigger war falsch (zu selten).
**Fix:** Trigger von `triggerAtHour: 2` (täglich) auf `minutesInterval: 15` (alle 15 Min) geändert.
**Neue WF8-ID:** `gyM9rnvUMfnv4x3G` (n8n aktualisierte auf 2.22.5, HANDOVER-Tabelle korrigiert).

---

#### WF-Val Auto-Restart — Fix (deactivate + activate)

**Problem:** WF-Val v3 rief `POST /api/v1/workflows/{id}/execute` auf → HTTP 405 (nicht unterstützt in n8n 2.x).
**Fix:** Zwei HTTP-Request-Nodes in Sequenz:
1. `POST .../deactivate` (Node: "HTTP - WF3 starten", umbenannt)
2. `POST .../activate` (neuer Node: "HTTP - WF3 aktivieren")

WF-Val reagiert korrekt auf echte WF3-Stagnation (updated_at > 30 Min alt).

---

#### n8n Container-Update (Nebeneffekt)

Docker-Restart hat n8n von **2.21.4 → 2.22.5** aktualisiert. JS Task Runner ist jetzt in internal mode aktiv. Alle Workflows laufen korrekt.

---

### Vorherige Session (2026-06-05 Früh): WF3 Auto-Restart + Claude-Proposals

(Archiv: `HANDOVER_ARCHIVE/HANDOVER_2026-06-05_morning.md`)

WF-Val v3 (Fan-out), WF-Claude-Proposals erstellt+aktiviert.

---

### OFFEN — brauchen strategische User-Entscheidung

| # | Inhalt | Warum offen |
|---|--------|-------------|
| **#9** | v2-Abschaltung | Strategische Entscheidung (wann/wie) |
| homelab **#48** | Rückwirkende Umbuchung betroffener Verkäufe | Braucht 14-Tage-Drift, frühestens 2026-06-08 |
| **WF-Claude-Proposals** | Workflow prüfen + aktivieren | Aktiv seit dieser Session — User soll Verhalten im UI beobachten |

---

### Bekannte Lücken / Folge-Issues

- **WF-Val Stale-Check**: `updated_at < NOW() - 30 Min` — bei 0 Verkäufen > 30 Min würde WF3 fälschlich als stale erkannt. In der Praxis unkritisch (Verkäufe kommen regelmäßig).
- **WF2 schreibt Preise noch nicht bei Neuanlage** (pgw_write kennt kein `price`-Event). Neue Produkte brauchen manuellen Preis-Insert.
- **WF-Claude-Proposals**: Prüfen ob Email-Versand bei ersten Läufen korrekt funktioniert.

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
| WF2 Produktauswahl | `X2RU2cHm78rkIWMf` | aktiv |
| WF3 Nayax FIFO | `wbOhFKXQqBpJWB1w` | aktiv, alle 5 Min |
| WF4 MDB-Mapping | `6tOZnWsxBNzHaVqA` | aktiv |
| WF5 MHD-Monitor | `3ceKeNWmdj455Tcr` | aktiv |
| WF7 Nachfüllung | `0oRIiVFr5Q7FF6ow` | aktiv |
| WF8 GuV-Aggregator | `gyM9rnvUMfnv4x3G` | aktiv, **alle 15 Min** |
| WF9 Pickliste | `nh8Tmg7klwGVjKui` | aktiv |
| WF-Val DB-Check | `pdIjiyIfVIIPuJIt` | aktiv, 04:15 UTC |
| WF-Claude-Proposals | `hU7Aev7G4MaMv2yR` | aktiv, 04:30 UTC täglich |

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

-- Heutige Transaktionen
SELECT COUNT(*) AS heute, MAX(settlement_at)::timestamp(0) AS letzte
FROM automatenlager.sales_transactions
WHERE settlement_at::date = CURRENT_DATE;

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
- **PostgreSQL `to_char` + `DDTH`-Falle:** `TH` nach einem Zahlmuster = Ordinal-Suffix-Modifier. `'YYYY-MM-DDTHH24:MI:SS'` → `TH` frisst den `T`-Literal, `H24` wird nicht als Pattern erkannt. Fix: `'YYYY-MM-DD"T"HH24:MI:SS'` (T in Anführungszeichen schützen).
- **n8n /execute 405:** Das Endpoint `/api/v1/workflows/{id}/execute` existiert in n8n 2.x nicht. Alternativer Restart: `/deactivate` + `/activate` nacheinander.
- **n8n Task Runner in 2.22.5:** Code-Nodes laufen im JS Task Runner (internal mode). `new Date()` ohne Argument funktioniert. Execution-Daten mit `?includeData=true` laden um vollständige Fehlerdetails zu sehen.
- **`lastNodeExecuted: null` != "kein Node lief":** Auch bei fehlerhaften Runs kann die Execution-Liste `lastNodeExecuted=null` zeigen, obwohl Nodes liefen. Immer `?includeData=true` für echte Fehlerdiagnose nutzen.
- **n8n-Versionsupdates bei Docker-Restart:** `docker restart` updated ggf. das Image. Vorher verifizieren ob das erwünscht ist.

---
