# SPEC — Cloud-Migration 3-Schichten (Phase B) + Betriebsreife (A3) cloud-nativ

> Stand: 2026-06-11. Gehört zur ROADMAP-Phase **B** (Cloud-Migration), zieht die
> Betriebsreife aus **A3** cloud-nativ herein und nimmt einen **Mindest-Login** aus **A4**
> vorweg (weil der Tailscale-Schutz in der Cloud entfällt). Bewusst **gröber / slice-orientiert**
> geschrieben — die Umsetzung übernimmt das Model **Fable** eigenständig. Jede Slice ist
> einzeln deploybar, live verifizierbar und rückwegsfähig.
>
> **Leitsatz für die Umsetzung:** Gegen den **echten Code** arbeiten, nicht gegen Doku-Annahmen.
> Diese SPEC wurde gegen den echten Code verifiziert (Explore-Pass 2026-06-11); die genannten
> Dateien/Funktionen existieren, aber Zeilennummern verschieben sich — vor jeder Änderung lesen.

---

## Problem Statement

Das System (Dashboard + Worker + PostgreSQL) läuft heute auf einem **Heim-Mini** hinter
**Tailscale**. Das ist der Engpass der gesamten Roadmap:

- **Nicht skalierbar / nicht verkaufsfähig:** Externe Kunden dürfen (Reihenfolge-Regel) nicht
  auf den Heim-Mini. Vor einem zweiten echten Kunden muss das System in der Cloud stehen.
- **Auth hängt an Tailscale:** Die gesamte Admin/Gast-Entscheidung beruht auf dem von Tailscale
  injizierten Header `Tailscale-User-Login` (path-based trust). Im offenen Internet gibt es
  diesen Header nicht — ohne echten Login stünde das Dashboard ungeschützt offen.
- **Betrieb ist der Reifegrad-Engpass:** Backups laufen nur lokal auf eine externe Platte;
  es gibt kein Off-Site-Backup mit Alarm, kein zentrales Error-Tracking, keine Statusseite.
- **Single Point of Failure:** Strom-/Netzausfall am Mini = Totalausfall. Keine
  Plattform-Selbstheilung, keine Redundanz.

Das Fundament ist bereits **cloud-agnostisch** gebaut (RLS-Policies, Mandanten-Tür mit
transaktionslokalem GUC, SQL-only, idempotente Migrationen, App-Rolle ohne BYPASSRLS) — der
Umzug ist deshalb ein **Umzug, kein Rewrite**. Voraussetzung **n8n vollständig abgelöst (A2)**
ist seit 2026-06-11 (Commit `2ff12e9`, Migration 0033) erfüllt.

## Solution

Umzug in die **3-Schichten-Cloud** des Nordsterns, **inkrementell** und mit **kurzem geplantem
Wartungsfenster** (keine Zero-Downtime-Technik):

- **Supabase** — PostgreSQL + RLS + **Auth** (Login/Reset/2FA mitgeliefert).
- **Render** — Backend (`server.js`) + die ex-n8n-Nachtjobs (`worker.js` / `lib/jobs/*`).
- **Cloudflare** — Frontend (statisches `public/v3.*`) + **Domain** (Registrar).

Die **Betriebsreife (A3)** wird cloud-nativ direkt mitgebaut: **Sentry** (Error-Tracking,
cloud-agnostisch), **geplanter `pg_dump` als Off-Site-Backup mit Alarm bei Fehler**, einfache
**Statusseite/Health-Checks**.

**Kostenrahmen:** Start komplett auf **Gratis-Stufen** (eigener Testkunde, Faltrix-Daten);
Hochstufen erst zum Marktstart. Folgen der Gratis-Wahl werden bewusst gelöst:
- Render-Gratis bietet **keine** Cron-Jobs → Nachtläufe via **Supabase `pg_cron`** oder
  **Cloudflare Cron Trigger**, die einen geschützten Trigger-Endpunkt aufrufen.
- Supabase-Gratis bietet **keine** automatischen Backups → eigener geplanter `pg_dump`.

Der **Mini bleibt als Rückfall-Option** parallel laufen, bis die Cloud verifiziert ist
(Rollback = DNS/Env zurückdrehen).

## User Stories

1. As the operator, I want the whole system reachable under my own domain in the cloud, so that it no longer depends on my home hardware and a second customer becomes possible.
2. As the operator, I want a real login wall (email/password) in the cloud, so that the dashboard is not open to the public internet once Tailscale is gone.
3. As a logged-in user, I want password reset and optional 2FA (TOTP), so that account access is self-service and reasonably secure.
4. As the operator, I want my Supabase identity to map onto the existing RLS tenant door, so that every read/write stays tenant-isolated exactly as today — no data leak across tenants.
5. As the operator, I want the nightly jobs (Nayax sales, GuV aggregate, MHD monitor, invoice intake, picklist, etc.) to keep running on schedule in the cloud, so that no data processing is lost in the move.
6. As the operator, I want the nightly jobs to run even on the free tier (no Render cron), so that I don't have to pay before going to market.
7. As the operator, I want an off-site database backup that runs on a schedule and alerts me if it fails, so that I can restore after a disaster — even on the free tier without Supabase auto-backups.
8. As the operator, I want unhandled errors and job failures collected centrally (Sentry), so that I learn about breakage without watching logs.
9. As the operator, I want a simple status/health page, so that I can see at a glance whether backend, worker and DB are healthy.
10. As the operator, I want the migration to happen in a short planned maintenance window, so that I accept brief downtime instead of paying for zero-downtime complexity.
11. As the operator, I want to migrate incrementally (DB first, then backend, then frontend), so that each step is independently verifiable and reversible.
12. As the operator, I want the Mini to stay available as a rollback until the cloud is verified, so that a failed cutover is not catastrophic.
13. As the operator, I want secrets managed as cloud environment variables (not files on disk), so that the ephemeral cloud filesystem doesn't lose configuration.
14. As the operator, I want audit logs and runtime config to survive container restarts, so that the move to an ephemeral filesystem doesn't silently drop the guest-access log or `.dashboard-config.json`.
15. As the operator, I want the RLS infra/app role split reproduced on Supabase (where custom BYPASSRLS roles don't exist), so that the security backstop stays intact after the move.
16. As the operator, I want a documented rollback runbook for each slice, so that I can undo any step safely.
17. As the operator, I want a documented note that the login page is a minimal placeholder, so that it is consciously redesigned properly in Phase C (marketing).

## Implementation Decisions

### Architektur & Reihenfolge (Slices)

Inkrementell, jede Slice einzeln deploybar + live-smoke + rückwegsfähig:

- **Slice 0 — Cloud-Fundament & Domain:** Supabase-Projekt + Render-Account + Cloudflare-Account
  anlegen; **Domain über Cloudflare Registrar** registrieren; Secrets-Inventar (aus
  `.env.example`) als Zielliste der Cloud-Env-Variablen; Entscheidung der konkreten Cron-Quelle
  (pg_cron vs. Cloudflare Cron) festschreiben. Kein Produktivverkehr.
- **Slice 1 — DB → Supabase (B1):** Schema + Migrationen 0001–0034 auf Supabase anwenden;
  Rollen-/RLS-Modell auf Supabase abbilden (siehe unten); GUC registrieren; Faltrix-Daten per
  `pg_dump`/`pg_restore` migrieren; **App (noch auf dem Mini) zeigt testweise auf Supabase** →
  end-to-end mit echter DB in der Cloud, Backend/Frontend noch lokal.
- **Slice 2 — Auth-Naht (Supabase Auth → Mandanten-Tür):** Supabase Auth aktivieren;
  `lib/auth.js`/`server.js` so erweitern, dass die Identität aus einem **verifizierten Supabase-
  JWT** statt aus dem Tailscale-Header kommt; Mapping `auth-user → tenantId/Rolle` über die
  bestehende `tenant_users`-Registry; minimaler Login im v3-Stil. **Doppelpfad** (Tailscale ODER
  JWT) während der Übergangszeit, per Env umschaltbar.
- **Slice 3 — Backend + Jobs → Render (B2):** `server.js` als Render-Web-Service,
  `worker.js` als Render-Background-Worker bzw. — auf Gratis — als per-Cron getriggerte
  Endpunkte; flüchtiges Dateisystem auflösen (Audit-Log/Config in die DB, Secrets als Env);
  Sentry verdrahten.
- **Slice 4 — Frontend → Cloudflare (B3):** `public/v3.*` über Cloudflare Pages/Workers
  ausliefern; API-Calls auf die Render-Backend-Domain zeigen; CORS/Domain/TLS.
- **Slice 5 — Betriebsreife & Cutover-Abschluss (A3 + B4 schlank):** Off-Site-`pg_dump`-Backup
  mit Alarm; Statusseite/Health; finaler Cutover (DNS auf Cloud), Mini als Rollback noch N Tage
  parallel; Rollback-Runbook je Slice; Aufräumen der Mini-/Tailscale-spezifischen Reste.

### Auth-Naht (zentrale Entscheidung)

- **Identitätsquelle wechselt von Tailscale-Header zu Supabase-JWT.** Heute liest `getViewer`
  in `server.js` die drei Header `tailscale-user-login`, `x-support-tenant` und den nicht-
  fälschbaren `req.socket.remoteAddress`. Künftig: das **vom Backend verifizierte Supabase-
  Access-Token** (Signaturprüfung gegen Supabase JWKS) liefert die `login`/`email`-Identität.
- **Die Mandanten-Tür bleibt unverändert.** Aus der verifizierten Identität wird wie heute über
  `tenant-directory.js` (`tenant_users`) der `tenantId`/`roleKey` aufgelöst; die Tür setzt
  weiterhin `set_config('automatenlager.current_tenant', $1, true)`. Supabase Auth ersetzt **nur**
  den Identitäts-Eingang, **nicht** das RLS-Mandantenmodell.
- **Default-Deny bleibt:** kein gültiges JWT ⇒ Gast/abgelehnt. Break-Glass (`x-support-tenant`,
  read-only, auditiert) bleibt erhalten, aber an einen Plattform-Admin-Claim gebunden.
- **Übergang per Schalter:** ein Env-Flag erlaubt während der Migration entweder den
  Tailscale-Pfad (Mini) oder den JWT-Pfad (Cloud) — kein harter Stichtag im Code.
- **2FA/Reset** kommen aus Supabase Auth (keine Eigenbau-Krypto).

### Supabase-spezifische DB-Anpassungen (gegen Code verifiziert)

- **Custom-GUC `automatenlager.current_tenant`:** Muss auf Supabase nutzbar sein, sonst wirft
  jede einarmige RLS-Policy `current_setting(...)` Fehler 42704. Lösung: GUC als Datenbank-
  Default vorregistrieren (`ALTER DATABASE ... SET automatenlager.current_tenant = ''`) **und**
  verifizieren, dass die Tür ihn transaktionslokal setzen darf. **Fail-closed-Verhalten muss
  erhalten bleiben** (fehlender/leerer Mandant ⇒ keine Zeilen / Fehler, kein Leck).
- **Rollen-Split ohne Custom-BYPASSRLS:** Auf Supabase kann eine selbstdefinierte Rolle **kein**
  BYPASSRLS bekommen (nur `service_role`/Superuser umgeht RLS). Abbildung:
  - **Infra-Pool** (Migrationen, MatView-Refresh, Tenant-Directory-Reads) → Supabase-Rolle mit
    RLS-Umgehung (`service_role`-Äquivalent / `postgres`).
  - **App-Pool** (`DASHBOARD_V2_APP_PG_URL`) → Rolle **ohne** RLS-Umgehung, Äquivalent zu
    `automatenlager_app`. RLS gilt für den App-Pfad weiterhin systemweit.
  - `app_reader`/`app_writer`/`automatenlager_app` werden **out-of-band** im Supabase-SQL-Editor
    angelegt (Migration 0022 erwartet sie bereits als Vorbedingung — passt zum Pre-Flight-Muster).
- **`search_path`:** Supabase-Default-Schema ist `public`; die App nutzt `automatenlager` + `audit`.
  Der `search_path` der App-Rolle muss auf Supabase greifen (wie in 0022 gesetzt).
- **Migration 0033** (`ALTER ROLE n8n_app NOBYPASSRLS`): `n8n_app` existiert auf Supabase nicht
  → die Migration **bedingt/idempotent** machen (kein harter Fehler, wenn die Rolle fehlt).
- **Connection-Pooling:** App-Verbindung über den Supabase-Transaction-Pooler (Port 6543);
  Migrationen/Session-gebundenes über die Direktverbindung. `lib/pg-url.js` unterstützt
  `DATABASE_URL` bereits als Alias.

### Flüchtiges Cloud-Dateisystem (Render) — was von Disk weg muss

- **Audit-/Guest-Access-Log** (heute JSONL-Datei, gelesen u. a. von `anomaly-monitor`/`monitor`):
  in eine **DB-Tabelle** (z. B. unter Schema `audit`) umziehen, damit Restarts keine Log-Lücken
  reißen und die Anomalie-Erkennung weiter funktioniert.
- **`.dashboard-config.json`** (n8n-Legacy-Config auf Disk): durch Env-Variablen ersetzen
  (n8n ist abgelöst — Bedarf prüfen, ggf. ganz entfernen).
- **`.env.local`/Last-Success-Datei:** Secrets ausschließlich als **Cloud-Env-Variablen**;
  Last-Success/State in die DB oder einen kurzlebigen, unkritischen Pfad.

### Nachtjobs auf der Gratis-Stufe (kein Render-Cron)

- `worker.js` plant heute per `setInterval` (intervalMs) und `setTimeout` (dailyAt) — **node-cron
  ist bewusst gemieden** (auf dem WSL-Mini unzuverlässig).
- **Variante A (bevorzugt fürs Gratis-Setup):** Jobs als **geschützte HTTP-Trigger-Endpunkte**
  exponieren und von **Supabase `pg_cron`** oder **Cloudflare Cron Trigger** zu den festen Zeiten
  (z. B. WF3 01:00, GuV/MHD/Proposals früh morgens) aufrufen. Schutz: gemeinsames Secret/Token.
- **Variante B (sobald bezahlt):** `worker.js` als Render-Background-Worker mit `restart: always`
  unverändert weiterlaufen lassen.
- Die Job-Logik in `lib/jobs/*` bleibt identisch (durch die Mandanten-Tür, Telemetrie in
  `audit.workflow_runs`). Nur der **Auslöser** wird cloud-tauglich. Zeitzone (`TZ`) explizit setzen.

### Betriebsreife (A3, cloud-nativ)

- **Off-Site-Backup:** geplanter `pg_dump` der Supabase-DB in einen externen Objektspeicher
  (oder versionierter Ablageort); **Alarm bei Fehler** (Mail via Resend / Sentry-Event). Restore
  einmal real proben (wie beim Mini-Backup).
- **Error-Tracking:** Sentry für Backend (`server.js`) und Jobs (`worker.js`/`lib/jobs/*`);
  unhandledRejection/Job-Fehler landen zentral.
- **Statusseite/Health:** der bestehende `/health`-Endpunkt (ok/tenantDirectoryReady/pgConfigured)
  wird zur schlanken Statusquelle; einfache Statusansicht ergänzen.

### Frontend → Cloudflare

- `public/v3.html/v3.js/v3.css` statisch über Cloudflare Pages/Workers; die bestehende
  gzip/ETag-Optimierung (A1) bleibt für die Render-API erhalten, statische Assets liefert
  Cloudflare aus.
- API-Basis (`/api/v2/*`) zeigt auf die Render-Backend-Domain; CORS/TLS/Domain konfigurieren.

### Domain

- Registrierung über **Cloudflare Registrar** (zum Einkaufspreis, DNS-Integration ein Klick).
  Konkreter Name wird in Slice 0 gewählt.

### Visual Direction (bewusst minimal — Schuld notiert)

- Die Login-Seite wird **minimal im bestehenden v3-Stil** gehalten (kein eigener Design-Pass).
  **Bewusst vermerkte technische Schuld:** Die Login-Seite muss in **Phase C (Marketing)**
  ordentlich gestaltet werden (Branding, Onboarding-Look). In der ROADMAP/HANDOVER festhalten.

## Testing Decisions

Guter Test = prüft **externes Verhalten**, nicht Implementierungsdetails. Bestehende Vorbilder:
die Live-Sandbox-Suite mit ROLLBACK (`dashboard/tests/`, `node --test`), die acme/globex-
Isolationstests (Stufe 3–5) und der `0034`-fail-closed-Test.

- **RLS-/Tür-Isolation auf Supabase:** Der bestehende acme↔globex-Isolationsbeweis muss **gegen
  die Supabase-DB** grün sein (kein Cross-Tenant-Leak; fehlender GUC ⇒ Fehler/keine Zeilen).
  Das ist der wichtigste Abnahmetest der DB-Slice.
- **Auth-Naht:** Tests, dass (a) ein gültiges Supabase-JWT auf den korrekten `tenantId`/`roleKey`
  abbildet, (b) ein fehlendes/ungültiges JWT default-deny ergibt, (c) Break-Glass read-only bleibt
  und auditiert wird. Vorbild: bestehende `resolveViewer`/`objectAccessAllowed`-Tests.
- **Job-Trigger:** Test, dass die per-Cron getriggerten Endpunkte (a) ohne gültiges Secret 401/403
  liefern und (b) mit Secret denselben Job-Effekt wie der Worker-Lauf erzeugen (Telemetrie in
  `audit.workflow_runs`).
- **Persistenz-Umzug:** Test, dass Audit-/Guest-Access-Einträge in der DB landen (nicht mehr nur
  Datei) und über einen simulierten Neustart hinweg erhalten bleiben.
- **Backup:** Test/Smoke, dass der `pg_dump`-Lauf eine valide, wiederherstellbare Sicherung
  erzeugt und ein Fehlerfall einen Alarm auslöst.
- **Migration-Idempotenz:** alle 0001–0034 laufen auf Supabase sauber durch; 0033 bedingt
  (n8n_app-Abwesenheit kein Fehler).
- **Volle Suite bleibt grün** (parallel mit `--test-timeout=60000 --test-force-exit`); Flakes
  isoliert gegenprüfen.
- **Live-Smoke je Slice:** `/health` ok, Login funktioniert, ein Nachtjob produziert eine
  plausible `audit.workflow_runs`-Zeile, eine echte Seite lädt tenant-korrekt.

## Out of Scope

- **Zweiter echter / zahlender Kunde** — erst nach erfolgreichem Cloud-Durchlauf (Reihenfolge-Regel).
- **Stripe/Billing, Plan-Gating-Durchsetzung** (Phase C1).
- **Marketing-/Buchungs-Website** und das **ordentliche Login-Design** (Phase C2) — hier nur als
  technische Schuld vermerkt.
- **Neue Vending-Features** (Par-Level, Bestellwesen, Provisionen, Routen, Telemetrie — Phase C3).
- **DATEV/GoBD/TSE-Vertiefung** (Phase C4).
- **Voll ausgebautes Staging + CI/CD-Pipeline** — in dieser Phase **schlank** halten (ein
  Produktiv-Cloud-Setup + Mini als Rollback); echtes Staging/CI/CD kommt mit dem Marktstart (B4).
- **Mandanten-Admin-UI / Onboarding-Wizard / Credential-Vault** (A4/Stufe 7/8) — nicht Teil dieser
  Phase, außer dem hier nötigen Mindest-Login.
- **Hochstufen auf bezahlte Cloud-Tarife** — bewusst erst zum Marktstart.

## Further Notes

- **Voraussetzung erfüllt:** n8n ist vollständig abgelöst (A2/Stufe 6, Commit `2ff12e9`, Migration
  0033, RLS systemweit). Diese Phase kann jetzt umgesetzt werden.
- **Cloud-agnostik zahlt sich aus:** RLS-Policies, Mandanten-Tür (`lib/tenant-db.js`,
  `set_config(...,true)`), SQL-only und idempotente Migrationen gehen direkt mit — der harte Teil
  ist die **Auth-Naht** und die **Plattform-Verkabelung** (Rollen, GUC, Cron, flüchtiges FS), nicht
  die Geschäftslogik.
- **Rollback-Prinzip:** Der Mini läuft bis zur Cloud-Verifikation parallel; Rollback je Slice ist
  „DNS/Env zurückdrehen". Jede Slice bekommt ein kurzes Rollback-Runbook unter `docs/`.
- **Reihenfolge-Disziplin:** Erst wenn die Cloud verifiziert läuft (alle Slices grün, ein voller
  Tag Nachtjobs sauber in `audit.workflow_runs`), gilt die Phase als erledigt und der Mini darf
  abgeschaltet werden.
- **Offene Daten-Bugs (#210/#211, EK/MwSt im GuV-Wareneinsatz)** sind unabhängig von der Migration
  und laufen separat weiter — nicht in dieser Phase mitziehen.
- **Ops-Altlast #78** (`DASHBOARD_INTERNAL_PEER_CIDR`): mit dem Wegfall von Tailscale in der Cloud
  gegenstandslos für den Cloud-Pfad; nur solange relevant, wie der Mini parallel läuft.
