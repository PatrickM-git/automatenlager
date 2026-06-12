# Pre-Go-Live-Sicherheitsaudit (Cloud-Migration Phase B) — 2026-06-12

> Defensiver Audit gegen den ECHTEN Code, vor dem Cutover. Anlass: 18-Punkte-
> Betreiber-Checkliste + „50 vibe-coded vulnerabilities". Der Mini läuft noch als
> Produktion; Cutover erst nach Abarbeitung der kritischen/hohen Punkte.

## Scope reviewed
- **Geprüft:** `server.js` (Auth-/Endpunkt-/Fehlerpfade), `lib/supabase-auth.js`,
  `lib/auth.js`, `lib/job-triggers.js`, `lib/cors.js`, `lib/status-page.js`,
  `lib/tenant-db.js`-Nutzung, ~30 `lib/*`-SQL-Pfade, `lib/category-config.js`,
  Upload-Pfade in `server.js`, `lib/jobs/backup-supabase.js`, `render.yaml`,
  `dashboard/deploy/render/Dockerfile`, `public/*.js`, `.gitignore`, Git-History,
  `npm audit`.
- **Nicht abschließend prüfbar (Laufzeit/Konfig, → Open questions):** Cloudflare-
  WAF/Rate-Limiting-Einstellungen, Render-Netzwerk-Restriktionen, Supabase-Auth-
  Policy (Passwortregeln/Brute-Force-Limits), TLS-Cipher (von Render/Cloudflare
  verwaltet).

## Status der Behebung (2026-06-12, Branch `security/pre-go-live-hardening`)

| ID | Status | Umsetzung |
|---|---|---|
| **C1** | ✅ behoben | `resolveAuthMode` fail-closed: `process.env.SUPABASE_URL` (Cloud-Signal) erzwingt supabase-Modus, überstimmt fehlendes/falsches `DASHBOARD_AUTH_MODE`. Tests: `supabase-auth-jwt` + `security-hardening` (Spoof-Header wirkungslos). |
| **H1** | ✅ behoben | 500-Pfad sendet generische Meldung + requestId; Stack nur ins Log/Sentry. `if (!res.headersSent)`-Guard. |
| **H2/M1** | ⏳ Plattform (Etappe 3) | API über proxied Cloudflare-Subdomain + Render-Restriktion → bringt WAF/Rate-Limiting/DDoS auch vor die API. Code-seitig vorbereitet; bleibt Cloudflare-Konfig. |
| **H3** | ✅ behoben | `.dockerignore` (Root + dashboard/) — verifiziert: `.env.local` nicht mehr im Image. |
| **M2** | ✅ behoben | `setSecurityHeaders` (nosniff, X-Frame-Options DENY, Referrer-Policy, HSTS) auf jeder Antwort. CSP bewusst später (Frontend-Refactor). |
| **M3** | ✅ behoben | `/api/v2/status` anonym nur grobe Ampel; Details (Job-Internas) nur für eingeloggte Betreiber. |
| **L1** | ✅ behoben | Magic-Byte-Check (PDF/PNG/JPEG); fälschbarer Name/Header reicht nicht mehr. |
| **DoS (neu, kreativ)** | ✅ behoben | `readJsonBody` hatte KEIN Größenlimit (Body-Flooding); jetzt 1-MB-Limit + Verbindungsabbruch. |
| **L2** | ⏳ Betreiber | QA-Admin-Passwort ersetzen + zweiten Admin-Login einrichten (Etappe 4). |
| **L3/L4** | offen (niedrig) | Audit-Skript-Quoting / `/health`-Minimierung — nicht go-live-blockierend. |

**Verifiziert sicher (zusätzlich, durch adversariales Mitdenken):** Path-Traversal
(`startsWith(PUBLIC_DIR)` nach `normalize`), kein Prototype-Pollution-Vektor,
Open-Redirect (Reset) nur über Supabase-Allowlist, Bestandslogik lehnt negative/
über-gekaufte Mengen ab, Trigger-Secret timing-safe. Suite 1439/1439.

## Executive summary
- **Gesamtrisiko: MITTEL** — das Anwendungsfundament ist überraschend solide
  (Mandantentrennung, Autorisierung, SQL-Hygiene, Secret-Hygiene alle gut),
  ABER es gibt **1 kritischen Konfigurations-Fallstrick** und einige Härtungen,
  die VOR dem Live-Gehen erledigt sein müssen.
- **Höchstes Risiko:** Auth-Modus ist „fail-open" — läuft das Cloud-Backend nicht
  zwingend im `supabase`-Modus, ist die Identität über einen fälschbaren Header
  übernehmbar (Admin-Vollzugriff).
- **Sofortmaßnahme:** `DASHBOARD_AUTH_MODE=supabase` technisch erzwingen (fail-
  closed), Stack-Trace-Leak schließen, API hinter Cloudflare bringen,
  `.dockerignore` ergänzen.

## Findings

| ID | Severity | Kategorie | Fundstelle | Angriffsszenario | Fix |
|---|---|---|---|---|---|
| **C1** | **Kritisch** | Auth-Bypass (fail-open) | `lib/supabase-auth.js:resolveAuthMode` (Default `tailscale`); `lib/auth.js:isTrustedIdentityPath` (ohne `DASHBOARD_INTERNAL_PEER_CIDR` ⇒ immer trusted); `server.js:getViewer` | Steht `DASHBOARD_AUTH_MODE` in der Cloud NICHT auf `supabase` (Default ist `tailscale`!), vertraut das Backend dem **client-gesetzten** Header `Tailscale-User-Login`. Ein Angreifer sendet `Tailscale-User-Login: <admin-email>` und ist sofort Admin (alle Schreibrechte). | `DASHBOARD_AUTH_MODE=supabase` ist in `render.yaml` gesetzt — aber nur per Konvention. **Härten:** Backend fail-closed machen: wenn `SUPABASE_URL` gesetzt ist (= Cloud), den Tailscale-Header-Pfad hart deaktivieren bzw. Start verweigern, falls nicht `supabase`. |
| **H1** | Hoch | Information Disclosure | `server.js:4735` `sendJson(res,500,{error:error.message, stack:error.stack})` | Jeder unbehandelte Fehler liefert dem Client die komplette Stack-Trace (interne Dateipfade, Modulnamen, evtl. SQL-/Schema-Details). Hilft Angreifern bei der gezielten Ausnutzung. | In Produktion generische 500 (`{error:{code:'INTERNAL'}}`); Details nur ins Log/Sentry. |
| **H2** | Hoch | Origin-Exposure / Cloudflare-Bypass | Architektur: `public/config.js` → `window.__API_BASE__` zeigt direkt auf die Render-URL (`*.onrender.com`) | **Nur das Frontend liegt hinter Cloudflare** (Pages). Die gesamte API (Login, alle `/api/v2/*`, `/internal/jobs`) läuft direkt auf der öffentlichen Render-URL — **Cloudflare-WAF, DDoS-Schutz, Bot-Protection und Rate-Limiting greifen für die API NICHT**. Wer die `onrender.com`-Adresse kennt, umgeht den gesamten Cloudflare-Schutz. | API über eine **proxied** Cloudflare-Subdomain (z. B. `api.faltrix-solutions.de`, orange cloud) leiten; `config.js` darauf zeigen; Render so beschränken, dass nur Cloudflare-Traffic akzeptiert wird (Cloudflare-IP-Allowlist oder geheimer Origin-Header). |
| **H3** | Hoch | Secrets im Image (latent) | `dashboard/deploy/render/Dockerfile:24` `COPY . .` ohne `.dockerignore` | `COPY . .` zieht ALLES aus dem Build-Context ins Image. Bei Render (git-basiert) ist `.env.local` gitignored ⇒ nicht im Context (sicher). **Aber** bei jedem lokalen/alternativen Build landen `.env.local` + `node_modules` + `.git` im Image (verifiziert: mein lokaler Test-Build hat `.env.local` mitgezogen). | `.dockerignore` ergänzen (`.env*`, `node_modules`, `.git`, `*.dump`, `dashboard/logs`). Defense-in-depth + kleineres Image. |
| **M1** | Mittel | Rate-Limiting fehlt | gesamtes `server.js` (kein Treffer für rate/limit/throttle) | Kein anwendungsseitiges Rate-Limit auf Login/Reset/API/Trigger. Login-Brute-Force ist Supabase-seitig begrenzt, aber die eigenen API- und `/internal/jobs`-Endpunkte sind am Render-Origin ungebremst (Flooding, Secret-Brute-Force theoretisch). | Mit H2 lösen: Cloudflare-Rate-Limiting vor die API. Zusätzlich App-seitig ein einfaches Limit auf teure/schreibende Endpunkte. |
| **M2** | Mittel | Fehlende Security-Header | `server.js:sendJson` / `sendFile` (nur CORS-Header gesetzt) | API-Antworten von Render tragen kein HSTS, X-Content-Type-Options, Referrer-Policy, kein CSP. (Cloudflare-`_headers` setzt nosniff nur für die statischen Frontend-Assets, nicht für die Render-API.) | HSTS/X-Content-Type-Options/Referrer-Policy am Backend setzen (bzw. via Cloudflare-Proxy nach H2). Cookies: N/A (Auth über Bearer-JWT, keine Cookies). |
| **M3** | Mittel | Information Disclosure | `server.js:2358` `GET /api/v2/status` (öffentlich, vor Auth) | Unauthentifiziert abrufbar: Liste aller internen Jobs + Frische + DB-Status. Liefert Angreifern eine Architektur-Landkarte (welche Jobs, welche Intervalle, ob DB erreichbar). | Statusseite hinter Login legen ODER auf eine grobe Gesamt-Ampel (ok/degraded/down) ohne Job-Details reduzieren. |
| **L1** | Niedrig | Upload-Validierung | `server.js:854/902` MIME aus `content-type`-Header | Dateityp wird aus dem (client-gesetzten) Header geprüft, nicht inhaltsbasiert (kein Magic-Byte-Check). Größe (10 MB) + Typ-Allowlist (PDF/PNG/JPEG, kein SVG) sind aber gesetzt; Datei wird nicht ausgeführt (geht an Drive/Claude-OCR). | Defense-in-depth: Magic-Bytes prüfen (PDF `%PDF`, PNG/JPEG-Signatur). |
| **L2** | Niedrig | Default-/QA-Credential | `.env.local:SUPABASE_QA_LOGIN_PASSWORD` (von mir generiert) | Das beim Test angelegte Admin-Passwort ist ein Zufallswert, steht aber im Klartext in `.env.local`. | Vor Live über den Reset-Flow durch ein eigenes ersetzen (war ohnehin geplant). |
| **L3** | Niedrig | SQL-String-Interpolation (nicht produktiv) | `dashboard/scripts/sheets-db-audit/dump-db-inventory.js:23` Tabellenname interpoliert | Audit-Skript (nicht im Request-Pfad), Tabellenname aus festkodierter Liste. Kein Live-Risiko. | Bei Gelegenheit auf Identifier-Quoting umstellen; nicht go-live-blockierend. |
| **L4** | Niedrig | Info-Disclosure | `server.js:2311` `GET /health` öffentlich | Minimaler Status (ok/db-ready). Üblich für Health-Checks, geringer Wert für Angreifer. | Akzeptabel; optional auf bloßes 200/503 reduzieren. |

## Bestätigt SICHER (kein Handlungsbedarf — wichtig fürs Vertrauen)

- **SQL-Injection (Top-3):** Produktivcode nutzt durchgängig **parametrisierte
  Queries** ($1/$2…). Interpolierte `${}` in SQL sind ausschließlich Platzhalter-
  Strings, Konstanten oder intern abgeleitete/numerisch erzwungene Werte
  (`category-config.js:97` erzwingt `mhdRiskDays` via `Number`+`Math.max`). Keine
  injizierbare User-Eingabe gefunden.
- **Autorisierung (Top-1) & Schreibpfade:** ALLE schreibenden Endpunkte
  (refill, invoice-proposal, economics-correct, write-off, set-count,
  slot-change, correction-action, nayax-abgleich, onboarding, slot-assign,
  locations/machines/profiles, settings) prüfen `canTriggerActions` bzw.
  `requireCapability`; `rejectBodyTenant` verhindert Cross-Tenant-`tenant_id` im
  Body. `/internal/jobs` ist ohne `WORKER_TRIGGER_SECRET` tot (404), Secret-
  Vergleich timing-safe.
- **IDOR (Top-2) & Mandantentrennung:** `objectAccessAllowed`/`requireObjectAccess`
  (fremd/unbekannt ⇒ 404, kein Leak); Lesepfade durch die Mandanten-Tür mit
  `tenant_id`-Filter; RLS in Supabase über `automatenlager_app` **ohne** BYPASSRLS;
  Isolationssuite 163/163 grün. Fehlender Mandant ⇒ fail-closed (42704).
- **JWT-Auth:** ES256 gegen Projekt-JWKS, `iss`/`aud`/`exp` geprüft, **alg-
  Downgrade (none/HS256) abgelehnt**, manipulierte Payload schlägt fehl, wirft nie
  (fail-closed).
- **Secrets (Top-8):** `.env.local` gitignored + **nie committed**; **keine
  Secrets in der Git-History**; keine hartcodierten Keys/Passwörter im Code; keine
  echten Geheimnisse im Frontend-JS (nur das öffentliche `anonKey` + das User-
  eigene JWT im localStorage); **keine Tokens/Passwörter im Logging**.
- **Supply-Chain (Top-Liste):** `npm audit` = **0 vulnerabilities**; Base-Image
  `node:22-alpine` (aktuell).
- **Backup (Top-10):** Off-Site auf separater Platte (nicht öffentlich), Restore
  real geprobt (#216). (Hinweis: Dump unverschlüsselt — siehe Open questions.)
- **CORS:** exakte Origin-Allowlist, kein Wildcard, **keine** Allow-Credentials.
- **Geräte-Auth Automaten (Top-7):** Automaten reden NICHT direkt mit diesem
  Backend — Verkaufsdaten kommen serverseitig über die Nayax-API (Pull). Keine
  vom Gerät getriggerten Endpunkte ⇒ kein Geräte-Spoofing-Vektor in dieser App.
- **Payment-Webhooks (Top-5/9):** kein eigener Payment-/Webhook-Empfang in dieser
  Phase (Stripe = Phase C). Nayax wird ausgehend gepollt, nicht als eingehender
  Webhook akzeptiert.

## Secure remediation plan

### 1. Vor dem Cutover ZWINGEND (Go-Blocker)
1. **C1** — Auth-Modus fail-closed: bei gesetzter `SUPABASE_URL` den Tailscale-
   Header-Pfad hart deaktivieren / Start verweigern, wenn nicht `supabase`.
2. **H1** — Stack-Trace-Leak in `server.js:4735` schließen.
3. **H2/M1** — API hinter Cloudflare (proxied Subdomain) + Render auf Cloudflare
   beschränken; damit greifen WAF/Rate-Limiting/DDoS/Bot-Schutz auch für die API.
4. **H3** — `.dockerignore` ergänzen.

### 2. Kurzfristige Härtung (vor erstem echten Verkehr)
5. **M2** — Security-Header (HSTS, X-Content-Type-Options, Referrer-Policy).
6. **M3** — `/api/v2/status` hinter Login oder auf grobe Ampel reduzieren.
7. **L2** — QA-Admin-Passwort ersetzen; **zweiten Admin-Login** per Supabase-
   Einladung anlegen (autorisierungsseitig schon vollwertig).
8. Supabase-Auth-Policy setzen: Passwort-Mindestlänge, ggf. MFA aktivieren,
   „Leaked Password Protection" einschalten.

### 3. Tests/Monitoring
9. Regressionstest: „Tailscale-Header wird im supabase-Mode ignoriert" (existiert
   bereits in `tests/supabase-auth-server.test.js`) + neuer Test für C1-Fail-Closed.
10. Anomalie-Monitor (#168) läuft bereits (Auth-Fail-Spike, Break-Glass) — nach
    Cutover beobachten.

## Open questions
- Cloudflare-Tarif/WAF/Rate-Limiting/Bot-Protection: aktiviert? (bestimmt, wie
  viel von H2/M1 die Plattform abdeckt).
- Soll die API über eine proxied Cloudflare-Subdomain laufen (empfohlen) oder
  direkt auf Render bleiben (dann App-seitiges Rate-Limiting nötig)?
- Backup-Dump-Verschlüsselung gewünscht? (aktuell unverschlüsselt auf privater
  Platte — bei personenbezogenen Daten i. d. R. empfohlen).
- DSGVO (Punkt 18): Lösch-/Auskunftsfunktion für personenbezogene Daten — in
  dieser Phase nicht im Scope; für echten Mehrkundenbetrieb (Phase C) einplanen.
