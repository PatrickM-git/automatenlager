# Slice 2 (#215) — Auth-Naht: Runbook + Ergebnis-Protokoll 2026-06-12

> Gehört zur SPEC `docs/specs/cloud-migration-3-schichten-phase-b-v1.md` (Slice 2).
> Identitäts-Eingang wechselt von Tailscale-Header auf **verifiziertes Supabase-JWT**;
> das RLS-Mandantenmodell (Tür, `tenant_users`, GUC) bleibt UNVERÄNDERT.

## Architektur

- **`lib/supabase-auth.js`:** ES256/RS256-JWT-Verifikation gegen die öffentlichen
  Projekt-JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`, 10-min-Cache) —
  kein Shared-Secret, keine neuen Dependencies. Prüft iss/aud/exp/nbf + Signatur;
  `alg:none`/HS256 hart abgelehnt. Wirft nie ⇒ jeder Fehler = keine Identität.
- **Doppelpfad (`DASHBOARD_AUTH_MODE`):** leer/`tailscale` = wie bisher (Mini);
  `supabase` = Identität NUR aus dem JWT, der spoofbare Tailscale-Header wird NIE
  verwendet. Kein Code-Stichtag; Rollback = Env-Variable zurückstellen.
- **server.js:** verifiziert das Bearer-JWT EINMAL am Handler-Eingang
  (`req._jwtEmail`), `getViewer` bleibt synchron (`identityLogin`). Neue Route
  `GET /api/v2/auth/config` (mode, supabaseUrl, anonKey — der anonKey ist
  Supabases ÖFFENTLICHER Browser-Key). `/login` liefert die Login-Seite.
- **Frontend:** `public/login.html` (minimal, v3-Stil — ordentliches Design =
  Phase-C-Schuld lt. SPEC) mit Login, Passwort-Reset-Anforderung und
  Recovery-Formular (neues Passwort aus dem Mail-Link-Fragment). `v3.js` hat
  einen Fetch-Shim (Authorization-Header an same-origin-Calls) + Login-Wand
  (ohne/abgelaufenes Token ⇒ Refresh-Versuch ⇒ /login).
- **Break-Glass:** unverändert `X-Support-Tenant`, gebunden an den
  Plattform-Admin der VERIFIZIERTEN Identität (Registry), read-only + auditiert.

## Verifiziert (2026-06-12, automatisiert + Browser)

- Unit/Spawned: `tests/supabase-auth-jwt.test.js` (15) + `tests/supabase-auth-server.test.js`
  (2 Spawned-Szenarien inkl. Spoof-Header, abgelaufenes/manipuliertes JWT, /login).
  Volle Suite **1398/1398**.
- E2E gegen ECHTES Supabase (Server lokal, DB+Auth Supabase): Login per REST ⇒
  `/api/v2/viewer` = eigentuemer/t_faltrix; Spoof-Header ohne JWT ⇒ guest/null;
  Break-Glass: unbekannter Mandant 404, Schreibversuch 403, ohne Admin-JWT ignoriert.
- Browser-QA: /login ⇒ Anmeldung ⇒ /v3 lädt echte Faltrix-Daten (Supabase-DB);
  Token gelöscht ⇒ /v3 leitet auf /login um (Default-Deny).

## Provisionierte Supabase-Auth-Ressourcen

- Auth-User **patrickmatthes2609@gmail.com** (per Admin-API, email_confirm=true).
  QA-Passwort in `dashboard/.env.local` (`SUPABASE_QA_LOGIN_PASSWORD`) — **vom
  Betreiber über den Reset-Flow durch ein eigenes ersetzen.**
- Keys in `dashboard/.env.local`: `SUPABASE_ANON_KEY` (publishable, öffentlich),
  `SUPABASE_SECRET_KEY` (secret — NUR serverseitig, nie ins Frontend/Git).
- 2FA (TOTP) ist über Supabase Auth (MFA) verfügbar; Enroll-UI bewusst NICHT
  gebaut (minimaler Login, Phase C). Zweiter Eigentümer (`lantspeku@gmail.com`)
  hat noch KEINEN Auth-User — bei Bedarf via Dashboard/Admin-API anlegen.

## Offene Konfiguration (gehört zu #218/#219, Domain-abhängig)

- **Auth → URL Configuration:** `SITE_URL` + Redirect-Allowlist stehen noch auf
  Defaults. Der Passwort-Reset-Mail-Link funktioniert erst, wenn die finale
  Domain (z. B. `https://app.faltrix-solutions.de/login`) dort eingetragen ist.
- Supabase-Standard-SMTP ist rate-limitiert (~2 Mails/h) — reicht für den
  Betreiber-Login; eigener SMTP (Resend) ist vorhanden, falls nötig.

## Rollback

`DASHBOARD_AUTH_MODE` entfernen/auf `tailscale` ⇒ exakt das bisherige Verhalten
(JWT-Pfad komplett inert; Login-Seite leitet im tailscale-Mode auf /v3 um).
