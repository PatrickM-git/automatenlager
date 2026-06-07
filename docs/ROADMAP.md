# ROADMAP — Automatenlager

> Lebendes Dokument. Zweck: **keine Idee geht verloren**; alles in sinnvoller Reihenfolge.
> Jede Phase/jedes Feature bekommt beim Start eine eigene SPEC (`grill-me` → `write-a-stack`
> → Issues → TDD). Stand: 2026-06-07.

## Nordstern (Zielarchitektur)

- **3-Schichten-Cloud:** **Cloudflare** (Frontend) · **Render** (Backend + Cron/Prozesse) ·
  **Supabase** (PostgreSQL + RLS).
- **n8n VOLLSTÄNDIG ablösen** — durch Backend-Code/Cron (auf Render). n8n ist für diese
  Prozesse nicht das richtige Werkzeug.
- **Cloud-agnostisch bauen:** Migration = Umzug, kein Rewrite. RLS-Backstop, Mandanten-Tür
  und SQL-only sind bereits Supabase-portabel (Supabase = Postgres + RLS).
- **Leitprinzip (seit Stufe 4/5):** Autorisierung (Render/App-Schicht) und Datenzugriff
  (Supabase + RLS) sind zwei getrennte Schichten.
- **Reihenfolge-Regel:** **Kein zweiter echter Kunde**, bevor (a) n8n abgelöst (Stufe 6) und
  (b) auf der Cloud — externe Kunden NICHT auf dem Heim-Mini.

## Stand heute

- Mandantenfähigkeit **Stufe 0–5 LIVE** (RLS-Backstop, Lesen+Schreiben). Suite **1089/1089**.
- **SQL-only** (Google Sheets abgelöst), Dashboard v3, Inline-Inventur, **tägliches PG-Backup
  auf externe Platte (Restore erprobt)**.
- Läuft auf dem **Heim-Mini**, **1 echter Kunde** (Faltrix). n8n macht noch WF1/2/3/5/7/8/9
  (im BYPASS, außerhalb des Backstops).
- Reifegrad **~60/100** (Code/Sicherheit/Tests stark; Betrieb/Infra ist der Engpass).

---

## Phase A — Härten, n8n ablösen, Self-Service (noch auf dem Mini)

Ziel: cloud-portabel **+** mehrkundenfähig **+** Kunden handlungsfähig.

- **A1 — Performance-Pass — ✅ ERLEDIGT (2026-06-07, PR #154):** Diagnose: DB war nie der
  Flaschenhals (assortment-slots EXPLAIN: **3,4 ms**); Bremse war **unkomprimiertes,
  nicht-gecachtes Ausliefern** (v3.js 242 KB, `no-store`). Fix: **gzip** (242 KB → **62 KB**,
  −74 %) + **ETag/Conditional-GET** (Repeat-Navigation = 304, kein Neudownload). Transparent,
  Suite 1089/1089. Offen (optional, kleiner Mini-lokaler Gewinn): config/thresholds-Reads je
  Endpunkt bündeln/cachen.
- **A2 — Stufe 6: n8n-Ablösung** (= dein „n8n weg"-Ziel + Cloud-Voraussetzung + Backstop
  systemweit dicht): WF3 (FIFO/Bestand), WF7 (Nachfüllung), WF1/WF2 (Rechnungseingang/
  Produktauswahl), WF5 (MHD-Überwachung), WF8 (GuV-Aggregat), WF9 → schrittweise durch
  **Backend-Code + geplante Jobs** ersetzen. Danach: **#108** (tenantColumn-Brücke +
  `__default__`-Abbau), **#111** (globale Uniques droppen → `ON CONFLICT (tenant_id,key)`).
- **A3 — Betriebsreife:** Monitoring/Alerting + Statusseite + Error-Tracking (z. B. Sentry);
  **Off-Site-/Cloud-Backup + Alarm bei Backup-Fehlern** (lokal vorhanden).
- **A4 — Self-Service-Schicht (Kunden unabhängig machen):**
  - Login-Seite + **Passwort-Reset** + **2FA (TOTP)** + transaktionale E-Mail (Postmark/Brevo).
  - **Mandanten-Admin-UI (Stufe 8):** Kunde verwaltet Standorte/Automaten/Produkte/Slots/
    Schwellwerte/Nutzer selbst (baut auf vorhandenen Endpunkten + RLS).
  - **Onboarding-Wizard:** Daten VORHER (Firmierung+USt-ID, Standorte, Automatenliste,
    Nayax-Zugang/Terminal-IDs, Produktliste+EK, Bankdaten für Provisionen) via Formular/
    CSV-Upload → Webhook → direkt in die Mandanten-Tabellen. NACHHER nur Laufendes.
  - **Credential-Vault (Stufe 7):** pro-Mandant-Secrets (z. B. Nayax-API) verschlüsselt.
- **A5 — Compliance-Basis:** **#109 IR-Runbook**; DSGVO (AV-Vertrag, Daten-Export/Löschung
  pro Mandant, Impressum/Datenschutz).

## Phase B — Cloud-Migration (3-Schichten)

Voraussetzung: **A2 (n8n abgelöst)** + cloud-agnostischer Code.

- **B1 — DB → Supabase:** Postgres + RLS portieren (Tür/Policies/Migrationen gehen direkt mit;
  Verbindungs-/Rollen-Schicht auf Supabase anpassen — `automatenlager_app` ↔ Supabase-Rollen).
- **B2 — Backend + Prozesse → Render:** App + die ex-n8n-Jobs als Render-Cron/Worker.
- **B3 — Frontend → Cloudflare** (Pages/Workers).
- **B4 — Plattform:** Secrets/Env je Umgebung, Domains, **CI/CD + Staging**, Deploy-Pipeline.
- **Danach: externe Kunden möglich.**

## Phase C — Wachstum (nach Cloud + ersten zahlenden Kunden)

- **C1 — Billing:** Stripe Subscriptions (SaaS-Abo für Betreiber). Alternative: Paddle/Lemon
  Squeezy (Merchant-of-Record, nimmt EU-USt ab). *(NICHT die Automaten-Endkundenzahlung —
  die bleibt Nayax/cashless.)*
- **C2 — Marketing-/Buchungs-Website:** erst Positionierung/Inhalt (Wer? Problem? Preis?),
  dann Design (Figma optional — für Brand/Politur), dann Self-Signup → Stripe + Onboarding.
- **C3 — Domänen-Vertiefung (nach echtem Kundenfeedback):** Par-Level + Nachfüll-/
  Bestellvorschläge; Lieferanten/Bestellwesen (knüpft an WF1/2); **Standort-Provisionen/
  -Verträge**; Routen-/Fahrer-Management (+ offline-App); Maschinen-Telemetrie/Störungen/
  Alerts; Pfand-Handling; dynamische/Aktionspreise je Automat.
- **C4 — DE-Compliance-Vertiefung:** DATEV-Export, GoBD-konforme unveränderliche
  Aufzeichnungen, TSE/Kassensicherungsverordnung prüfen (v. a. Bargeld).

---

## Backlog (alle Ideen gruppiert — Sammelbecken)

- **Auth/Sicherheit:** 2FA (TOTP), Login+Passwort-Reset, SSO (später), externe Security-Prüfung.
- **Performance:** Seiten <3 s, Fetch-Parallelisierung, Indizes, MatView-Vorabberechnung.
- **Self-Service/Onboarding:** Mandanten-Admin-UI, Onboarding-Wizard, Daten-VORHER-Automatik.
- **Billing/Vertrieb:** Stripe/Paddle, Marketing-Website, Self-Signup, Preis-/Paketmodell.
- **Vending-Features:** Par-Level, Bestellvorschläge, Bestellwesen, Provisionen, Routen/Fahrer-App,
  Telemetrie/Störungs-Alerts, Pfand, dynamische Preise.
- **Compliance (DE):** DATEV, GoBD, TSE, DSGVO (AV, Export/Löschung).
- **Betrieb/Infra:** Monitoring/Alerting, Statusseite, Sentry, Off-Site-Backup+Alarm, CI/CD,
  Staging, IR-Runbook (#109).
- **Cloud:** Supabase (DB), Render (Backend+Cron), Cloudflare (Frontend), n8n-Ablösung.

## Prinzipien (bei jeder Umsetzung)

1. Cloud-agnostisch bauen — nichts, was den Umzug Cloudflare/Render/Supabase erschwert.
2. Sicherheit/Tests bleiben Fundament: Suite grün, RLS, #107-Wächter, acme/globex-Isolation.
3. Jede Phase startet mit einer SPEC; große Phasen (A2/B) in kleine, einzeln deploybare Slices.
4. Kein zweiter echter Kunde vor Stufe 6 **und** Cloud.
