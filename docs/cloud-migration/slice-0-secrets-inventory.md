# Slice 0 — Secrets-Inventar (Cloud-Env-Zielliste)

> Issue #212 · AC „Secrets-Inventar dokumentiert". Quelle: `dashboard/.env.example`
> (kommentierte Referenz aller Variablen) + die im Code gelesenen `NAYAX_*`-Werte.
> Ziel: jede Variable einem Cloud-Ziel zuordnen (**Render-Env** / **Supabase** /
> **Cloudflare**) oder als **entfällt in der Cloud** markieren (Mini/Tailscale/n8n).
>
> Leitprinzip (SPEC §"Flüchtiges Cloud-Dateisystem"): **Secrets ausschließlich als
> Cloud-Env-Variablen**, nichts auf Disk. Das flüchtige Render-FS verliert Dateien
> bei jedem Neustart.

## Legende der Ziele

- **Render-Env** — Umgebungsvariable des Render-Backend-Service (`server.js`) bzw. des
  Job-Auslösers. Hier liegen praktisch alle Laufzeit-Secrets.
- **Supabase** — kommt aus dem Supabase-Projekt (DB-URL, Keys, JWT). Wird in Render
  als Env eingetragen; „Quelle" = Supabase.
- **Cloudflare** — Frontend/DNS/Domain. Fast nichts Geheimes (statische Assets); ggf.
  ein API-Base-URL-Build-Wert.
- **entfällt** — in der Cloud gegenstandslos (n8n abgelöst, Mini/Tailscale weg).
- **NEU** — existiert heute nicht, wird für die Cloud gebraucht.

## A. Datenbank (Supabase)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `DASHBOARD_V2_PG_URL` | **Supabase → Render-Env** | Infra-Verbindung (RLS-Umgehung). In der Cloud = `service_role`-äquivalente Rolle / `postgres`. Direktverbindung für Migrationen/MatView/Registry. |
| `DASHBOARD_V2_APP_PG_URL` | **Supabase → Render-Env** | App-Verbindung (`automatenlager_app`-Äquiv., **kein** BYPASSRLS). Über den **Transaction-Pooler (Port 6543)**. RLS gilt systemweit. |
| *(Alias `DATABASE_URL`)* | optional | `lib/pg-url.js` akzeptiert `DATABASE_URL` als Alias — Render setzt das teils automatisch. |

> Supabase-Fallstricke (SPEC, gegen Code verifiziert): GUC `automatenlager.current_tenant`
> als DB-Default **vorregistrieren** (sonst 42704); Rollen-Split **ohne Custom-BYPASSRLS**;
> `search_path` der App-Rolle auf `automatenlager, audit, public`. → Slice 1 (#214).

## B. Auth (Supabase Auth → ersetzt Tailscale)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `DASHBOARD_ADMIN_LOGIN` | **Render-Env (Semantik ändert sich)** | Admin-Allowlist. Heute = Tailscale-Login; künftig = E-Mail aus verifiziertem **Supabase-JWT** (Mapping über `tenant_users`). Variable bleibt, Quelle der Identität wechselt. |
| `DASHBOARD_PARTNER_LOGIN` | **Render-Env** | wie oben (Partner: lesen, nicht schreiben). |
| `SUPABASE_URL` | **NEU — Supabase → Render-Env** | Projekt-URL (Auth + REST). |
| `SUPABASE_ANON_KEY` | **NEU — Supabase → Render/Cloudflare** | Public-Key fürs Frontend-Login (kein Secret im engeren Sinn). |
| `SUPABASE_SERVICE_ROLE_KEY` | **NEU — Supabase → Render-Env** | Server-seitig (Admin-Operationen). **Geheim.** |
| `SUPABASE_JWT_SECRET` **oder** JWKS-URL | **NEU — Supabase → Render-Env** | Backend verifiziert das Access-Token (Signatur). |
| `AUTH_MODE` (o. ä. Schalter) | **NEU — Render-Env** | Doppelpfad „Tailscale ODER JWT" während der Migration (SPEC §"Auth-Naht"). |
| `DASHBOARD_DEV_LOCAL_ADMin` | **entfällt** | Loopback-Dev-Escape (Tailscale-/Mini-Welt). |
| `DASHBOARD_INTERNAL_PEER_CIDR` | **entfällt** | Tailscale/Docker-Peer-Trust (#78) — ohne Tailscale gegenstandslos. |

## C. Externe Dienste (Secrets — Render-Env)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `NAYAX_API_TOKEN` | **Render-Env** | Nayax-Auth. **Geheim.** (heute in `.env.local`/`.env.connections`). |
| `NAYAX_BASE_URL` / `NAYAX_HEADER_NAME` / `NAYAX_MACHINE_ID` / `NAYAX_TENANT_ID` | **Render-Env** | Nayax-Konfiguration (Live-Import, Füllstand, Reconcile, Devices). |
| `ANTHROPIC_API_KEY` | **Render-Env** | Claude (Proposals/OCR). **Geheim.** |
| `RESEND_API_KEY` / `MAIL_FROM` / `ALERT_EMAIL_DEFAULT` | **Render-Env** | E-Mail (Digest/Alerts). |
| `GOOGLE_DRIVE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | **Render-Env** | OAuth (WF1 Rechnungen, WF9 Pickliste). **Geheim.** |
| `GOOGLE_DRIVE_PICKLIST_FOLDER_ID` / `_PROCESSED_FOLDER_ID` / `_INVOICE_FOLDER_ID` / `_INVOICE_PROCESSED_FOLDER_ID` | **Render-Env** | Drive-Ordner-IDs. |
| `WF1_TENANT_ID` / `WF9_TENANT_ID` | **Render-Env** | Ziel-Mandant je Drive-Quelle. |
| `GITHUB_TOKEN` / `GITHUB_REPO` | **Render-Env** | Cutover-Monitor-Issues (wird im Cleanup ggf. entfernt). |

## D. Job-Steuerung / Schedules (werden zur Cron-Quelle)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `WORKER_WF3_MS`, `WORKER_WF1_MS`, `WORKER_NAYAX_FILL_MS`, `WORKER_RECONCILE_MS`, `WORKER_GUV_MS`, `WORKER_*_AT`, … | **wird Cron-Schedule (Slice 3, #217)** | Auf der **Gratis-Stufe gibt es keinen Dauer-Worker** → die Intervalle/Uhrzeiten werden zu **pg_cron-Schedules**, die geschützte Trigger-Endpunkte aufrufen. Variablen bleiben als Fallback (Variante B: bezahlter Render-Worker). Siehe `slice-0-cron-quelle-entscheidung.md`. |
| `WF3_CUTOVER` / `WF1_CUTOVER` | **Render-Env** | Schatten→Schreiben-Schalter (post-Cutover ggf. obsolet). |
| `CUTOVER_STREAK_THRESHOLD` / `WORKER_CUTOVER_AT` | **Render-Env / entfällt** | Cutover-Wächter wird im Cleanup aus dem Schedule genommen (CLAUDE.md). |
| `WORKER_ANOMALY_MS`, `ANOMALY_WINDOW_MIN`, `ANOMALY_AUTHFAIL_MAX`, `ANOMALY_ERRORRUN_MAX` | **Render-Env** | Anomalie-Monitor (#168). |
| `WORKER_TRIGGER_SECRET` | **NEU — Render-Env** | Gemeinsames Secret, mit dem die Cron-Quelle die Trigger-Endpunkte authentisiert (siehe Cron-Doc). **Geheim.** |
| `TZ` | **NEU — Render-Env** | Zeitzone explizit setzen (`Europe/Berlin`) — sonst driften die Schedules (SPEC). |

## E. Betriebsreife (A3, cloud-nativ)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `SENTRY_DSN` | **NEU — Render-Env** | Error-Tracking Backend + Jobs (SPEC §"Betriebsreife"). |
| `EXTERNAL_FETCH_TIMEOUT_MS` | **Render-Env** | harter Timeout aller externen Calls (`lib/fetch-timeout.js`). |
| Off-Site-Backup-Ziel (`BACKUP_*` / Objektspeicher-Keys) | **NEU — Render-Env** | geplanter `pg_dump` der Supabase-DB + Alarm (#216). **Geheim.** |

## F. Audit/Config-Persistenz (flüchtiges FS → DB/Env)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `DASHBOARD_AUDIT_LOG` (JSONL) | **entfällt (DB-Senke maßgeblich)** | Seit #213/Migration 0035 ist `audit.access_log` die maßgebliche Senke; die Datei ist nur lokaler Dev-Fallback. Auf dem flüchtigen Render-FS **nicht** verwenden. |
| `DASHBOARD_AUDIT_DB` | **Render-Env** | DB-Senke an/aus (Default an). |
| `DASHBOARD_CONFIG_FILE` (`.dashboard-config.json`) | **entfällt** | n8n-Legacy-Config; n8n abgelöst → Env statt Datei (Bedarf prüfen/entfernen). |

## G. Frontend / Domain (Cloudflare)

| Variable | Ziel | Anmerkung |
|---|---|---|
| `API_BASE_URL` (Frontend-Build) | **NEU — Cloudflare** | zeigt auf die Render-Backend-Domain; CORS/TLS dort konfigurieren (Slice 4, #218). |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | **Cloudflare (Build)** | fürs clientseitige Login (Supabase-JS), falls Login im Frontend. |

## H. n8n / Mini — entfällt vollständig

| Variable | Ziel |
|---|---|
| `N8N_BASE_URL`, `N8N_API_KEY` | **entfällt** (n8n abgelöst, 2026-06-11). |
| `INVOICE_UPLOAD_WEBHOOK_URL`, `NAYAX_ABGLEICH_WEBHOOK_URL`, `SLOT_CHANGE_WEBHOOK_URL` | **entfällt** (alles läuft in-process durch die Tür). |

---

### Zusammenfassung der NEUEN Cloud-Variablen (Checkliste Slice 1–3)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`,
`AUTH_MODE`, `WORKER_TRIGGER_SECRET`, `TZ`, `SENTRY_DSN`, `API_BASE_URL`,
Backup-Zielspeicher-Keys.

### Wegfallend

`N8N_*`, `*_WEBHOOK_URL`, `DASHBOARD_DEV_LOCAL_ADMIN`, `DASHBOARD_INTERNAL_PEER_CIDR`,
`DASHBOARD_CONFIG_FILE`, JSONL-`DASHBOARD_AUDIT_LOG` (nur lokaler Dev-Fallback).
