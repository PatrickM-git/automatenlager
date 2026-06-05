# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 — #31 + #78 + #87 + #93 live

Suite **847/847**. Alle vorherigen Ergebnisse intakt.

### Heute erledigt

#### #31 Feature: Editierbare Schwellwerte (Pro-Automat, Ladenhüter-Tage)
- **Option A (additive `settings_thresholds`-Relation)** implementiert.
- `dashboard/lib/settings-thresholds.js`: THRESHOLD_DEFS + getThresholds/setThreshold/reset/resetAll.
- DB-Migration `0002-settings-thresholds.sql`, auf Mini angewendet.
- API: GET/PUT/DELETE `/api/v2/settings/thresholds[/:key]` (system.verwalten-Guard).
- Frontend: Schwellwert-Karte auf `/einstellungen`. Bugfix `d741b41`: `url.parse().query.machineId`.
- **Live verifiziert.** Issue #31 geschlossen.

#### #78: F1 scharfschalten (CIDR + Trusted Serve IP)
- `auth.js` → `isTrustedIdentityPath`: `DASHBOARD_TRUSTED_SERVE_IP`.
- `homelab/.env`: `DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16` + `DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1`.
- **Live verifiziert.** Issue #78 geschlossen.

#### #87: Bestandsdrift-Analyse + Reconciliation-Versuch (teils rückgängig)
- Erkenntnis: `sales_transactions` erfasst nur 6–30 % der echten Verkäufe → unbrauchbar für Bestandsrechnung.
- `current_machine_qty` (Nayax, alle 5 Min) = Automateninhalt; Backstock unsichtbar für Nayax.
- Reconciliation-Versuch (remaining_qty ← current_machine_qty) war **falsch** — vernichtet Backstock-Info.
- **Rückgängig gemacht:** 33 Chargen auf Backup-Werte zurückgesetzt.
- Absichtlich behalten: Skittles=5 (physisch bestätigt), 7 Days Crois. Double=8 (Backstock=0 bestätigt), Hochwald/Red Bull/Red Bull Summer=48 (gestrige Lieferung, nichts verkauft).
- Backup: `C:/tmp/backup_remaining_qty_pre_reconciliation_2026-06-05.txt`.
- **Architekturprinzip festgehalten:** Nayax sieht NIE den Backstock. `remaining_qty` = Automat + Backstock (Gesamt). NIE auf `current_machine_qty` setzen.
- Issue #87 geschlossen.

#### #93: Echtzeit-remaining_qty — DB-Trigger live (Commit `e6f41d0`)
- **Trigger `trg_deduct_stock_on_machine_sale`** auf `slot_assignments.current_machine_qty`.
- Wenn WF3 (alle 5 Min) Nayax-Daten einspielt und Wert sinkt → FIFO-Abzug von `stock_batches.remaining_qty`.
- Wenn Wert steigt (Nachfüllung Backstock→Automat) → kein Abzug (Gesamtmenge bleibt gleich ✓).
- Produktwechsel am Slot → WHEN-Guard verhindert falsches Feuern.
- **100 % Nayax-Verkäufe erfasst** (nicht nur die ~30 % WF3-Matches).
- Migration `0003-stock-deduct-trigger.sql`, auf Mini angewendet.
- **Live verifiziert:** Skittles −2 → remaining 5→3 ✓; Red Bull −4 → FIFO batch_28(2→0) + batch_51(15→13) ✓.
- Issue #93 geschlossen.

### OFFEN — brauchen User-Entscheidung / Freigabe

| # | Inhalt | Blockiert durch |
|---|--------|----------------|
| **#91** | prices-Tabelle befüllen (VK-Preise Sheet → PG) | User-Freigabe; prices hat `slot_assignment_id` FK (nicht trivial) |
| **#92** | stock_batches: Schema ✅, WF2-n8n-Update + Backfill | WF2-n8n-Arbeit + Freigabe |
| **#9** | v2-Abschaltung | Strategische Entscheidung |
| homelab #48 | Rückwirkende Umbuchung betroffener Verkäufe | Komplex, braucht User-Input |

**Hinweis #93-Nachfolge:** WF3 Sheet-Write-Nodes können jetzt deaktiviert werden (remaining_qty ist Echtzeit, Google Sheets ist nicht mehr Wahrheitsquelle). Braucht User-Freigabe als separaten Schritt.

### ENV-Zustand Mini (homelab/.env) — relevante Dashboard-Vars
```
DASHBOARD_ADMIN_LOGIN=patrickmatthes2609@gmail.com
DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16
DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1
```

### Deploy-Weg (Referenz)
SSH via `ssh -F ~/.ssh/config miniserver`, dann `wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard"`.
Für Env-Änderungen: `docker compose ... up -d --force-recreate dashboard`.

### DB-Diagnose-Queries
```sql
-- Bestandsdrift: remaining_qty (DB) vs. current_machine_qty (Nayax)
-- remaining_qty = Automat + Backstock; current_machine_qty = nur Automat
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
```

### Lehren
- `url.parse(req.url, true)`: liefert `.query` als Objekt, NICHT `.searchParams`. Immer `parsed.query.KEY`.
- Tailscale Serve (Windows→WSL→Docker): Container sieht `::ffff:172.18.0.1` → TRUSTED_SERVE_IP nötig.
- **Nayax sieht NUR Automateninhalt, NIE Backstock.** `remaining_qty` = Automat+Backstock (Gesamt). NIE auf `current_machine_qty` setzen — das vernichtet Backstock-Information.
- Reconciliation-Falle: `remaining_qty ← current_machine_qty` war falsch (Backstock ignoriert). Richtig: DB-Trigger der bei Nayax-Absenkung FIFO-Abzieht.
- SSH-Quoting auf Mini: Befehle via scp als `.sql`-Datei + `docker exec -i ... psql < /tmp/file.sql` umgehen Shell-Escaping-Hölle.

---
