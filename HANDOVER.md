# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-11_n8n-abloesung-komplett.md`.

## Session 2026-06-11 (Planung) — NÄCHSTE PHASE GEPLANT: Cloud-Migration (Phase B) + Betriebsreife (A3)

> Reine **Planungssession** (kein Code). Auslöser: A2/Stufe 6 (n8n-Ablösung) ist abgeschlossen
> (Commit `2ff12e9`) → die Voraussetzung für die Cloud-Migration ist erfüllt. Ablauf:
> `grill-me` → `write-a-stack` → `ubiquitous-language`. **Umsetzung übernimmt das Model Fable**
> (bewusst gröber/slice-orientiert geplant).

### Ergebnis
- **Neue SPEC:** `docs/specs/cloud-migration-3-schichten-phase-b-v1.md` — inkrementeller Umzug
  Heim-Mini → **Supabase** (DB+RLS+**Auth**) · **Render** (Backend+Jobs) · **Cloudflare** (Frontend+Domain)
  in **6 Slices** (Fundament/Domain → DB → Auth-Naht → Backend → Frontend → Betriebsreife/Cutover).
  Betriebsreife (A3: Sentry, Off-Site-Backup+Alarm, Statusseite) cloud-nativ inklusive. Gegen den
  **echten Code** verifiziert (Explore-Pass), nicht gegen Doku-Annahmen.
- **CLAUDE.md:** Abschnitt „Current Next Step" aktualisiert — A2/Stufe 6 als ✅ erledigt vermerkt
  (alle 18 n8n-WF deaktiviert, Migration 0033, RLS systemweit), Cloud-Phase als nächster Schritt.
- **UBIQUITOUS_LANGUAGE.md:** neuer Cluster „Cloud-Migration (3-Schichten) & Betriebsreife" (10 Begriffe:
  3-Schichten-Cloud, Auth-Naht, Identitäts-Eingang, Rollen-Abbildung, GUC-Vorregistrierung, Gratis-Stufen-Cron,
  Flüchtiges Dateisystem, Off-Site-Backup, Migrations-Slice, Rückfall-Option) + Beispiel-Dialog + 6 Unklarheiten.

### Kernentscheidungen (aus dem grill-me-Interview)
1. **Cloud so schnell wie möglich** → Betriebsreife (A3) nicht mehr auf dem Mini bauen, sondern
   **cloud-nativ** in Phase B (Supabase-Backups/Render-Monitoring/Sentry statt Mini-Wegwerf-Arbeit).
2. **Login = Supabase Auth** (E-Mail/Passwort + Reset + 2FA mitgeliefert). Zentrale Aufgabe = **Auth-Naht**:
   verifiziertes Supabase-JWT ersetzt den `Tailscale-User-Login`-Header; **Mandanten-Tür + RLS bleiben unverändert**.
3. **Start komplett auf Gratis-Stufen** (eigener Testkunde Faltrix), Hochstufen erst zum Marktstart.
   Folge: kein Render-Cron → **pg_cron/Cloudflare Cron**; kein Supabase-Auto-Backup → eigener **pg_dump + Alarm**.
4. **Neue Domain** via Cloudflare Registrar (eigener Schritt). **Kurzes Wartungsfenster** ok → keine Zero-Downtime-Technik.
   **Inkrementell** (DB→Backend→Frontend), **Mini bleibt als Rückfall-Option** bis Cloud verifiziert.
5. **Login-Design bewusst minimal** — ordentliches Design = **technische Schuld für Phase C** (Marketing), in SPEC vermerkt.

### Verifizierte Supabase-Fallstricke (in der SPEC adressiert)
- Custom-GUC `automatenlager.current_tenant` **vorregistrieren** (`ALTER DATABASE … SET`), sonst RLS-Fehler 42704.
- **Kein Custom-BYPASSRLS** auf Supabase → Infra-Pool = `service_role`-Äquiv., App-Pool = `automatenlager_app`-Äquiv.
- Migration **0033 bedingt** machen (`n8n_app` existiert auf Supabase nicht).
- **Flüchtiges Render-Dateisystem** → Audit-/Guest-Access-Log + `.dashboard-config.json` in die DB/Env.

### Issues geschnitten (`spec-to-issue`, diese Session) — #212–#219
- **#212** Slice 0 — Cloud-Fundament & Domain (blocked by: —)
- **#213** Flüchtiges-FS-Fix: Audit-/Guest-Access-Log + Config → DB (blocked by: —, parallel früh)
- **#214** Slice 1 — DB → Supabase (Schema/RLS/Rollen/GUC/Daten) (blocked by #212)
- **#215** Slice 2 — Auth-Naht: Supabase Auth → Mandanten-Tür + minimaler Login (blocked by #214)
- **#216** Off-Site-Backup: pg_dump + Alarm (blocked by #214)
- **#217** Slice 3 — Backend + Jobs → Render (+ Sentry + Gratis-Cron) (blocked by #214, #213, #215)
- **#218** Slice 4 — Frontend → Cloudflare (blocked by #217)
- **#219** Slice 5 — Cutover-Abschluss: Statusseite + DNS-Cutover + Rollback-Runbooks (blocked by #216, #217, #218)
- Label-Gruppe `cloud-migration` angelegt.

### Nächste Schritte
1. **Neuer Chat → `start-issue` → `tdd`** (Umsetzung durch Fable). Startbar ohne Blocker: **#212** (Slice 0) und **#213** (FS-Fix).
2. Unabhängig laufende Daten-Bugs **#210/#211** (EK/MwSt im GuV-Wareneinsatz) **nicht** in die Migration mitziehen.
3. Aufräum-Backlog aus der n8n-Ablösung (n8n-Container stilllegen, Webhook-Fallbacks, cutover-monitor) bleibt offen.

## Session 2026-06-11 (Fortsetzung) — n8n-ABLÖSUNG KOMPLETT (Stufe 6 abgeschlossen)

**Alle 18 n8n-Workflows deaktiviert, Migration 0033 (BYPASSRLS-Entzug) angewendet ⇒ RLS systemweit ohne Ausnahme.** Vollständiges Abschlussprotokoll inkl. Ersatz-Tabelle, Validierung, Rückweg und Folgearbeiten: **`docs/audit/n8n-abloesung-abschluss-2026-06-11.md`** (der maßgebliche Ort).

### Die drei Code-Ports dieser Session
1. **WF1-Upload:** `google-drive-client.js` kann jetzt `upload()` (multipart files.create); neuer Builder `buildInvoiceDriveFromEnv` (EIGENES Ordnerpaar `GOOGLE_DRIVE_INVOICE_*` — vorher pollte der Intake-Job fälschlich den Picklisten-Ordner!); Upload-Endpunkt legt Rechnungs-PDFs direkt im Drive-Rechnungseingang ab (Webhook nur noch Fallback). Mini-Env: Invoice-Ordner-IDs (aus dem WF1-Export: `15_5fY…`/`1pzIB…`) + `WF1_TENANT_ID=t_faltrix` (**fehlte — der WF1-Schatten lief deshalb immer „skipped"**) + `WF1_CUTOVER=1`.
2. **WF4-Produktwechsel:** `applySlotChange()` in `wf4-slot-write.js` (close+open atomar via db.tx, LIVE-getestet inkl. Isolation); `slot-change/confirm` bucht direkt durch die Tür — `SLOT_CHANGE_WEBHOOK_URL` obsolet.
3. **Nayax-Abgleich:** `fetchNayaxMachineProducts()` (direkt Nayax-API, Namens-Anreicherung per product-detail mit Cache + Fehlertoleranz — faithful zur n8n-Map-Node); Apply wendet die pgw-fertigen Events via `applySlotAssignmentEvents()` durch die Tür an — `NAYAX_ABGLEICH_WEBHOOK_URL` obsolet. WF2 war bereits in-process (`invoice-proposal/approve`) — n8n-Form nur noch Alt-Eingang, deaktiviert.

### Deaktivierte n8n-Workflows (IDs für den Rückweg)
WF1 `wnGAwHhgfXq2ATM8` · WF2 `X2RU2cHm78rkIWMf` · WF3 `wbOhFKXQqBpJWB1w` · WF4 `6tOZnWsxBNzHaVqA` · WF-PGW `Sajezv8tJll0CLIv` · WF-Nayax-Abgleich `JiBefpG7ufgqPSKF` · WF-Monitor `EdgUfv1lMcE25Z3K` · WF-Drift-Check `0jSwjm74Bna7FSqr` · WF-Migrate `rjR0orV1gcPF342O` (Rest war schon inaktiv).

### Nächste Schritte
1. Erste echte Rechnung über den neuen Upload schicken und Verarbeitung beobachten (`wf1-invoice-intake` in audit.workflow_runs).
2. ROADMAP: A2 ✅ → als Nächstes **A3 Betriebsreife** (Off-Site-Backup, Monitoring), dann A4 Self-Service.
3. Aufräum-Backlog (siehe Abschlussprotokoll §Folgearbeiten): n8n-Container stilllegen, cutover-monitor aus dem Schedule, Webhook-Fallbacks entfernen.
4. Ops: `DASHBOARD_INTERNAL_PEER_CIDR` (#78) vor zweitem Kunden.

## Session 2026-06-11 — WF3-CUTOVER VOLLZOGEN + Marketing/Pricing-Konzept

### Diagnose (Auslöser: „WF5 läuft seit 46h nicht" + keine Cutover-Mail)
- **WF5-Warnung war Fehlalarm des n8n-WF-Monitors:** Der (jetzt deaktivierte) n8n-WF-Monitor überwachte die **absichtlich deaktivierten n8n-WF5/WF8** — wachsende SCHEDULE_GAP-Warnungen (26h→42h→46h) waren Migrations-Rauschen. Der **Worker-WF5 lief normal** (täglich 07:00, audit.workflow_runs success).
- **Cutover-Diff war Vergleichs-Artefakt, keine Datenabweichung:** streak=0 wegen (a) bereits verarbeiteter Verkäufe im Fenster (intended überspringt sie korrekt → erscheinen als onlyActual) und (b) `movementBaseKey`-Datums-Normalisierung, die legitime Ein-Zeile-pro-Tag-Movements über Tage hinweg kollidieren lässt (5× quantity-mismatch). **Geprüft: keine Duplikate (sales/movements), keine negativen Bestände.**
- **n8n-WF3 war der eigentlich Kranke:** Auth-Fehler bei manuellen Läufen (06-10 15:45), dabei Watermark `WF3_NAYAX_FIFO` auf `null` zerstört; WF-PGW-Fehlerhistorie (926 kumuliert, Sturm 06-02–06-05).

### Cutover ausgeführt (alles verifiziert)
1. **n8n WF3 deaktiviert** (`wbOhFKXQqBpJWB1w`) + **n8n WF-Monitor deaktiviert** (`EdgUfv1lMcE25Z3K`, Rauschquelle; Rest-Monitoring: worker `wf-worker-monitor` + `anomaly-monitor` via audit.workflow_runs).
2. **`WF3_CUTOVER=1`** in Mini `dashboard/.env.local` (Zeile 22) + `docker restart homelab-worker` (worker.js liest .env.local selbst → restart genügt).
3. **Live-Validierung** per `docker exec … node worker.js --run wf3-nayax-fifo`: `mode:cutover`, 200 Sales gefetcht, **salesWritten 0 / movementsWritten 0** (Dedup über processedTxIds griff perfekt — kein Doppelbuchen trotz zerstörter n8n-Watermark), Watermark wieder konsistent (`2026-06-10T13:10:47Z`).
4. **9 Stale-Warnungen resolved** (`resolved_by='cutover-2026-06-11'`): SCHEDULE_GAP wf5/wf8 + WF3-WORKFLOW_ERROR/AUTH_ERROR/DAILY_FAIL.

### n8n-Restbestand (Plan zur vollständigen Ablösung)
| Noch auf n8n | Warum noch | Ablöseweg |
|---|---|---|
| **WF1** (aktiv) | Upload-Webhook `wf1-rechnung-upload` legt PDF in Drive ab — Dashboard-Upload hängt daran; Backend-`invoice-intake` pollt Drive nur | Drive-**Upload** in `google-drive-client.js` ergänzen (files.create multipart), Upload-Endpunkt in server.js umhängen → dann n8n WF1 deaktivieren + `WF1_CUTOVER=1` |
| **WF2 + WF4** (aktiv, Forms) | Nutzer-getriggerte n8n-Forms | UI-Ersatz im Dashboard (WF4-Schreibport `wf4-slot-write.js` existiert; WF2-Freigabe-UI = claude-proposals/approve-Endpunkt ausbauen) |
| **WF-PGW** (aktiv) | Schreib-Durchreicher für WF2/WF4 | fällt mit WF2/WF4 |
| **WF-Nayax-Abgleich** (aktiv) | `/slots`-Knopf nutzt `NAYAX_ABGLEICH_WEBHOOK_URL` | als Job/Endpunkt portieren |
| **WF-Drift-Check, WF-Migrate** (aktiv) | Infra-Helfer | obsolet machen/portieren |
| Danach | — | **Migration 0033** (n8n_app BYPASSRLS-Entzug) + n8n-Container stilllegen |
- `cutover-readiness-monitor` ist für WF3 jetzt gegenstandslos (kein Schatten mehr) — beim WF1-Cutover wiederverwenden oder stilllegen.

### Marketing/Vertrieb/Pricing (neuer Auftrag)
- **Neues Doc `docs/business/marketing-vertrieb-pricing-v1.md`** (2 Web-Recherchen mit Quellen): Wettbewerbs-Pricing (VendSoft $19–199-Staffeln; Nayax ~14 €/Gerät DE; Televend 12 €/Automat; 4Vending 8.900 € on-prem), Marktlücke „deutscher 1–50-Automaten-Betreiber: Cloud+Compliance+fairer Preis", Preismodell-Vorschlag (Start 0 € / Betreiber 39 €/Mt / Flotte 129 €/Mt + Automaten-Staffel), Feature-Gating-Entscheidung (**jetzt nur `tenants.plan`-Anker, Durchsetzung erst mit C1/Stripe**), 7 USP-Features (GoBD-Leerungsprotokoll, Schwund-Radar, MHD-Geld-Ampel, Kleinunternehmer-Grenzwächter, Provisionsabrechnung, Standort-P&L, Prekitting), 5 Funnels, Kaltakquise-Playbook („Automaten-Finanz-Check" als Hook).
- **ROADMAP.md:** Stand aktualisiert (WF3 über den Cutover), neue Punkte **C5 Marketing & Vertrieb** + **C6 USP-Features**, Backlog ergänzt.

### Nächste Schritte
1. **WF1-Cutover vorbereiten:** Drive-Upload portieren (siehe Tabelle) — danach ist der Rechnungs-Pfad n8n-frei.
2. WF2/WF4-Form-Ersatz als eigene SPEC (`grill-me` → `spec-to-issue`).
3. Morgen prüfen: nächtlicher WF3-Lauf (01:00) in audit.workflow_runs (`mode:cutover`, plausible Zahlen).
4. Ops: `DASHBOARD_INTERNAL_PEER_CIDR` setzen (#78) vor zweitem Kunden.

## Session 2026-06-10 (Abend) — Projekt-Vollaudit + Sofortfixes

**Vollaudit über 5 parallele Prüfungen** (Workflows WF0–WF9 + WF-*, Dashboard-Backend, Migrationen 0001–0033, Doku-Konsistenz, Security). Gesamtbild: Kern solide — kein U+FFFD, keine Secrets, keine Tür-Umgehungen, alle Migrationen idempotent, RLS vollständig. Drei echte Befunde, alle in dieser Session gefixt:

### Fixes
1. **Suite war rot auf main:** `dashboard-v3-write-off.test.js` AC-WO1 prüfte das alte `/lager`-Gating (`viewer.canTriggerActions` via `/api/dashboard`); Code nutzt seit `5e11545`/`b8437ce` bewusst `batchEk.canTriggerActions` aus `/api/v2/batches`. Test an die gewollte Realität angepasst (Code unverändert).
2. **RLS-fail-closed-Regression (Migration 0034 NEU):** 0032 hatte die `classification_settings`-Policies versehentlich mit `current_setting(..., true)` (missing_ok) neu angelegt — fehlender GUC lieferte still `__default__`-Zeilen statt Fehler 42704. **Entscheidung (gegen Code/Historie verifiziert):** kein Anwendungsfall — alle Leser gehen durch die Tür (GUC immer gesetzt), Migrationen/Refresh laufen über die Infra-Rolle; im selben Commit blieb 0026 einarmig ⇒ Versehen, keine Designentscheidung. `0034-classification-settings-fail-closed.sql` stellt die 0026-Form wieder her; Test `dashboard-mt-0034-classification-fail-closed.test.js` beweist LIVE (Sandbox): ohne GUC ⇒ 42704, mit GUC ⇒ nur eigener Mandant + `__default__`. **✅ DEPLOYT:** 0034 auf der Mini-DB angewendet (pg_policies verifiziert einarmig).
3. **Fetch-Timeouts (NEU `lib/fetch-timeout.js`):** alle 6 externen HTTP-Call-Sites (anthropic-client 120 s, google-drive-client, mailer/Resend, github-issues, nayax-devices-sync, nayax-sales je 30 s; Override `EXTERNAL_FETCH_TIMEOUT_MS`) bekommen `AbortSignal.timeout` — vorher konnte ein hängender Dienst einen Worker-Job bis zu den undici-Defaults (~300 s) blockieren. Aufrufer-Signal hat Vorrang; Timeout landet als normaler Job-Fehler in der Telemetrie.

### Doku-Sync (war ~8 Wochen hinter dem Code)
- **README.md + ARCHITECTURE.md neu geschrieben:** SQL-only, Mandanten-Stufen 2–5 live, Stufe-6-Schattenbetrieb, Worker, Schichten-Tabelle, WF-Status-Tabelle. Fachliche Invarianten (WF2/WF4-Eigentümerschaft, `active`-Semantik, `product_slot_id`) unverändert übernommen.
- **CLAUDE.md:** Repository-Structure-Block auf Ist-Stand (17 WF-JSONs, worker.js, db-migrations 0001–0034, lib/, docs/, infra/), neue Sektion „Worker (Stufe 6)", Env-Verweis auf `.env.example`, WF7-Abschnitt klargestellt (Dashboard-Endpunkt, n8n-Webhook historisch), Sheets-Regel in Core Domain Rules korrigiert.
- **`guv_check_tmp/` aus dem Git-Index entfernt** (stand in `.gitignore`, 8 Dateien waren aber noch getrackt; bleiben lokal liegen).

### Audit-Befunde OHNE Code-Änderung (bewusst)
- **#78 / `DASHBOARD_INTERNAL_PEER_CIDR`:** weiterhin nicht enforced — Tailnet-Peer könnte Identity-Header spoofen. Empfehlung: vor zweitem Kunden auf dem Mini setzen (Ops-Task, kein Code).
- **Fehlalarme geprüft und verworfen:** worker.js `runOnStart` (tick fängt intern), „disabled Sheets-Nodes" (= dokumentierter Sollzustand Stufe 6), `workflow-actions-view.js` (existiert), 0029-Kommentar (Kopfblock ist präzise).
- 0031-PK-Vergleich via `string_agg` funktional korrekt, nur kosmetisch fragil — nicht angefasst (deployte Migration).

### Mini-Deploy ✅ (gleiche Session)
`git pull --ff-only` auf `a0afa91` (Repo-Pfad Mini: `C:\homelab\projekte\automatenlager`, via WSL-git) + Migration 0034 über den Tunnel angewendet (Policies verifiziert) + `docker restart homelab-dashboard homelab-worker`. Verifiziert: `/health` = ok/tenantDirectoryReady/tenantDbReady/pgConfigured, Schema-Contract 146 Spalten-Refs/25 Relationen grün, Worker hat alle 9 Jobs geplant und läuft.

### Nächste Schritte
1. WF3-Constraint-Fix aus der Vorsession weiterhin offen — siehe unten (n8n-seitig, unabhängig vom Dashboard-Deploy).
2. Cutover #198 beobachten (`cutover-monitor`), danach n8n WF3/WF1 deaktivieren → WF2/WF4 → Migration 0033.
3. Ops-Empfehlung aus dem Audit: `DASHBOARD_INTERNAL_PEER_CIDR` auf dem Mini setzen (#78), spätestens vor dem zweiten Kunden.

## Session 2026-06-10 (Nachmittag) — Cutover-Guard-Fix + EK/Pfand-Kostenbasis-Reconciliation

### Cutover-Guard (n8n-Ablösung)
- **Threshold 7 → 1 Tag** (`cutover-monitor.js` `DEFAULT_THRESHOLD`), per `CUTOVER_STREAK_THRESHOLD` überschreibbar.
- **Shadow-Window-Bug behoben** (`nayax-sales.js` `runNayaxSalesShadow`): Vergleichsfenster startete bei `Watermark−2d` → alte n8n-Movements polluteten `onlyActual` → `equal=false` (Streak blieb 0). Jetzt: Fenster ab frühester Transaktion der aktuellen Sales-Charge. Befund kam aus Issue [#206](https://github.com/PatrickM-git/automatenlager/issues/206) (Guard hatte ihn **automatisch** eröffnet — funktionierte, war nur im Dashboard unsichtbar).
- Commit `437d171`, deployt, Suite grün (16/16 nayax-sales, 9/9 cutover).
- **Status n8n-Ablösung:** Fundament + nicht-kritische Jobs LIVE. WF3/WF1 = Schatten. Nach 1 deckungsgleicher Nacht → Cutover-Mail → n8n WF3/WF1 deaktivieren, dann WF2/WF4 + Migration 0033 (BYPASSRLS-Entzug).

### EK/Pfand-Kostenbasis — Reconciliation gegen Metro-Rechnungen (Steuerberater-Bericht)
**Entscheidung des Nutzers:** Nur **Flaschen-/Dosenpfand 0,25 €/Stück** gehört in die Warenkosten (Kunde nimmt Flasche → verloren); **Kistenpfand NICHT** (leere Kiste wird abgegeben → rückholbar). Kanonisch: `unit_cost_net` = **Netto + 0,25 Pfand**; GuV = `× MwSt` = brutto. Memory `ek-pfand-kostenbasis`.
- **Aktive Lichtenauer-Chargen korrigiert:** still → **0,600** (0,350+0,25), medium → **0,761** (0,511+0,25). (Zwischenschritt 0,7364 mit Kistenpfand 0,386 war falsch — 4,25 €/Kiste = 11×0,25 + 1,50 Kistenpfand.)
- **Sheet-Befund:** Spalte `unit_cost` mischt Basen — Rechnungs-Import-Zeilen = netto+Pfand (OHNE MwSt), 02.05-Bestandsaufnahme-Zeilen = brutto (MIT MwSt, ×1,19). Daher GuV teils Doppel-MwSt (z.B. Red Bull Spring 2,09 = 1,7612×1,19).
- **guv_daily restated** (reversibel, Backup `automatenlager.guv_daily_bak_20260610`), je Produkt EINHEITLICH netto+Pfand × MwSt:
  - Lichtenauer still → **0,71** (war wild: 1,05/0,85/0,42), medium → **0,91** (zwei 0,00-Bug-Zeilen gefixt) — = Sheet-Spalte G
  - Red Bull → **1,29** (netto 0,83+0,25 DPG), Red Bull Spring → **1,76** (netto 1,23+0,25; KEIN Verlust mehr, VK 2,00 > 1,76)
  - Coca Cola Zero → **0,99** (netto 0,58 + 0,25 DPG)
- **Gesamt-Audit:** Rest aller Produkte im Rundungsbereich (≤0,03) korrekt.

### Alle 8 Rechnungen abgeglichen (Proton Drive `…/03 Füllmaterial/02 Rechnungen`)
Lücken gefüllt aus echten Metro-Rechnungen (Batches + guv_daily, Backup `guv_daily_bak_20260610`):
- **Coca Cola** → 0,99 (24.01.2026: net 0,580+0,25), **Sprite/Fanta Exotic** → 0,92 (24.09.2025: net 0,520+0,25). Platzhalter 1,2852 weg.
- **Red Bull Spring** bestätigt 1,76 (28.02.2026: net 1,230+0,25 = exakt Sheet-Spalte G).
- **Hochwald Eiskaffee** Historie auf **7%** restated (04.06.-Rechnung Klasse B=7%, Milchgetränk): 0,94×1,07=1,01 (war 1,12 @19%).
- Gesamt-Audit: ALLE Produkte jetzt ≤0,03 Rundung. Sauber für den Steuerberater-Bericht.

### NOCH OFFEN (EK) — nur noch architektonisch/minor
1. **Hochwald go-forward**: guv-aggregate nutzt Kategorie-MwSt (getraenk=19%) → neue Hochwald-Zeilen wieder 19%. Echte Lösung = **Per-Produkt-MwSt (Stufe 6)**. Historie ist korrekt (7%).
2. **Lichtenauer DPG↔MW**: aktive 29.05-Charge ist MW (Pur net 0,350 / medium 0,511 → 0,71/0,91). 2025/früh-2026 war DPG (net 0,488+0,25 = 0,738 → ~0,88). Historie steht auf der MW-Standardkost — bei Bedarf periodengenau splitten (kleiner Effekt).
3. **Red Bull go-forward:** FIFO-Front-Charge = 1,48 (→1,76); Historie auf 1,08 (→1,29, lt. Nutzer). Sprung bis 1,48-Charge leer.
4. **Capri Sun** (kein Pfand, 19%): Chargen stehen brutto-in-net (0,4165=0,35×1,19) → ggf. Doppel-MwSt bei Verkäufen prüfen (geringe Stückzahl).

## Session 2026-06-10 (sehr spät) — Alle Seiten hängen + 45 Warnungen + WF3-Constraint

**Branch `main`**, Commits `95001bf`–`c0d65d8`, deployt (außer WF3-Constraint-Fix, Mini offline).

### Root Causes dieser Session

**Alle Seiten hängen auf "wird geladen..."**
Alle 5 Frontend-Routen (`/guv`, `/lager`, `/slots`, `/monitoring`, `/onboarding` + Nav-Init) riefen
`fetchJson('/api/dashboard')` auf — nur für `viewer.canTriggerActions`. `buildDashboard()` macht
`fetchN8nWorkflows()` + `readGoogleSheetsLive()` = **4+ Sekunden**. `Promise.all` wartete auf alle
→ ALLE Seiten hingen.

**Fix (Commit `c0d65d8`):** Alle 5 Vorkommen in `dashboard/public/v3.js` durch
`fetchJson('/api/v2/viewer')` ersetzt. Der neue Endpoint `/api/v2/viewer` (Commit `5e11545`) gibt
nur Viewer-Metadaten zurück, keine n8n/Sheets-Calls. Seiten laden jetzt in <500ms.

**45 Warnungen im Dashboard (Heute-Screen)**
Quelle: `wf-monitor` Job (Worker-Health-Monitor) meldet WF3 n8n (`wbOhFKXQqBpJWB1w`) als
`WORKFLOW_ERROR`. Der echte Fehler aus n8n-Execution 11038 lautet:
```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```
WF3-Knoten „Google Sheets - letzter Verkaufsworkflow aktualisieren" macht:
```sql
INSERT INTO automatenlager.workflow_state (workflow_key, ...)
ON CONFLICT (workflow_key) DO UPDATE ...
```
**Root cause:** Migration 0031 wurde zu früh (vor Cutover #198) auf die Mini-DB angewendet.
Sie änderte den PK von `(workflow_key)` auf `(tenant_id, workflow_key)` — damit gibt es keinen
Unique-Constraint mehr auf `workflow_key` allein, und WF3's `ON CONFLICT (workflow_key)` schlägt
mit 42P10 fehl.

### ⚠ KRITISCHER AUSSTEHENDER FIX (Mini muss online sein)

**Wenn Mini wieder erreichbar:** Kompatibilitäts-Unique für WF3 eintragen:
```sql
ALTER TABLE automatenlager.workflow_state
  ADD CONSTRAINT workflow_state_key_uk UNIQUE (workflow_key);
```
Ausführen via:
```bash
ssh miniserver "docker exec homelab-postgres psql -U postgres -d automatenlager -c \
  \"ALTER TABLE automatenlager.workflow_state ADD CONSTRAINT workflow_state_key_uk UNIQUE (workflow_key);\""
```
Danach die 45 akkumulierten Warnungen löschen:
```sql
DELETE FROM automatenlager.warnings
  WHERE warning_key LIKE '%wf-monitor%' OR source = 'wf-worker-monitor';
-- oder: alle warnings mit type IN ('WORKFLOW_ERROR','AUTH_ERROR') die WF3 betreffen
```
Dieser Fix ist ein **einmaliger Single-Tenant-Compat-Hack** bis Cutover #198 WF3 deaktiviert.
Nach Cutover: Constraint wieder droppen (oder Migration 0031 übernimmt das bereits korrekt).

### B-5 EK-Korrekturen (aus voriger Session, jetzt live)

- **Twix guv_daily 2026-06-04**: `cost_of_goods` 16,50€ → 0,57€ ✓
- **Lichtenauer still batch `B_LICHTENAUER_STILL_20260529_*`**: `unit_cost_net` 0,7140€ → 0,35€ ✓

### Aktueller Zustand

- GuV zeigt live: „Umsatz Jun 26: 127,90 EUR, Marge: 40,4%" ✓
- Lager lädt in <500ms, EK-Preis-Sektion sichtbar, Lichtenauer still 0,35€ ✓
- WF3 schlägt fehl (seit 0031-Premature-Deploy) → 45 Warnungen akkumuliert
- Mini war bei Session-Ende **offline** (Tailscale zeigt „offline, last seen 1m ago")

### Noch ausstehend

1. **⚠ WF3-Constraint-Fix** (s.o., sobald Mini online) — HÖCHSTE PRIORITÄT
2. **45 Warnungen bereinigen** nach Fix
3. **Sprite/Fanta Exotic/Coca-Cola EK** (alle 1,2852€ Platzhalter aus 2026-05-02):
   Echte Rechnungspreise → Dashboard → Lager → EK-Preis pro Charge → ✎ EK.
   Batch-Keys: `B_SPRITE_20260502_1`, `B_FANTA_EXOTIC_20260502_1`, `B_COCA_COLA_20260502_1`
4. **Lichtenauer medium** (0,9057€): prüfen ob korrekt laut Rechnung.
5. **7 Days Croissant Double** (0,5056€): prüfen ob korrekt laut Rechnung.
6. **Red Bull Spring**: EK brutto 2,09€ > VK 2,00€. VK im Automaten auf ≥ 2,20€ anheben.
7. **Cutover #198**: Shadow-Streak noch bei 0. Nach 7 übereinstimmenden Tagen kommt Cutover-Mail.
8. **Nach Cutover**: Migration 0033 (BYPASSRLS-Entzug) deployen, n8n WF3/WF1/WF2/WF4 deaktivieren.
   Migration 0031 ist BEREITS auf der Mini-DB aktiv (wurde zu früh deployed).

## Nächste Schritte

1. **WF3-Constraint-Fix** sofort ausführen (SQL s.o., sobald Mini online) → Warnungen bereinigen.
2. **EK-Korrekturen**: Sprite/Fanta/Cola + Lichtenauer medium + 7 Days Double nach Rechnungsprüfung.
3. **Cutover abwarten**: Täglich 01:00 Uhr Check; nach 7 Tagen Streak → Cutover-Mail.
4. **A3**: Monitoring/Alerting + Off-Site-Backup (nächste größere Aufgabe nach Cutover).
