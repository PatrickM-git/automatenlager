# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-05 — #31 Feature + #78 F1 live; Bestandsdrift-Analyse

Suite **↑** (Tests für #31+#78 hinzugekommen). Alle vorherigen Ergebnisse intakt.

### Heute erledigt

#### #31 Feature: Editierbare Schwellwerte (Pro-Automat, Ladenhüter-Tage)
- **Option A (additive `settings_thresholds`-Relation)** vom User bestätigt und implementiert.
- `dashboard/lib/settings-thresholds.js`: THRESHOLD_DEFS + getThresholds/setThreshold/reset/resetAll (Provenienz: machine > global > DEFAULT_CONFIG).
- DB-Migration `0002-settings-thresholds.sql`: `UNIQUE NULLS NOT DISTINCT` (pg16), auf Mini angewendet.
- API: GET/PUT/DELETE `/api/v2/settings/thresholds[/:key]` (system.verwalten-Guard).
- Frontend: Schwellwert-Karte auf `/einstellungen` (Wert + Provenienz-Badge + Speichern/Reset); `putJson`/`deleteJson` Helpers in `v3.js`.
- `assortment-slots.js` übernimmt globalen Override für `classifyTurnover`.
- 26 Tests (thresholds + einstellungen). Bugfix `d741b41`: `url.parse().query.machineId` statt fälschlich `searchParams.get`.
- **Live verifiziert:** PUT → 45/source=global, DELETE → 30/source=default. Issue #31 geschlossen.

#### #78: F1 scharfschalten (CIDR + Trusted Serve IP)
- Empirisch ermittelt: Tailscale Serve (:8443) erscheint im Container als `::ffff:172.18.0.1` (Docker-Bridge-Gateway).
- `auth.js` → `isTrustedIdentityPath`: neuer Parameter `DASHBOARD_TRUSTED_SERVE_IP` (explizite Gateway-Ausnahme auch wenn IP im CIDR liegt).
- `homelab/.env`: `DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16` + `DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1`.
- 2 neue Unit-Tests (Gateway plain + IPv6-mapped = trusted; interner Peer = guest).
- **Live verifiziert:** `:8443` → role=admin, system.verwalten=true. Kein Lockout. Issue #78 geschlossen.

#### Bestandsdrift-Analyse (#87) — read-only, keine Datenänderung
- Skittles bestätigt: initial_qty(12) − sold(7) = 5 = Nayax(5) = physisch(5). Formel stimmt für Skittles.
- Aber: `sales_transactions` ist für die meisten Produkte **stark unvollständig** (nur 6–30 % der echten Verkäufe erfasst). Calc-Methode (initial − sales_transactions) liefert deshalb zu hohe Werte für fast alle Produkte.
- `current_machine_qty` aus `slot_assignments` (Nayax-Quelle, alle 5 Min aktualisiert) ist die verlässliche Wahrheit.
- `stock_batches.remaining_qty` ist flächendeckend veraltet (wurde nie durch Verkäufe aktualisiert).
- Empfehlung: Reconciliation via `remaining_qty → current_machine_qty` (Nayax als Quelle) — braucht User-Freigabe.

### OFFEN — brauchen User-Entscheidung / Freigabe

| # | Inhalt | Blockiert durch |
|---|--------|----------------|
| **#87** | Bestandsdrift: remaining_qty-Reconciliation via Nayax | User-Freigabe für Datenänderung |
| **#91** | prices-Tabelle befüllen (VK-Preise Sheet → PG) | User-Freigabe; prices hat slot_assignment_id FK (nicht trivial) |
| **#92** | stock_batches purchase_date/machine_id (Schema ✅ bereits vorhanden) | WF2-n8n-Update + Backfill-Freigabe |
| **#93** | WF3 Sheet-Write-Nodes deaktivieren | Abhängig von #87-Lösung |
| **#9** | v2-Abschaltung | Strategische Entscheidung |
| homelab #48 | Rückwirkende Umbuchung betroffener Verkäufe | Komplex, braucht User-Input |

### ENV-Zustand Mini (homelab/.env) — relevante Dashboard-Vars
```
DASHBOARD_ADMIN_LOGIN=patrickmatthes2609@gmail.com
DASHBOARD_INTERNAL_PEER_CIDR=172.18.0.0/16
DASHBOARD_TRUSTED_SERVE_IP=172.18.0.1
```

### Deploy-Weg (Referenz)
SSH → `wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/c/homelab/projekte/automatenlager && git pull --ff-only && docker restart homelab-dashboard"`.
Für Env-Änderungen: Container neu erstellen (nicht nur restart): `docker compose ... up -d --force-recreate dashboard`.
SSH-Quoting: äußere Single-Quotes um den WSL-Befehl, inner Double-Quotes.

### Nützliche Diagnose-Queries
```sql
-- Bestandsdrift-Übersicht (Nayax vs. DB)
SELECT p.name, SUM(sb.initial_qty) AS initial, SUM(sb.remaining_qty) AS db_stock,
  COALESCE(SUM(sa.current_machine_qty),0) AS nayax_qty
FROM automatenlager.stock_batches sb
JOIN automatenlager.products p ON p.product_id=sb.product_id
LEFT JOIN automatenlager.slot_assignments sa ON sa.product_id=sb.product_id AND sa.active=TRUE
WHERE sb.status NOT IN ('ausgesondert','leer','ausgebaut')
GROUP BY p.name ORDER BY p.name;
```

### Lehren
- `url.parse(req.url, true)` (legacy Node.js): liefert `.query` als Objekt, NICHT `.searchParams` (URLSearchParams). Beim Hinzufügen von Query-Parametern immer `parsed.query.KEY` verwenden.
- Tailscale Serve-Pfad (Windows → WSL → Docker): Container sieht `::ffff:172.18.0.1` (Docker-Bridge-Gateway). Das ist in 172.18.0.0/16 enthalten → TRUSTED_SERVE_IP nötig um Lockout zu verhindern.
- `sales_transactions` erfasst nur einen Bruchteil der echten Verkäufe (WF3-Matching-Ausfälle, Datenlücken). Für Bestandsrechnungen immer `current_machine_qty` (Nayax) als Wahrheit verwenden.

---
