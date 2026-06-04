# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-04 — AUTH & SICHERHEIT v1 MILESTONE KOMPLETT (alle 8 Issues live auf Mini)

**Der gesamte Auth-/Sicherheits-Milestone aus SPEC `docs/specs/auth-sicherheitskonzept-v1.md` ist umgesetzt, gemergt und auf dem Mini deployt+verifiziert.** Suite **805/805**.

### Was steht jetzt (Fundament)
- **`dashboard/lib/auth.js` → `resolveViewer`:** Default-Deny; **exakte Allowlist** (kein `startsWith('patrick')` mehr); 6 Capabilities (`betrieb.lesen`, `finanzen.lesen`, `bestand.schreiben`, `workflows.starten`, `nayax.schreiben`, `system.verwalten`); 3 Rollen (eigentuemer/auffueller/gast); `can(cap)`, `canTriggerActions=can('workflows.starten')`, `tenantId`. F1-Pfad-Trust via `remoteAddress`+CIDR (`objectAccessAllowed`, `isTrustedIdentityPath`).
- **`dashboard/server.js`:** `requireCapability(viewer,cap,res)`→403+`auditDenied`; `auditAction`/`auditDenied`→append-only JSONL (mode 0o600); `requireObjectAccess`→404 (IDOR); `viewerPublic` (capabilities[]+roleKey für /api/dashboard).
- **Mini-Env:** `DASHBOARD_ADMIN_LOGIN=patrickmatthes2609@gmail.com` (exakte Tailscale-Serve-Login). Recovery-Hebel: `DASHBOARD_DEV_LOCAL_ADMIN` (nur loopback).

### Die 8 Issues
| # | Inhalt | Status |
|---|--------|--------|
| #27 | Default-Deny | ✅ live |
| #28 | RBAC / Capabilities | ✅ live |
| #29 | Frontend-Gating (v3 ROUTES `cap` + `viewerCan` + buildNav-Filter + caps-Boot) | ✅ live |
| #30 | Secret-Handling | ✅ live |
| #31 | Settings + Ladenhüter editierbar, an `system.verwalten` gebunden (#31-Sec) | ✅ live |
| #32 | Audit-Log (JSONL) | ✅ live |
| #33 | IDOR / `requireObjectAccess` | ✅ live |
| #34 | MHD-Risiko-Fenster editierbar (PR #86) | ✅ live |

### #34 im Detail (diese Session abgeschlossen)
`mhdRiskDays` (Default 30) in `dashboard/lib/category-config.js` (merge/sanitize wie `ladenhueterDays`). Das harte `INTERVAL '30 days'` an **allen** Fundstellen durch die Settings-Quelle ersetzt: `inventory-mhd.js`, `overview-monitoring.js` (2× + `LIVE_WARNING_RECONCILE_SQL`→Funktion), `assortment-slots.js` (SQL + JS-Indikator `parseSlotRow`/`buildIndicators`). UI-Feld in `/einstellungen` (`public/v3.js`, Schreiben nur `system.verwalten`). → **eine konsistente Quelle** für Cockpit-KPI / Bestand / Monitoring. +2 Tests. Live verifiziert: `:8443/api/v2/settings/definitions`→`mhdRiskDays:30`, `/api/v2/inventory-mhd`→HTTP 200.

### Homelab-seitig (Auth-Milestone)
#57 Tailscale Serve HTTPS:8443/Loopback deployt. Docker-Loopback-Bind verworfen (bräche WSL-netsh-portproxy) → Dashboard bleibt `0.0.0.0:8787`; `serve off` schließt die Tailnet-Exposure. Header-Overwrite-Sicherheit live geprüft.

### OFFEN — brauchen User-Entscheidung, NICHT autonom gestartet
- **#31-Feature: Pro-Automat-Override** von MHD/Schwellwerten. **Design-Fork:** neue `settings_thresholds`-Tabelle (empfohlen) vs. `classification_settings` erweitern.
- **#78:** F1 (Identity-Header-Trust / CIDR) auf dem Mini scharfschalten.
- **#80:** `finanzen.lesen` voll gaten inkl. generischem `/api/v2/economics`-Dispatcher.
- **#9:** v2-Abschaltung.
- **spec-to-issue Audit-Bucket-A** (Sheets→DB-Vollständigkeits-Audit vor Cutover, knüpft an `docs/specs/sql-only-migration.md`).

### Deploy-Weg (Referenz)
SSH→`wsl -d Ubuntu-24.04 bash`→ in `/mnt/c/homelab/projekte/automatenlager`: `git pull --ff-only origin main` + `docker restart homelab-dashboard` (Code) bzw. `docker compose -f /mnt/c/homelab/docker-compose.yml up -d --no-deps --force-recreate dashboard` (Env-Änderung). SSH-Quoting: base64-Kette nutzen (`$(...)` expandiert sonst lokal).

### Lehren dieser Session
- Test-Spawns brauchen `DASHBOARD_DEV_LOCAL_ADMIN` in der env (correction-action / machine-profiles / product-onboarding / einstellungen).
- Lockout-Linchpin: vor jedem Default-Deny/Allowlist-Deploy die exakte Mini-Login-Mail in `DASHBOARD_ADMIN_LOGIN` sicherstellen + live `is_admin=true` verifizieren, bevor der alte Prefix-Pfad wegfällt.

---
