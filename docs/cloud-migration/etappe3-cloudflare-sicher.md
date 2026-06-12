# Etappe 3 — Frontend → Cloudflare + API hinter Cloudflare (sicher). 2026-06-12

> Schließt den Audit-Punkt **H2** (Cloudflare-Bypass) und **M1** (Rate-Limiting).
> Architektur bewusst als **Proxy** (sicherste Variante): Frontend UND API laufen
> same-origin über Cloudflare; die Pages-Function proxied `/api/*` ans Render-
> Backend und setzt einen geheimen Origin-Header. Kein CORS, Secret nie im Browser.

```
Browser ──► Cloudflare (app.faltrix-solutions.de)
              ├─ statische Assets (v3.*, login.html, status.html, config.js leer)
              └─ /api/* ──► Pages-Function (setzt X-CF-Origin-Secret)
                              └─► Render (faltrix-dashboard.onrender.com)
                                    └─ Origin-Guard: ohne Header ⇒ 403
            (Direkter onrender.com-Zugriff ohne Header ⇒ 403 — Bypass dicht)
```

## Backend-Teil — FERTIG + getestet (autonom, 2026-06-12)

- **Rate-Limit** (`lib/rate-limit.js`, server.js): 600 Req/60 s pro IP (env
  `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`, 0 = aus). `/health` nie limitiert.
  Hinter Cloudflare = echte Besucher-IP (CF-Connecting-IP), sonst Socket-IP.
- **Origin-Guard** (`lib/origin-guard.js`, server.js): mit `CF_ORIGIN_SECRET`
  akzeptiert das Backend nur Requests mit korrektem `X-CF-Origin-Secret`-Header;
  `/health` + `/internal/` ausgenommen. **INERT ohne Secret** (kein Aussperren).
- **Pages-Function** `deploy/cloudflare/functions/api/[[path]].js` + Build
  `deploy/cloudflare/build.sh` (Proxy-Modus, config.js leer/same-origin).
- Tests: `rate-limit` (6) + `origin-guard` (6) + `etappe3-server` (3, spawned).
  Suite 1454/1454. Auf Render/Mini ohne `CF_ORIGIN_SECRET` ⇒ Origin-Guard inert,
  Rate-Limit aktiv (harmlos).

## Cloud-Teil — GEMEINSAME BROWSER-SCHRITTE (Betreiber + Begleitung)

> Voraussetzung: Render-Backend läuft (`faltrix-dashboard.onrender.com`),
> Cloudflare-Zone `faltrix-solutions.de` existiert (Slice 0).

1. **Ein gemeinsames Secret erzeugen** (z. B. `openssl rand -hex 24`) — wird an
   ZWEI Stellen identisch gebraucht (Render + Cloudflare).
2. **Render → faltrix-dashboard → Environment:** `CF_ORIGIN_SECRET` = <Secret>
   hinzufügen, „Save, rebuild, and deploy". (Erst NACH Schritt 5 wirksam machen —
   solange noch kein Cloudflare davor ist, würde ein gesetztes Secret den
   Direktzugriff sperren; daher Secret zuletzt scharf schalten, siehe Schritt 6.)
3. **Cloudflare → Workers & Pages → Create → Pages → Connect to Git:** Repo
   `automatenlager` verbinden (GitHub-Freigabe = Betreiber-Klick). Build-Settings:
   - Build command: `bash dashboard/deploy/cloudflare/build.sh`
   - Build output directory: `dashboard/cf-dist`
4. **Pages → Settings → Environment variables:**
   - `RENDER_API_BASE` = `https://faltrix-dashboard.onrender.com`
   - `CF_ORIGIN_SECRET` = <dasselbe Secret wie in Render>
   Deploy auslösen.
5. **Custom Domain** `app.faltrix-solutions.de` aufs Pages-Projekt (Cloudflare
   macht TLS automatisch). Test: Seite lädt, Login funktioniert (die /api/*-Calls
   laufen über die Function → Render).
6. **Origin-Guard scharf schalten:** Jetzt ist Cloudflare davor. Prüfen, dass
   `https://app.faltrix-solutions.de` funktioniert UND ein direkter Aufruf von
   `https://faltrix-dashboard.onrender.com/api/v2/viewer` jetzt **403** liefert
   (Bypass dicht). Falls der Direktzugriff noch 200 gibt: in Render ist das
   Secret noch nicht aktiv/deployt — Redeploy abwarten.
7. **Supabase → Auth → URL Configuration:** `SITE_URL` =
   `https://app.faltrix-solutions.de`, Redirect-Allowlist `…/login`
   (sonst funktioniert der Passwort-Reset-Mail-Link nicht).

## Verifikation (gemeinsam, nach dem Deploy)

- Browser-QA: `app.faltrix-solutions.de` lädt aus Cloudflare, Login ⇒ v3 mit
  echten Daten (über den Proxy), keine Konsolen-/CORS-Fehler.
- `curl https://faltrix-dashboard.onrender.com/api/v2/viewer` ⇒ **403** (direkter
  Bypass gesperrt); `curl …/health` ⇒ 200 (Healthcheck offen).
- Cloudflare-Analytics zeigt API-Traffic (= läuft durch Cloudflare).

## Rollback

- `CF_ORIGIN_SECRET` in Render leeren ⇒ Origin-Guard inert, Direktzugriff wieder
  offen (Backend unverändert erreichbar). Pages-Projekt pausieren / Domain
  zurück ⇒ Mini bleibt führend (bis Cutover #219). Kein Code-Revert nötig.
