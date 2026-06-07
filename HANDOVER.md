# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Nachtrag (2026-06-07, später) — PG-Backup auf externe Platte D: eingerichtet

Tägliches `pg_dump`-Backup der Prod-DB (`homelab`/`automatenlager`) auf die externe
Platte **D:** des Mini (Sheets ist seit SQL-Cutover kein Backup mehr). Skript
`C:\homelab\scripts\pg-backup-automatenlager.ps1` (pg_dump -Fc → docker cp → C: →
Move D:\backups\automatenlager + Aufbewahrung 30 Tage + Log). Windows-Aufgabe
**`PG-Backup-Automatenlager`** täglich 03:00 (Benutzer patri/console-Sitzung; läuft
verifiziert, Result 0). Restore-Befehle + Details: Memory `pg-backup-mechanismus`.
**Offen/optional:** Backup-Skript ins Repo/Homelab-Docs versionieren; Restore-Probe.

## Nachtrag (2026-06-07, später) — Feature „Inline-Inventur" (#152) LIVE

`/lager`: **Chargenrest pro Charge inline editierbar** (gezählter Lager-Ist; Klick auf
den Wert → Dialog → speichern). Ändert **nur `remaining_qty`**, NIE `machine_qty`
(„Im Automaten" = Nayax). Das **Drift-⚠** (Chargenrest-vs-Nayax) ist entfernt (verglich
Lager gegen Maschine). `lib/inventory-count.js` (`setBatchCountPg` via `db.tx`,
0..initial_qty, optimistic lock) + `POST /api/v2/inventory/set-count` (`bestand.schreiben`,
durch die Tür/RLS, JSONL-Audit) + `public/v3.js`. Migration **0016** auf
`DROP MATERIALIZED VIEW … CASCADE` (Security-View hängt seit Stufe 5 dran). PR #153
gemergt, Mini `324b08f`, Suite **1089/1089**, Endpoint live (403-Gate verifiziert).
**Hinweis:** Lokale Preview konnte die daten-gegatete UI nicht zeigen (Dev-Admin ist
mandantenlos → leer); auf dem Mini (echter Mandant + Admin) rendert sie real.

## Stand: 2026-06-07 — Mandantenfähigkeit STUFE 5 „RLS-Backstop" — KOMPLETT, LIVE & VERIFIZIERT

Row-Level-Security als unumgehbarer Backstop für **Lesen UND Schreiben** ist umgesetzt,
auf den Mini deployt und scharf geschaltet. Issues **#144–#150 geschlossen** (PR
[#151](https://github.com/PatrickM-git/automatenlager/pull/151) gemergt, Mini auf
`145ee7b`). Vorbedingungen: Stufe 4 deployt + #132–#139 geschlossen; Pre-Flight #143
geschlossen. SPEC: `docs/specs/multi-tenant-rls-stufe-5-v1.md`. Suite **1081/1081 grün**.

### Pre-Flight-Befund (#143) — wichtig
Die Mini-DB hat eine **out-of-band** Rollen-Hierarchie (NICHT im Repo): `homelab`
(Owner, super+BYPASSRLS), `app_reader`/`app_writer` (Funktions-Rollen), **`n8n_app`**
(n8ns Login-Rolle, Mitglied von `app_writer`), `validator`, `migrator`. Die SPEC nahm
„keine Rollen vorhanden" an — angepasst. tenant_id-Indizes auf allen 5 heißen Tabellen
vorhanden (kein neuer Index nötig). Siehe Memory `db-rollen-landschaft`.

### Was umgesetzt wurde (Code, 5 Commits)
- **Slice 1 (#144):** `lib/tenant-db.js` `read()`/`write()` transaktional (read: `BEGIN
  READ ONLY`) + GUC via `set_config('automatenlager.current_tenant',$1,true)` (kein
  String-`SET`); `tx()`-Haken gezündet; AMBIENT-Modus für `asDoor(client)`/Sandbox;
  Pool-Pflicht (sonst wirft). `server.js`: Infra-Pool (homelab) für Registry/Bootstrap
  + App-Pool (`DASHBOARD_V2_APP_PG_URL`, Fallback Infra) für die Tür.
- **Slice 2 (#145, Migration 0022):** Rolle `automatenlager_app` (LOGIN, **kein**
  BYPASSRLS, kein Eigentum), Mitglied von `app_writer` + DELETE auf
  locations/settings_thresholds; Registry per REVOKE gesperrt; `n8n_app` → BYPASSRLS;
  search_path-Härtung. (Mat)View-Sicherung inert in 0022 (vor Code-Deploy nötig).
- **Slices 3a–3d (#146–#149, Migrationen 0023–0026):** `ENABLE`+`FORCE`+`tenant_isolation`
  (USING+WITH CHECK, einarmiges `current_setting` ⇒ fail-closed; `text=text`) auf 20
  operativen Tabellen in 4 Gruppen; **Vereinigungs-Policy** `classification_settings`
  (Spalte `mandant_id`: eigener Mandant ODER `__default__`; Schreiben strikt eigener);
  `security_invoker` auf `v_warnings_open`/`v_slot_turnover`; **security_barrier-View**
  `v_inventory_value_daily` statt roher MatView (economics.js/assortment-slots.js
  umgestellt); rohe MatViews für App-Tier entzogen.
- **Abschluss (#150):** Break-Glass read-only an der Tür (`forViewer` + supportSession);
  Rollback-Runbook `docs/security/rls-stufe-5-rollback.md`; Negativ-Matrix-Test
  `dashboard/tests/dashboard-mt-rls-isolation.test.js` (real als `automatenlager_app`).

### Live-Rollout (gestaffelt, verifiziert)
1. Migration **0022** angewendet (Rolle+View+Infra, inert). 2. **Code-Deploy** (Mini
`git reset --hard origin/main` + restart; App noch homelab). 3. **Rollenwechsel:**
Passwort für `automatenlager_app` gesetzt + `DASHBOARD_V2_APP_PG_URL` in
`dashboard/.env.local` (Passwort generiert/verwendet **auf dem Mini**, verließ ihn nie)
+ restart. Verifiziert: Container `current_user=automatenlager_app superuser=off`.
4. **0023→0024→0025→0026** gestaffelt angewendet, Gruppen-Smoke je Gruppe (als
`automatenlager_app`, GUC=t_faltrix, transaktional) = **exakt** Faltrix' Zeilen.
5. Final: `/health` ok, Logs fehlerfrei, **n8n_app=BYPASSRLS** (WF3/WF7 ungebrochen),
**fail-closed** (fehlender GUC ⇒ Fehler 42704, kein Leck).

### Betrieb / Wissen für die nächste Session
- Dashboard verbindet jetzt als **`automatenlager_app`** (App-URL in der Mini-
  `dashboard/.env.local`, Schlüssel `DASHBOARD_V2_APP_PG_URL`). Die Test-Suite/Dev
  nutzt weiter `DASHBOARD_V2_PG_URL` (homelab, BYPASSRLS) über den Tunnel.
- **Lockout-Recovery:** `DASHBOARD_V2_APP_PG_URL` in der Mini-`.env.local` leeren ⇒
  Fallback auf die Infra-URL (homelab, BYPASSRLS) + restart. Siehe Rollback-Runbook.
- Neue Migrationen **0022–0026** sind auf der Live-DB angewendet (idempotent).

### Restrisiko / Grenzen (unverändert SPEC)
- n8n schreibt bewusst über die **BYPASS**-Rolle (außerhalb des Backstops bis Stufe 6);
  MatView-`REFRESH` mandantenübergreifend (Infra). Mit **einem** Mandanten (Faltrix)
  akzeptiert. **Kein zweiter echter Kunde vor Stufe 6.**
- WF3/WF7 wurden NICHT real getriggert (keine Prod-Mutation); n8n auf Rollenebene
  verifiziert (BYPASSRLS) — der nächste reguläre WF-Lauf bestätigt End-to-End.

### Offene Issues (bewusst NICHT in diesem Loop)
- **#108** Übergangs-Cleanup (tenantColumn-Brücke + `__default__`-Abbau) → **Stufe 6**.
- **#109** IR-Runbook → **separat**, braucht org-spezifischen Input (Kontakte/Eskalation).
- **#111** globale (key)-Uniques droppen + `ON CONFLICT (tenant_id,key)` → **Stufe 6**.

### Nächste Schritte
1. **Stufe 6 planen** (`grill-me`): n8n-Eigenabsicherung/-Ablösung (raus aus dem
   BYPASS), per-Mandant-Config, #108 + #111 — erst danach 2. realer Kunde möglich.
2. **#109 IR-Runbook** mit dem Betreiber gemeinsam erstellen.
3. Beim nächsten WF3/WF7-Lauf das n8n-Run-Log auf DB-Fehler prüfen (End-to-End-Bestätigung).
