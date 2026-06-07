# HANDOVER.md

> Update this file at the end of every session. Archive the previous version to `HANDOVER_ARCHIVE/HANDOVER_<date>.md` before overwriting.

## Stand: 2026-06-07 — Mandantenfähigkeit STUFE 4 „Schreib-Isolation" — Issues #131–#139 KOMPLETT (Code), Mini-Deploy + Live-Smoke AUSSTEHEND

Branch `feat/write-isolation-stufe-4` (9 Commits), Suite **1056/1056 grün** (live gegen die
Mini-DB im #94-Sandbox-Harness, ROLLBACK). SPEC:
`docs/specs/multi-tenant-write-isolation-stufe-4-v1.md`. Schließt die in Stufe 3 bewusst
offen gelassene Lücke: nachdem **Lesen** mandantengetrennt ist (Stufe 3), ist jetzt
**Schreiben** (INSERT/UPDATE/DELETE/UPSERT) und jede **schreib-auslösende Autorisierung**
mandantengetrennt — fail-closed und gegen zwei echte Test-Mandanten (`acme`/`globex`)
nicht-vakuös bewiesen.

### Was umgesetzt wurde (Code)

- **#131 Fundament** (`lib/tenant-db.js`): `write()` ist **fail-closed-werfend** (kein
  Mandant ⇒ Fehler statt stillem `{rowCount:0}`); `read()` bleibt fail-closed-**leer**.
  Neuer transaktionaler Modus **`db.tx(tenant, fn)`** (BEGIN → tür-gebundenes read+write,
  Mandant als `$1` → COMMIT/ROLLBACK; dedizierter Client aus dem Pool). Inerter
  **Stufe-5-RLS-Haken** (`SET LOCAL automatenlager.current_tenant`) als kommentierter
  Steckplatz in `db.tx`. Body-Tenant-Reject-Helper `lib/write-guards.js`
  (`tenant_id`/`mandant_id` im Body ⇒ 400 + Audit). #107-Guard um `entryFiles` erweitert
  (erfasst Schreibpfade auch außerhalb `lib/`). Schreib-Fixtures `WRITE_PATH_TABLES` +
  `sandboxTxPool` (SAVEPOINT-Mapping für `db.tx` im Sandbox-Harness).
- **#132 DDL 0020:** `locations`/`machines`/`machine_profiles` — globale `(key)`-Uniques
  gedroppt, ersetzt durch `UNIQUE NULLS NOT DISTINCT (tenant_id, key)`. Idempotent,
  Vorab-Checks. (Eigentümer-freigegebene „Variante 2".) `#111` Scope um diese 3 Tabellen
  reduziert (Kommentar gesetzt, **nicht** geschlossen).
- **#136 DDL 0021:** `machine_profiles`-tenant-treue-Trigger (aus `0017`) mandanten-
  skopiert (`AND tenant_id = NEW.tenant_id`) — `0020` machte die globale
  `machine_key`-Auflösung mehrdeutig. **Folge-Korrektur zu 0020.**
- **#133/#134 Webhook-Tore:** `refill/trigger` + `slot-assign-inline/confirm` mit
  `requireMachineAccess`; `correction-action/confirm` + `onboarding/start` mit
  Case-Mitgliedschaftsprüfung (`requireCaseAccess`, NICHT Maschine). Alle vier + Body-
  Tenant-Reject. **Bugfix:** `readJsonBody` war am slot-assign-Endpunkt nie definiert
  (Body kam immer als `{}` an) — jetzt definiert.
- **#135/#136/#137/#138 direkte Schreiber durch die Tür:** `location-profiles`
  (UPSERT/DELETE, `db.tx`-DELETE), `machine-create` (`db.tx`, Parent-`location_id` IN der
  Transaktion ⇒ fremd = 404), `machine-profiles`, `settings-thresholds` (UPSERT/DELETE,
  fail-closed-werfend, kein `__default__`-Default mehr in den Schreibfunktionen),
  `write-off` (inline-Transaktion aus `server.js` in `lib/write-off.js::writeOffBatchPg`
  ausgelagert, `SELECT … FOR UPDATE` + UPDATE atomar, tenant-skopiert).
- **#139 Abschluss:** Guard-Schreibpfad-Allowlist **leer** (`STUFE4_WRITE_ALLOWLIST = []`)
  ⇒ `lib/`-Guard build-blocking; Stufe-5-Haken dokumentiert + inert; Konsolidierungstest
  `dashboard-mt-stufe4-abschluss.test.js` (Break-Glass an allen 12 neuen Endpunkten,
  fail-closed, Guard-Endzustand); Doku `docs/security/query-filter-guard-allowlist.md`.

### Nicht-vakuöse Isolationstests (acme/globex)

Pro Domäne ein eigener `dashboard-mt-*-isolation.test.js`: gleicher Key ⇒ getrennte
Zeilen (kein Cross-Tenant-Überschreiben), fremder Parent ⇒ 404/NOT_FOUND ohne Änderung,
fail-closed ohne Mandant, Side-Effects-Isolation (settings-thresholds), Owner-Regression.
Sandbox-Tests wenden `0020`(+`0021`) vorab an (DDL vor Code).

### ⚠️ AUSSTEHEND — vor „erledigt": Mini-Deploy + Live-Smoke (#139, AC6)

Stufe 4 enthält **DDL** — diese muss VOR dem Code auf den Mini:

1. **PR mergen** (`feat/write-isolation-stufe-4`) → schließt #131–#139.
2. **Mini-Deploy (HP-Mini, nie localhost):** `git pull --ff-only`, dann **Migration `0020`
   UND `0021`** anwenden (`psql $PGURL -f dashboard/db-migrations/0020-*.sql` und
   `0021-*.sql`; beide idempotent), dann Container-Restart.
3. **Live-Smoke:** Eigentümer-Schreibungen am echten Dashboard prüfen — Standort
   anlegen/löschen, Maschine anlegen + aussondern, Schwelle setzen/zurücksetzen, Charge
   ausbuchen. Keine falschen „gespeichert", keine Fehler.

### Abgrenzung / nächste Stufen

- **Stufe 5 (RLS):** den inerten `SET LOCAL`-Haken in `db.tx` zünden — der unumgehbare
  DB-Backstop. **Kein zweiter realer Kunde vor Stufe 3+4+5.**
- **Stufe 6:** n8n-eigene Schreibpfade; per-Mandant-Config (`classification_settings`
  bleibt `mandant_id`/`__default__`; `settings_thresholds`-Endpunkt schreibt weiter unter
  `DEFAULT_MANDANT`); restliche globale `(key)`-Uniques (#111, Scope ohne
  locations/machines).
- **Stufe 8:** UI (Mandanten-Selektor, Support-Bedien-UI).

### Bekannte Test-Eigenheit

Die volle Suite (`node --test`, ~45 Dateien) zeigt sporadisch 1–3 **transiente**
Fehlschläge unter Last (viele Spawned-Server + Sandbox-Verbindungen gleichzeitig gegen EINE
Mini-DB). Gezielte Läufe einzelner Dateien sind deterministisch grün. Bei einem roten
Volllauf: die betroffenen Dateien einzeln nachfahren (kein Code-Fehler, Verbindungs-
Kontention).
