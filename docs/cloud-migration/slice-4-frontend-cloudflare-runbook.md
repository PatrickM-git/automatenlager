# Slice 4 (#218) — Frontend → Cloudflare: Runbook + Ergebnis-Protokoll 2026-06-12

> SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md` (Slice 4). Das
> statische Frontend (`public/v3.*`, `login.html`) liefert Cloudflare aus; die
> API-Calls gehen ans Render-Backend; CORS/TLS/Domain.

## Architektur der Cloud-Trennung

- **Laufzeit-API-Basis statt Hardcode:** `public/config.js` setzt
  `window.__API_BASE__`. Auf dem Mini leer (same-origin); auf Cloudflare durch
  `deploy/cloudflare/config.cloud.js` mit der Render-URL ersetzt. v3.html und
  login.html laden `config.js` VOR ihrem Skript.
- **Fetch-Shim (`v3.js`):** Backend-Pfade (`/api`, `/health`, `/internal`)
  werden auf `API_BASE` umgeschrieben und tragen das Supabase-JWT; statische
  Assets bleiben same-origin (Cloudflare). Leerer API_BASE ⇒ unverändert
  same-origin (Mini, kein Code-Stichtag).
- **CORS (`lib/cors.js`, server.js):** exakte Origin-Allowlist
  (`DASHBOARD_CORS_ORIGINS`), Echo-Origin + `Vary: Origin`, Preflight-OPTIONS ⇒
  204, **keine** `Allow-Credentials` (Auth = Bearer-JWT, nicht Cookies — keine
  Cookie-Exfiltration). Leere Allowlist (Mini) ⇒ CORS inert.
- **Cloudflare-Pages-Routing:** `_redirects` spiegelt den server.js-SPA-Fallback
  (`/`, `/v3`, `/v3/*` → v3.html; `/login` → login.html); `_headers` setzt
  `config.js: no-store` (sonst klebt eine alte API-Basis).

## Verifiziert (2026-06-12, automatisiert + lokaler Browser-QA)

- 9 CORS-Unit/Spawned-Tests (Allowlist, Preflight 204, Default-Deny, inert ohne
  Allowlist, keine Credentials, API-Basis-Auflösung). Volle Suite **1425/1426**
  (1 bekannter Windows-Spawned-Parallel-Flake `dashboard-auth`, isoliert 19/19).
- **Cloudflare-Build lokal:** `RENDER_BACKEND_URL=… build.sh` erzeugt das
  Output-Verzeichnis mit eingesetzter Render-URL in `config.js` + `_redirects`/
  `_headers`.
- **Browser-QA (lokaler server.js, supabase-Mode, CORS-Allowlist gesetzt):**
  - /login lädt sauber: `config.js` (304), `/api/v2/auth/config` (200), **keine
    Konsolenfehler**, kein fehlerhafter Request.
  - Default-Deny: /v3 ohne Token ⇒ Redirect auf /login.
  - Login gegen echtes Supabase speichert das Token (Anmeldung erfolgreich).
  - CORS-Preflight von `https://app.faltrix-solutions.de` ⇒ **204** mit
    `Access-Control-Allow-Origin`; ohne Allowlist inert.
  - (Der volle visuelle v3-Cockpit-Load mit Echtdaten wurde in der #215-Session
    auf demselben — durch #218 unveränderten — same-origin-Pfad gezeigt.)

## Aktivierung in der Cloud (Betreiber — hängt an #217-Render-Deploy + Domain)

1. **Cloudflare Pages-Projekt** (Repo `PatrickM-git/automatenlager`):
   - Build command: `RENDER_BACKEND_URL=https://<render-domain> bash dashboard/deploy/cloudflare/build.sh`
   - Build output directory: `dashboard/cf-dist`
   - (Alternativ ohne Build: Output-Dir `dashboard/public` + `_redirects`/`_headers`/
     `config.js` manuell überlagern.)
2. **Custom Domain** `app.faltrix-solutions.de` aufs Pages-Projekt (Cloudflare
   verwaltet TLS automatisch; Zone liegt seit Slice 0 bei Cloudflare).
3. **Render-Backend** (#217): `DASHBOARD_CORS_ORIGINS=https://app.faltrix-solutions.de`
   setzen (ggf. + `https://<projekt>.pages.dev` für die Vorschau-URL).
4. **Supabase Auth → URL Configuration:** `SITE_URL=https://app.faltrix-solutions.de`,
   Redirect-Allowlist `…/login` (sonst funktioniert der Passwort-Reset-Mail-Link
   nicht — offener Punkt aus #215).
5. **Live-Browser-QA:** app-Domain öffnen ⇒ Login ⇒ v3 lädt aus Cloudflare, Daten
   vom Render-Backend, tenant-korrekt, keine Konsolen-/CORS-Fehler.

## Rollback

`config.js` zeigt auf dem Mini same-origin (leer) ⇒ der Mini bleibt voll
funktionsfähig. Cloudflare-Pages-Projekt pausieren/DNS zurück = Mini führt weiter
(bis zum finalen Cutover #219).
