# Dashboard v2 Cutover-Runbook

> **⚠️ Historisch — v2-Frontend abgeschaltet (Issue #9, 2026-06-03).**
> v3 ist der produktive Standard. Die Route `/v2` liefert kein eigenes Frontend mehr,
> sondern leitet dauerhaft (302) auf `/v3` um; `v2.html/js/css` wurden entfernt.
> Die gemeinsame Backend-API `/api/v2/…` bleibt unverändert und wird von v3 genutzt.
> Dieses Runbook bleibt als Beleg des damaligen Legacy→v2-Cutovers erhalten.

Dieses Runbook beschreibt den produktiven Cutover vom Legacy-Dashboard auf Dashboard v2.
Legacy bleibt kurzfristig als Fallback erreichbar, bis die Betriebsstabilität bestätigt ist.

---

## Voraussetzungen

Vor dem Cutover müssen folgende Punkte erfüllt sein:

- [ ] `DASHBOARD_V2_PG_URL` ist in der Produktivumgebung gesetzt (PostgreSQL-Verbindung aktiv)
- [ ] Alle 5 v2-Smoke-Tests grün: `node --test tests/dashboard-v2-smoke.test.js`
- [ ] Vollständige Test-Suite grün: `node --test tests/*.test.js`
- [ ] Dashboard läuft auf HP Mini unter Port 8787 (`homelab-dashboard`-Container)
- [ ] Tailscale-Zugriff via `http://hp-mini-server.tail573a13.ts.net:8787` bestätigt
- [ ] Legacy-Dashboard unter `http://<host>:8787/` ist noch erreichbar (Fallback)
- [ ] v2-Dashboard unter `http://<host>:8787/v2` ist erreichbar und zeigt Live-Daten

---

## Cutover-Schritte

### Schritt 1 – v2 als primäre URL kommunizieren

Bookmark / gespeicherte Links aktualisieren auf:

```
http://hp-mini-server.tail573a13.ts.net:8787/v2
```

### Schritt 2 – Smoke-Test nach Cutover

```bash
# Auf dem HP Mini (via SSH):
ssh miniserver "powershell -Command 'wsl -d Ubuntu-24.04 bash -c \"cd /mnt/c/homelab/projekte/automatenlager/dashboard && node --test tests/dashboard-v2-smoke.test.js\"'"
```

Erwartetes Ergebnis: 5/5 Tests grün.

### Schritt 3 – Validierung der Business-Daten

Prüfe für den aktuellen Monat:

| Metrik | Legacy (`/api/guv`) | v2 (`/api/v2/economics`) | Abweichung |
|--------|---------------------|--------------------------|------------|
| Umsatz netto | — | — | ≤ 0,01 EUR |
| Deckungsbeitrag | — | — | ≤ 0,01 EUR |
| offene Warnungen | — | — | identisch |

Abweichungen → sofort dokumentieren und Issue anlegen.

### Schritt 4 – Legacy-Link in v2 bestätigen

`/v2` zeigt oben links „Legacy-Dashboard" → Link führt zu `/` (Legacy bleibt erreichbar).

---

## Rollback

Falls v2 unbrauchbar ist:

1. Nutzer zurück auf Legacy-URL weiterleiten: `http://hp-mini-server.tail573a13.ts.net:8787/`
2. Legacy-Code läuft weiterhin auf demselben Container — kein Neustart nötig
3. Fehlerhafte v2-Komponente in GitHub-Issue dokumentieren

Legacy-Code liegt in `dashboard/server.js` (Route `/`) und `dashboard/public/index.html`.
Ein Rollback der v2-Route erfordert keinen Container-Neustart.

---

## Legacy-Fallback

Legacy ist dauerhaft unter `http://<host>:8787/` erreichbar, solange der `homelab-dashboard`-Container läuft.
v2 liegt unter `/v2` — beide Routen werden vom selben Node.js-Prozess bedient.

Zeitplan: Legacy wird frühestens nach **14 Tagen** stabilen v2-Betriebs entfernt
(analog zum 14-Tage-Kriterium für WF-Val, Abschluss: 2026-06-08 oder später).

---

## Bekannte Abweichungen Legacy ↔ v2

| Bereich | Legacy | v2 | Status |
|---------|--------|----|--------|
| GuV-Daten | Google Sheets (live) | PostgreSQL (`guv_daily`) | ✅ Werte abgeglichen (Mai 207,80 EUR) |
| Produkt-Filter | Keine Filterung | Maschinenfilter, Sortierung | ✅ erweiterter Funktionsumfang |
| Workflow-Status | n8n-API live | `warnings`-Tabelle (5-min-Cache) | ✅ akzeptiert, dokumentiert |
| MHD/Bestand | Aus Google Sheets | PostgreSQL (`slot_assignments`) | ✅ Seed-Daten geladen |
