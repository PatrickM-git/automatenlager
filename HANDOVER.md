# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.
> Vorige Version archiviert: `HANDOVER_ARCHIVE/HANDOVER_2026-06-11_vor-deploy-und-slice0-accounts.md`.

## Session 2026-06-11 (abends) — #221 LIVE auf dem Mini + Cloud-Slice-0 (#212) KOMPLETT

> Gemischte Session: Prod-Deploy (#221) + Browser-begleitete Account-/Domain-Anlage
> (Slice 0). Ein Hotfix-PR (#226) gemergt, ein Beifang-Bug als #227 gemeldet.

### #221 — Nachbuch-Reconciliation — DEPLOYT, AKTIVIERT, LIVE
- Mini auf `d622636`; **Migration 0036** auf der Prod-DB (idempotent doppelt verifiziert,
  als Rolle `homelab`); Dashboard + Worker neu gestartet, `/health` ok.
- **Backlog-Sichtprüfung (read-only, Prod):** exakt der Issue-Befund — 41×
  `INSUFFICIENT_BATCH_STOCK`, 23× `SKIPPED_BEFORE_CUTOVER`, 13× `OK`-mit-0, **alle April**
  (07.–29.04.). Erwartung: `lastSales`-Fenster enthält sie nicht mehr → erster Lauf lässt
  sie ehrlich als `NO_NAYAX_MATCH` pending; der Job korrigiert ab jetzt frische Lieferlücken.
- **`WORKER_RECONCILE_MS=3600000`** in der Mini-`.env.local` (stündlich); Log bestätigt
  `geplant: wf3-nayax-reconcile (alle 3600s, Intervall)`.
- **Hotfix nötig (PR #226, gemergt):** das Gate las `env` statt `runtimeEnv` —
  `.env.local`-Werte waren fürs Scheduling unsichtbar (Container-Env ≠ runtimeEnv).
- **Beifang → Issue #227:** derselbe latente Bug betrifft ALLE `WORKER_*`-Overrides
  (WF3/GuV/…); Defaults kaschieren ihn. Fix: Schedule-Registrierungen auf `runtimeEnv`.
- Verifikation des ersten Laufs: `audit.workflow_runs` (`wf3-nayax-reconcile`) bzw.
  `GET /api/v2/reconcile/backlog` — Lauf erfolgt ~1 h nach Worker-Restart.

### #212 — Cloud-Slice 0 (Fundament & Domain) — KOMPLETT (Browser-Begleitung)
- **Alle Accounts angelegt** (User klickte Identität/Zahlung, Claude navigierte/konfigurierte):
  - **Supabase**: GitHub-SSO `PatrickM-git`, Org `Faltrix-Lösungen`, Projekt **`Faltrix`**,
    **Frankfurt `eu-central-1`**, Ref `bimftbjpvljjnvorqbtn`. (Erstanlage Irland → gelöscht,
    neu in Frankfurt; Region steckt im Dropdown unter „Spezifische Regionen"!)
  - **Render**: GitHub-SSO, Workspace ohne Services (kommt in #217).
  - **Cloudflare**: Google-SSO `faltrixsolutions@gmail.com`; Zone `faltrix-solutions.de`
    (Free) mit NS `martha`/`moura.ns.cloudflare.com`.
  - **Gmail `faltrixsolutions@gmail.com`** neu (Recovery: `patrickzinke@gmx.net`).
- **Domain-Abweichung:** Cloudflare Registrar kann **kein `.de`** → registriert bei **INWX**
  (Kunden-Nr. 251284, 3,57 € 1. Jahr / ~4,65 €/Jahr, Transfer-Lock, Registrant „Faltrix
  Solutions UG"). **NS-Delegation auf Cloudflare ist live** (8.8.8.8 liefert martha/moura).
  INWX-UI-Falle: Domain-Info-NS-Dialog defekt; funktionierender Weg = Massenaktion→Update→
  Warenkorb→Bearbeiten→Nameserver→„Manuelle Nameservereingabe" (0 €).
- **Ergebnis-Protokoll:** `docs/cloud-fundament-slice-0.md` (Identitäten, Risikostreuung
  Domain≠GitHub, Verifikation, Stolpersteine). AC3/AC4-Doku unverändert unter
  `docs/cloud-migration/`. Supabase-**DB-Passwort im Passwortmanager des Users**.
- GitHub-Browser-Login des Users war anfangs blockiert (Konto-Mail unklar) — gelöst.

## Offene Issues (Stand Sessionende)
- **#214–#219** Cloud-Slices 1–5 — **jetzt entblockt** (Accounts da). **#213** Audit-Log→DB
  (parallel möglich, ohne Blocker). **#227** Worker-env-Bug (klein, klar geschnitten).
  **#198/#206** WF3/WF1-Cutover-Reste. **#164** n8n-Abschluss-Cleanup. **#210/#211**
  GuV-EK/MwSt-Datenbugs. **#108/#111**.

## Nächster Schritt
1. **Neuer Chat → `start-issue` → #214 (DB→Supabase):** Schema + Migrationen 0001–0036 auf
   Supabase, Rollen-Split ohne BYPASSRLS, GUC-Vorregistrierung (`ALTER DATABASE … SET
   automatenlager.current_tenant=''`), Faltrix-Daten via `pg_dump`/`pg_restore`,
   acme↔globex-Isolationsbeweis gegen Supabase. Benötigt: Supabase-DB-Passwort vom User
   (Passwortmanager) für die Connection-Strings; Keys (anon/service_role) aus dem
   Supabase-Dashboard (Settings → API).
2. **Parallel möglich:** #213 (Audit-Log→DB) und #227 (runtimeEnv-Fix, klein).
3. **Beobachten:** erster `wf3-nayax-reconcile`-Lauf in `audit.workflow_runs`; Cloudflare-
   Zonen-Aktivierungsmail an die Faltrix-Gmail.
