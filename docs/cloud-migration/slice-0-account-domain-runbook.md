# Slice 0 — Account- & Domain-Runbook (manuelle Schritte)

> Issue #212 · ACs „Accounts existieren", „Domain registriert/DNS aktiv",
> „End-to-End verifizierbar". Diese Schritte brauchen **deine Hand** (Login mit
> deiner Identität, Zahlung, Domain-Namenswahl). Alles, was reiner Code/Doku ist,
> liegt bereits vor (`slice-0-secrets-inventory.md`, `slice-0-cron-quelle-entscheidung.md`).
>
> **Gratis-first (SPEC):** Start auf Gratis-Stufen. Die einzige bewusste Ausgabe
> ist die **Domain** (Cloudflare Registrar, zum Einkaufspreis, ~10–15 €/Jahr).

## Reihenfolge

### 1. Supabase-Projekt (Gratis)
1. https://supabase.com → „Start your project" → mit GitHub **oder** Google anmelden.
2. Neues Projekt: Region **EU (Frankfurt `eu-central-1`)** (DSGVO/Latenz), starkes DB-Passwort
   notieren (→ Passwortmanager).
3. Notieren für das Secrets-Inventar (Render-Env):
   - **Project URL** → `SUPABASE_URL`
   - **anon key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (**geheim**)
   - **JWT Secret** (Settings → API) → `SUPABASE_JWT_SECRET`
   - **Connection string** (Settings → Database): Direkt + **Transaction-Pooler (Port 6543)**
     → `DASHBOARD_V2_PG_URL` (Infra/Direkt) und `DASHBOARD_V2_APP_PG_URL` (App/Pooler).
4. Noch **keine** Daten/Schema — das ist Slice 1 (#214).

### 2. Render-Account (Gratis)
1. https://render.com → „Get Started" → mit GitHub anmelden (Repo-Zugriff erlaubt das
   spätere Deploy von `dashboard/server.js`).
2. Nur Account/Workspace anlegen. **Kein** Service deployen (Slice 3, #217).
3. Hinweis: Gratis = kein Dauer-Worker, kein Cron → Auslösung via Supabase `pg_cron`
   (siehe `slice-0-cron-quelle-entscheidung.md`).

### 3. Cloudflare-Account (Gratis)
1. https://dash.cloudflare.com → Sign up (E-Mail).
2. Nur Account anlegen. Pages/Workers-Setup ist Slice 4 (#218).

### 4. Domain über Cloudflare Registrar  ⟵ **einzige Ausgabe**
1. Cloudflare Dashboard → **Domain Registration → Register Domain**.
2. Wunschnamen prüfen, Verfügbarkeit + Jahrespreis ansehen, registrieren (Einkaufspreis,
   keine Marge). Zahlungsmittel hinterlegen.
3. Nach Kauf ist die **DNS-Zone automatisch in Cloudflare aktiv** (keine Nameserver-Migration
   nötig — Registrar = Cloudflare).
4. **Noch keine** produktiven Records auf die Cloud zeigen lassen (der Mini bleibt live).
   DNS-Cutover erst in Slice 5 (#219).

> **Alternative ohne sofortige Ausgabe:** zunächst auf den Gratis-Standard-Subdomains
> starten (`*.onrender.com`, `*.pages.dev`, Supabase-Projekt-URL) und die eigene Domain
> erst kurz vor dem Cutover (Slice 5) registrieren/verbinden. Funktional identisch; die
> Domain ist „nice to have" für die Außenwirkung, kein technischer Blocker.

## Verifikation (AC „End-to-End verifizierbar", Ops — kein Browser-QA)
- [ ] Supabase-Projekt erreichbar, Connection-String testbar (`psql`/Supabase-SQL-Editor).
- [ ] Render-Account erreichbar (Dashboard lädt).
- [ ] Cloudflare-Account erreichbar.
- [ ] (falls Domain gekauft) `dig <domain> NS` zeigt Cloudflare-Nameserver; Zone aktiv.
- [ ] Secrets aus Schritt 1 im Passwortmanager hinterlegt (NICHT ins Git).

## Sicherheit
- Secrets **niemals** in Git/`.env.example` — nur in den Cloud-Env-Stores und im
  Passwortmanager. 2FA auf allen drei Accounts aktivieren.
- `service_role`-Key und DB-Passwort sind die „Kronjuwelen" — nur Render-Env, nie clientseitig.
