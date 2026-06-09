# Incident-Response-Runbook — Automatenlager (v1)

> Issue #109. Notfallplan bei **Kompromittierung** (gestohlene Credentials,
> kompromittierter Mini/Container, geleakte DB, böswilliger Insider, Cross-Tenant-
> Datenabfluss). Vor Mehrmandanten-/SaaS-Betrieb verbindlich.
>
> **Geltungsbereich heute:** 1 echter Kunde (Faltrix) auf dem Heim-Mini; n8n schreibt
> bis Stufe 6 im RLS-BYPASS. Bei mehreren Kunden ist ein Incident eine
> **meldepflichtige Datenpanne** (DSGVO Art. 33/34, **72 h**).
>
> Dieses Runbook ist **lebendes Dokument**. `<ORG-SPEZIFISCH: …>`-Marker sind vor dem
> ersten externen Kunden auszufüllen. Verwandt: `docs/security/rls-stufe-5-rollback.md`,
> `docs/security/trust-header-invariante.md`, `docs/security/query-filter-guard-allowlist.md`,
> Memories `pg-backup-mechanismus`, `db-rollen-landschaft`, `mini-deploy-mechanismus`.

## 0. Rollen & Erreichbarkeit

| Rolle | Person | Kontakt | Wann |
|---|---|---|---|
| Incident-Lead (entscheidet, koordiniert) | `<ORG-SPEZIFISCH>` | `<ORG-SPEZIFISCH>` | jeder V/H-Incident |
| Technik (Mini/DB/Deploy) | Patrick | `<ORG-SPEZIFISCH>` | immer |
| Datenschutz/DSGVO-Meldung | `<ORG-SPEZIFISCH>` | `<ORG-SPEZIFISCH>` | bei Datenabfluss |
| Externe Hilfe (DFIR/Anwalt) | `<ORG-SPEZIFISCH>` | `<ORG-SPEZIFISCH>` | bei Eskalation |

Zuständige Aufsichtsbehörde (DSGVO): `<ORG-SPEZIFISCH: Landes-Datenschutzbehörde + Online-Meldeformular-URL>`.

## 1. Schweregrade

| Stufe | Definition | Beispiel | Reaktion |
|---|---|---|---|
| **SEV-1 kritisch** | aktiver Zugriff / Datenabfluss / Cross-Tenant-Leck | DB-Dump exfiltriert, fremder Mandant gelesen | sofort eindämmen + Kill-Switch erwägen; DSGVO-Uhr läuft |
| **SEV-2 hoch** | Credential geleakt, noch kein bestätigter Zugriff | Nayax-Token/n8n-Key in Logs/Git | rotieren, Logs prüfen |
| **SEV-3 mittel** | Anomalie / Verdacht | Auth-Fehler-Häufung, unerwarteter Break-Glass | beobachten, untersuchen |

## 2. Kompromittierungs-Indikatoren (worauf schauen, wer & wann)

Mindestens **wöchentlich** (bis Automatik aus ROADMAP A3 steht) sowie bei jedem Verdacht:

- **Auth-Anomalien:** Häufung abgewiesener/Gast-Zugriffe, unbekannte `Tailscale-User-Login`-Werte. Quelle: `dashboard/logs/guest-access.jsonl` (`auditGuestAccess`) + Aktions-Audit (`auditAction`).
- **Break-Glass-Nutzung:** **jede** `X-Support-Tenant`-Sitzung ist ein Ereignis (read-only, auditiert — #118). Unerwartet ⇒ untersuchen.
- **DB-Ebene:** neue/unbekannte Rollen, Rollen mit `BYPASSRLS`/`SUPERUSER` außer `homelab`/`n8n_app` (Soll-Stand: Memory `db-rollen-landschaft`); fehlgeschlagene RLS-Kontextfehler (`42704`) in Dashboard-Logs.
- **Workflow/Job:** `audit.workflow_runs` mit `status='error'`-Häufung; unerwartete `workflow_key`-Werte.
- **Container/Host:** unerwartete Container, geänderte Images (vgl. WF-Update-Check-Historie), CPU/Netz-Spitzen; geänderte Dateien im Bind-Mount.
- **Backup:** `BACKUP_FAIL`/`BACKUP_STALE`-Warnungen (Backup-Manipulation ist ein Angriffsindikator).
- **Git/Secrets:** Treffer der secret-guard-Hooks; `Bearer `/`apikey`/`password`/`secret` in Diffs (CLAUDE.md).

## 3. Phasen — Erkennen → Eindämmen → Ausrotten → Wiederherstellen → Lessons Learned

### 3.1 Erkennen (Detect)
1. Indikator bestätigen (Abschnitt 2). Schweregrad festlegen (Abschnitt 1).
2. **Zeitstempel + Befund sofort protokollieren** (Incident-Log, append-only, mit UTC-Zeit). Beweissicherung **vor** Änderungen: Logs/`audit.workflow_runs`/JSONL **kopieren** (nicht löschen).
3. Bei SEV-1: Incident-Lead + Datenschutz alarmieren — **DSGVO-72h-Uhr beginnt mit Kenntnis** (Abschnitt 7).

### 3.2 Eindämmen (Contain)
- **Identität sperren:** verdächtigen Login aus `DASHBOARD_ADMIN_LOGIN` entfernen (→ wird Gast/read-only) bzw. `tenant_users`/`platform_admins`-Zeile deaktivieren (`active=FALSE`). Default-Deny greift sofort (lib/auth.js `resolveViewer`).
- **Zugang verengen:** betroffenes Gerät aus dem **Tailnet** entfernen / Tailscale-Auth-Key widerrufen (Tailscale-Admin).
- **Break-Glass kappen:** läuft eine missbräuchliche Support-Sitzung, ist sie ohnehin read-only + auditiert; zur Sicherheit Identität sperren.
- **Datenbank:** bei Verdacht auf App-Rollen-Leck **Passwort `automatenlager_app` rotieren** (Abschnitt 5) — kappt alle App-Sessions beim Neustart.
- **Maximaleskalation (SEV-1):** Kill-Switch (Abschnitt 4).

### 3.3 Ausrotten (Eradicate)
- **Alle plausibel betroffenen Secrets rotieren** (Abschnitt 5) — im Zweifel **alle**, da das Nayax-Token heute global ist (ein Leak betrifft alle).
- Schadcode/persistenten Zugang entfernen: Container aus sauberem Image neu bauen (`docker compose up -d --build`), Host-Integrität prüfen, unbekannte Cron/Tasks/Autostarts entfernen.
- Git-History bereinigen, falls ein Secret committet wurde: revoke → Platzhalter → `git filter-repo` → force-push (CLAUDE.md).

### 3.4 Wiederherstellen (Recover)
- Dienste **kontrolliert** wieder online: DB-Integrität prüfen (RLS aktiv? `current_user`? Rollen-Soll? siehe `rls-stufe-5-rollback.md`), dann Dashboard, dann (bis Stufe 6) n8n.
- Bei Datenmanipulation/-verlust: **Restore aus Backup** (Abschnitt 6).
- 24–72 h **verschärft beobachten** (Abschnitt 2).

### 3.5 Lessons Learned (binnen 1 Woche)
- Was passierte, Zeitachse, Ursache (Root Cause), was funktionierte/fehlte, **konkrete Folge-Issues** (z. B. Automatik aus A3, Härtung). Runbook aktualisieren.

## 4. Kill-Switch / Notabschaltung (SEV-1)

Sofort offline nehmen, **least-disruptive zuerst**:

1. **Öffentlichen Zugang kappen:** Tailscale-Serve/Funnel stoppen → von außen nicht mehr erreichbar (Datenpfad zu, DB läuft weiter).
2. **App stoppen:** `ssh miniserver` → `docker compose stop <dashboard>` (+ `<worker>` ab Stufe 6) → kein App-Zugriff mehr.
3. **n8n stoppen:** `docker compose stop homelab-n8n` → keine Hintergrund-Schreiber mehr.
4. **Voll-Stopp:** `docker compose down` (Container weg, **Volumes/DB bleiben** — kein Datenverlust).
5. **Host-Isolation (Extrem):** Mini vom Netz trennen.

> Exakte Service-Namen/Pfade aus dem echten compose: Memory `mini-deploy-mechanismus`.
> **DB-Daten** liegen im Postgres-Volume; `down` löscht sie **nicht** (kein `-v`!).

## 5. Credential-Rotation (geübt halten!)

**Prinzip:** im Zweifel **alle** rotieren. Werte verlassen nie den Mini ungeschützt; nie in Git.

| Secret | Ort | Rotation |
|---|---|---|
| **PostgreSQL `automatenlager_app`** | `dashboard/.env.local` → `DASHBOARD_V2_APP_PG_URL` | neues Passwort in psql (`ALTER ROLE … PASSWORD`), `.env.local` setzen, Container-Restart. Lockout-Recovery: Schlüssel leeren ⇒ Infra-Fallback (`rls-stufe-5-rollback.md`). |
| **PostgreSQL Infra (`homelab`)** | `dashboard/.env.local` → `DASHBOARD_V2_PG_URL` | analog; betrifft Registry/Bootstrap/Backup-Skript. |
| **Nayax Lynx-Token** | n8n-Credential (bis Stufe 6); danach `.env.local` | im Nayax-Portal neu ausstellen, n8n-Credential/`.env.local` setzen. **Global → betrifft alle.** |
| **n8n-API-Key** | `C:\Users\patri\.n8n-api-key` | in n8n neu generieren, Datei ersetzen. |
| **Anthropic/Claude-Key** | n8n-Credential / `.env.local` | im Anthropic-Console neu, ersetzen. |
| **Google (Drive/Gmail)** | n8n-Credential (OAuth) | im Google-Cloud-Projekt widerrufen + neu autorisieren. |
| **Tailscale-Auth** | Tailscale-Admin | Gerät/Key widerrufen, neu joinen. |

Nach jeder Rotation: Dienste neu starten, `/health` + ein Live-Smoke prüfen.

## 6. Backup-Restore-Drill + RPO/RTO

- **Vorhanden:** tägliches `pg_dump -Fc` der Prod-DB auf externe Platte **D:** (Windows-Aufgabe `PG-Backup-Automatenlager`, 03:00, 30 Tage Aufbewahrung). Details/Restore-Befehle: Memory `pg-backup-mechanismus`.
- **Ziele (Vorschlag, `<ORG-SPEZIFISCH>` bestätigen):** **RPO ≤ 24 h** (täglicher Dump), **RTO ≤ 4 h** (Restore + Verifikation).
- **Restore-Drill (quartalsweise üben, NICHT auf Prod):** neueste `.dump` von D: auf eine **Wegwerf-DB** `pg_restore`-n → Zeilenzahlen/Schema/RLS gegen Prod plausibilisieren → Dauer messen (= reales RTO) → protokollieren. Erst ein **geübter** Restore zählt als Backup.
- **Alarm:** `BACKUP_FAIL`/`BACKUP_STALE`-Warnungen müssen jemanden erreichen (Automatik = ROADMAP A3).

## 7. DSGVO-Datenpannen-Prozess (Art. 33/34)

Bei **personenbezogenem** Datenabfluss/-leck:
1. **Uhr startet mit Kenntnis** der Verletzung → **72 h** bis Meldung an die Aufsichtsbehörde.
2. **Bewertung:** Was, wessen Daten, wie viele, Risiko für Betroffene? (Vending-Kontext: v. a. Betreiber-/Geschäftsdaten; Endkunden-Zahlung läuft über Nayax/cashless, nicht hier.)
3. **Meldung an Aufsichtsbehörde** (`<ORG-SPEZIFISCH>`-Formular), wenn Risiko nicht ausgeschlossen — Inhalt: Art, betroffene Mandanten/Kategorien, Umfang, Folgen, Maßnahmen.
4. **Benachrichtigung betroffener Mandanten** bei **hohem** Risiko (Art. 34), klar + ohne unangemessene Verzögerung.
5. **Dokumentieren** (auch wenn keine Meldung nötig — Rechenschaftspflicht).

> Vorlagen (Behörden-Meldung, Mandanten-Benachrichtigung): `<ORG-SPEZIFISCH: anlegen>`.

## 8. Status der Bausteine & Folge-Arbeiten

**Vorhanden (heute nutzbar):** Default-Deny-Auth + Audit-JSONL; Break-Glass read-only + auditiert (#118); `audit.workflow_runs`-Telemetrie; tägliches PG-Backup (Restore erprobt); RLS-Backstop (Stufe 5) + Rollback-Runbook; secret-guard-Hooks + Token-Leak-Prozedur (CLAUDE.md); **Anomalie-Monitor + Alarmierung (#168, Worker `anomaly-monitor`)**; **Cross-Tenant-Audit-Schema (#169)**.

**Cross-Tenant-Audit-Schema (#169, `crossTenantAccess` in `lib/auth.js`):** jeder mandantenübergreifende Zugriff (heute nur über aktives Break-Glass möglich) wird mit `actingLogin`, `isPlatformAdmin`, `homeTenant`, `targetTenant` und dem expliziten Marker **`crossTenant`** (war_mandantenuebergreifend) in `guest-access.jsonl` protokolliert — auf allen Pfaden (`allow`/`block`/`ignore`). Der Anomalie-Monitor (#168) alarmiert auf `BREAK_GLASS_USED`.

**Noch zu automatisieren/härten (eigene Issues, NICHT Teil dieses Runbooks):**
- **Off-Site-Backup + Alarm bei Backup-Fehlern** → ROADMAP A3 (der Anomalie-Monitor #168 alarmiert bereits auf `BACKUP_FAIL`/`BACKUP_STALE`-Warnungen; Off-Site-Backup selbst bleibt offen).
- **Credential-Vault** (pro-Mandant verschlüsselt, Nayax nicht mehr global) → **Stufe 7**.

> **Gate vor erstem externen Kunden:** mindestens Punkte 1–4 + 6 (Phasen, Rotation, Kill-Switch, Restore-Drill, Break-Glass-Audit) müssen **stehen und geübt** sein.
