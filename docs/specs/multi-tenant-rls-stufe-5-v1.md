# SPEC — Mandantenfähigkeit STUFE 5: Row-Level-Security als unumgehbarer Backstop (v1)

> Status: geplant · Vorgänger: `docs/specs/multi-tenant-write-isolation-stufe-4-v1.md` · Vorbedingung: Hotfix [#141](https://github.com/PatrickM-git/automatenlager/issues/141)
> Diese SPEC basiert auf einer Verifikation der 9 Kern-Annahmen gegen den **echten Code** (7-Agenten-Lauf, `file:line`-Belege), nicht auf Doku-Annahmen.

## Problem Statement

Die Mandanten-Trennung im Dashboard steht heute auf **zwei fehlbaren Beinen**: dem `tenant_id`-Filter, den jede Abfrage selbst trägt (Stufe 3), und dem #107-Wächter, der vergessene Filter strukturell fangen soll. Beide sind App-Logik — und App-Logik hat Lücken: Die Stufe-5-Planung hat **zwei produktive Lese-Pfade** (`/api/v2/products/catalog`, `/api/v2/inventory/batch-search`) gefunden, die Mandantendaten **an der Tür vorbei, ohne `tenant_id`-Filter** lesen und vom Wächter nicht erfasst wurden (→ Hotfix [#141](https://github.com/PatrickM-git/automatenlager/issues/141)). Solange nur Faltrix Daten besitzt, leckt nichts; in dem Moment, in dem ein zweiter Mandant Daten hat, **leckt jeder übersehene Filter sofort fremde Daten** (Datenleck-Klasse: Cross-Tenant-Read).

Für „null Toleranz" reicht App-Logik nicht. Es fehlt die **eine Garantie unterhalb der Anwendung**, die greift, *selbst wenn* App-Filter und Wächter beide versagen: eine Datenbank-erzwungene Mandanten-Trennung, die fremde Zeilen abweist, bevor sie die Anwendung je erreichen.

## Solution

Stufe 5 aktiviert **PostgreSQL Row-Level-Security (RLS)** als unumgehbaren Backstop — vollständig und **nachweisbar**, für **Lesen UND Schreiben**.

Aus Nutzersicht ändert sich **nichts** am sichtbaren Verhalten: Faltrix sieht weiter exakt seine Daten. Was sich ändert, ist die Garantie *dahinter*: Die App verbindet künftig mit einer **eingeengten Datenbank-Rolle**, die per RLS-Policy nur Zeilen ihres aktiven Mandanten sehen und schreiben darf. Der aktive Mandant wird **transaktionslokal** über eine Sitzungsvariable (`automatenlager.current_tenant`) gesetzt — an genau einem Ort, der Mandanten-Tür (`lib/tenant-db.js`). Vergisst eine Abfrage ihren `tenant_id`-Filter, **schneidet die Datenbank fremde Zeilen trotzdem ab**. Fehlt der Mandant ganz, **kracht es laut** (harter Fehler), statt still leer zu liefern — damit ein Tür-Bypass auffällt und behebbar ist.

Der Weg dahin ist bewusst **kontrolliert statt Big Bang**: erst Code, der die Sitzungsvariable setzt (inert, solange keine Policy existiert), dann der Rollenwechsel, dann die Policies **gestaffelt pro Tabellengruppe** mit Smoke-Test nach jeder Gruppe — mit `DISABLE RLS` als diszipliniertem Notausstieg.

## User Stories

1. As a Betreiber (Faltrix), I want meine Dashboard-Daten genauso zu sehen wie bisher, so that die RLS-Scharfschaltung für mich unsichtbar ist und nichts an meinem Arbeitsablauf bricht.
2. As a Plattform-Betreiber, I want eine Datenbank-erzwungene Mandanten-Trennung, so that selbst ein vergessener `tenant_id`-Filter oder ein übersehener #107-Wächter kein fremdes Datum durchlässt.
3. As an Entwickler, I want die App mit einer **nicht-besitzenden, RLS-unterworfenen** Rolle verbinden, so that ein Programmierfehler nicht versehentlich mit Eigentümer-Rechten alle Mandanten sieht.
4. As an Entwickler, I want den aktiven Mandanten **transaktionslokal und parametrisiert** setzen (`set_config(..., $1, true)`), so that kein Mandanten-Wert an einer gepoolten Verbindung kleben bleibt (Leak) und keine String-Interpolation einen Injection-Korridor öffnet.
5. As an Entwickler, I want, dass RLS **Lesen genauso wie Schreiben** abdeckt, so that der gefährlichste Fall (Cross-Tenant-Read) nicht ungeschützt bleibt.
6. As an Entwickler, I want, dass ein **fehlender Mandant auf DB-Ebene laut kracht** statt still leer zu liefern, so that ich einen Tür-Bypass bemerke und beheben kann.
7. As a Support-Mitarbeiter, I want im Break-Glass-Fall (`X-Support-Tenant`) genau **einen** Ziel-Mandanten read-only sehen, so that ich helfen kann, ohne mandantenübergreifenden Zugriff zu erhalten.
8. As an Infrastruktur-Betreiber, I want, dass Migrationen, MatView-`REFRESH` und der Verzeichnis-Bootstrap über eine **separate, RLS-umgehende Infra-Verbindung** laufen, so that der Henne-Ei-Bootstrap (Login→Mandant) nicht am eigenen RLS erstickt.
9. As a Konsument der geteilten Config, I want weiterhin meine effektive Konfiguration aus „Defaults (`__default__`) + Mandanten-Override" lesen, so that RLS die geteilte Vorlagenzeile nicht unsichtbar macht und meine Schwellwerte/Klassifikation intakt bleiben.
10. As a Reviewer, I want, dass der #107-Wächter künftig **auch `server.js` build-blocking** scannt, so that ein direkter Read außerhalb der Tür im HTTP-Layer nicht wieder unbemerkt durchrutscht.
11. As an Operator, I want die RLS-Scharfschaltung **gestaffelt pro Tabellengruppe mit Smoke-Test**, so that eine einzelne falsche Policy nicht das gesamte Dashboard gleichzeitig lahmlegt.
12. As an Operator, I want einen **disziplinierten Rollback** (`DISABLE RLS`, nur Infra-Rolle, auditiert, temporär, erzeugt Remediation-Aufgabe), so that der Notausstieg nicht klammheimlich zum dauerhaften Bypass wird.
13. As a Qualitätssicherer, I want RLS **live als die eingeengte App-Rolle** gegen eine echte Postgres-DB testen (kein Mock), so that die Garantie tatsächlich bewiesen ist und nicht nur behauptet.
14. As a Plattform-Betreiber, I want klar dokumentiert, dass n8n bewusst **außerhalb** des Backstops bleibt (Bypass-Rolle, bis Stufe 6), so that die FORCE-RLS-Schaltung die laufende Produktion (WF3/WF7) nicht bricht und niemand den Backstop fälschlich als „systemweit dicht" verkauft.

## Implementation Decisions

### Rollen & Verbindungen
- **Zwei Datenbank-Rollen.** Eine neue, nicht-besitzende, **RLS-unterworfene** App-Rolle (`automatenlager_app`, **kein** `BYPASSRLS`) für allen Dashboard-/App-Verkehr; die bestehende **Infra-/Owner-Rolle erhält `BYPASSRLS`** und bedient ausschließlich Bootstrap (Verzeichnis-Lookup), Migrationen und MatView-`REFRESH`. Es gibt heute **keine** Rollen-/`GRANT`-DDL im Repo — die Rollen werden in Stufe 5 von Grund auf angelegt; Namenskonvention wird in `docs/UBIQUITOUS_LANGUAGE.md` dokumentiert.
- **`FORCE ROW LEVEL SECURITY`** auf allen App-Tabellen (Gürtel + Hosenträger: selbst wenn die App je als Eigentümer verbände, bliebe sie eingeengt). Die Infra-Rolle umgeht RLS über `BYPASSRLS` (schlägt `FORCE` für die Maintenance-Pfade).
- **Zwei Verbindungen statt einer (erzwungen).** Heute teilen sich `tenantDirectory` und `tenantDb` denselben `sharedPgPool` (`server.js:377-399`). Da das Verzeichnis `tenant_users`/`platform_admins` liest, **bevor** ein Mandant feststeht (kein GUC setzbar), würde der Bootstrap unter RLS am einarmigen `current_setting` krachen. Deshalb: ein **App-Rollen-Pool** (nur Mandantendaten, durch die Tür) **und** eine **separate Infra-Verbindung** (`BYPASSRLS`) für Bootstrap/Migrationen/Refresh.
- **Support/Break-Glass** (`X-Support-Tenant`) braucht **keine** eigene Rolle: Er läuft über die App-Rolle mit GUC auf den Ziel-Mandanten und zusätzlich `BEGIN READ ONLY` auf DB-Ebene (read-only auch erzwungen, nicht nur per Capability). Kein mandantenübergreifendes Plattform-Cockpit in Stufe 5.

### Die Mandanten-Tür (`lib/tenant-db.js`)
- **RLS deckt Lesen UND Schreiben ab.** Der `read()`-Pfad (heute nacktes `runQuery`/`pool.query`, `tenant-db.js:97`) wird **transaktional**: pro Read ein dedizierter Client, `BEGIN READ ONLY` → `set_config('automatenlager.current_tenant', $1, true)` → Abfrage → `COMMIT`. Mechanisch ist `read()` damit ein read-only-Spezialfall von `tx()` (`tx()` trägt den heute inerten Haken, `tenant-db.js:147-153`).
- **GUC kanonisch & sicher:** `SELECT set_config('automatenlager.current_tenant', $1, true)` — **niemals** string-interpoliertes `SET` (`SET` nimmt keinen Bind-Parameter → Injection-Korridor). Der dritte Parameter `true` = transaktionslokal. Namensraum **`automatenlager.current_tenant`** (konsistent zu Seed-Migration 0018; **nicht** `app.*`).
- **Kein `SET` ohne `LOCAL` / set_config-`true`.** Ein session-weites `SET` bliebe an der gepoolten Verbindung kleben und würde den nächsten Request mit fremdem Mandanten weiterlesen lassen — verboten.
- **Pool ist für RLS-Reads Pflicht.** `read()` transaktional braucht `pool.connect()`. Die Tür kann heute mit nur `query` (ohne Pool) gebaut werden; künftiger Vertrag: ein RLS-Read **ohne** verfügbaren Pool ist ein **Fehler** (kein stiller nicht-transaktionaler Fallback). In Produktion erhält die Tür Pool **und** Query (`server.js:398-399`).
- **Aufrufstellen ändern sich nicht.** Die ~59 `.read(`-Aufrufer laufen über die fünf Wrapper (`read`/`forTenant`/`forViewer`/`asDoor`/tx-gebundenes `read`), die alle auf `read()` delegieren — nur das **Tür-Innere** ändert sich.
- **Fail-closed-Asymmetrie bleibt:** tenant-loser Read → leeres Resultat **ohne** geöffnete Transaktion (kein GUC, kein BEGIN); `write()`/`tx()` werfen ohne Mandant. Auf DB-Ebene gilt zusätzlich: einarmiges `current_setting('automatenlager.current_tenant')` ohne gesetzten GUC → **harter Fehler** (kein stilles Leer, kein Fallback).

### Policies (Migration `0022+`)
- **Ziel: 20 operative Tabellen** mit `tenant_id TEXT` (aus Migration 0009, plus `settings_thresholds`/`warehouses`). Gruppen für den gestaffelten Rollout:
  - **Kern:** `machines`, `locations`, `machine_profiles`, `slot_assignments`, `products`, `stock_batches`
  - **Finanz/GuV:** `invoices`, `invoice_items`, `guv_daily`, `warnings`
  - **Inventory/Stock:** `stock_movements`, `sales_transactions`, `suppliers`, `nayax_devices`
  - **Config/Rest:** `settings_thresholds`, `warehouses`, `prices`, `product_aliases`, `product_change_proposals`, `workflow_state`
- **Policy-Form:** `USING (tenant_id = current_setting('automatenlager.current_tenant'))` für Sichtbarkeit + **`WITH CHECK (...)` auf jeder Schreib-Policy** (kein Insert/Update in fremde Mandanten). `tenant_id` ist überall **TEXT** → `text = text`, **kein Cast**.
- **Registry-Tabellen ohne RLS:** `tenants`, `tenant_users`, `platform_admins` (letztere bewusst ohne `tenant_id`) bleiben Infra-Territorium; die App-Rolle erhält **keinen Direktzugriff**.
- **Geteilte Config — Vereinigungs-Policy:** `classification_settings` (Spalte heißt **`mandant_id`**, nicht `tenant_id`) und `settings_thresholds` (`tenant_id`) tragen eine geteilte `__default__`-Vorlagenzeile. Policy: **lesen** erlaubt `<spalte> = current_tenant` **ODER** `<spalte> = '__default__'`; **schreiben** strikt nur `current_tenant` (`WITH CHECK`). `__default__` ist nur über Infra/Migration pflegbar. Weil das einarmige `current_setting` bei fehlendem GUC vorher wirft, ist `__default__` **nie** ein Auffangnetz für einen fehlenden Mandanten — nur Beigabe zu einem gültig gesetzten.

### Views & Materialized Views
- Tatsächlicher Stand (verifiziert): **3 MatViews** (`mv_inventory_value_daily`, `mv_db_per_product_monthly`, `mv_db_per_slot_monthly`) + **2 normale Views** (`v_warnings_open`, `v_slot_turnover`), alle `tenant_id`-führend.
- **`mv_inventory_value_daily`** (einziger im Code gelesener MatView — `economics.js`, `assortment-slots.js`): bekommt eine vorgelagerte **`security_barrier`-View** mit GUC-Filter (`WHERE tenant_id = current_setting('automatenlager.current_tenant')`); die App-Rolle verliert Direktzugriff auf die rohe MatView und liest **nur** die Security-View. (MatViews können selbst keine RLS-Policy tragen.)
- **`mv_db_per_product_monthly` + `mv_db_per_slot_monthly`** (aktuell **null** Code-Leser, nur n8n-Refresh): App-Rollen-Direktzugriff **entziehen** + Guard-Regel; eine Security-View wird erst gebaut, wenn ein echter Konsument entsteht (dann analog zu `mv_inventory_value_daily`).
- **`v_warnings_open` + `v_slot_turnover`** (normale, gelesene Views): mit **`security_invoker = true`** (PG ≥ 15) definieren, damit die Basistabellen-RLS unter der App-Rolle greift (statt unter dem View-Eigentümer).
- **`REFRESH`** läuft weiter über die Infra-Rolle, mandantenübergreifend (gewollt — nur der **Leseweg** muss eingeengt sein).

### #107-Wächter (`lib/query-filter-guard.js`)
- Der Wächter bleibt strukturell (kein SQL-Parser), `DOOR_FILES = ['tenant-db.js']`. **Erweiterung:** `server.js` wird in den **Standard-Scan (build-blocking)** aufgenommen — der gefundene Bypass (#141) blieb unentdeckt, weil `server.js` nur über optionale `entryFiles` in Einzeltests geprüft wurde.
- Die **neue Infra-Verbindung** wird mit Begründung als zulässiger Nicht-Tür-Pfad dokumentiert (analog zu den bestehenden Infra-Ausnahmen `db-schema.js`, `stock-cost-invariant.js`). Der RLS-Haken selbst sitzt **innerhalb** der Tür (`tx`/`read`) und braucht **keinen** neuen Allowlist-Eintrag.

### Migrationen
- **Nächste Nummer 0022+.** Idempotenz nach etabliertem Muster (DO-Blöcke; `IF NOT EXISTS (SELECT 1 FROM pg_roles …)` vor `CREATE ROLE`; `DROP POLICY IF EXISTS` vor `CREATE POLICY`; `pg_policies`-Existenzprüfung). Anwendung manuell via `psql` + programmatischer Sandbox-Runner (`tests/helpers/migration-sandbox.js`) für Tests.
- **PostgreSQL ≥ 15 Pflicht** (bereits durch `NULLS NOT DISTINCT` in 0002/0019/0020 erzwungen; `security_invoker` braucht ebenfalls ≥ 15). Deploy-Checkliste hält die Mindestversion explizit fest.

### Least-Privilege & Härtung
- **Explizite `REVOKE`, nicht nur `GRANT`.** Privilegien werden von Grund auf entzogen und gezielt erteilt: `REVOKE ALL ON ... FROM PUBLIC` (und ggf. von der App-Rolle), dann **gezielte** `GRANT SELECT/INSERT/UPDATE/DELETE` auf die 20 operativen Tabellen für `automatenlager_app`. Insbesondere: **kein** App-Rollen-Zugriff auf rohe MatViews (`mv_*`) und Registry-Tabellen (`tenants`/`tenant_users`/`platform_admins`) — dort wird `REVOKE` explizit gesetzt, App-Rolle liest MatView-Daten nur über die `security_barrier`-View.
- **`automatenlager_app` besitzt keine operativen Tabellen.** Eigentum bleibt bei der Infra-/Owner-Rolle. Begründung: Der Tabelleneigentümer kann RLS umgehen bzw. `ALTER TABLE … DISABLE/NO FORCE ROW LEVEL SECURITY`/`DROP POLICY` ausführen — die App-Rolle darf RLS weder umgehen noch abschalten können. (`FORCE RLS` schützt zusätzlich gegen versehentliche Eigentümer-Verbindung; das Nicht-Eigentum ist die primäre Absicherung.)
- **`search_path` härten.** `security_barrier`-Views, Funktionen und die RLS-DDL referenzieren Objekte **voll qualifiziert** (`automatenlager.<obj>`); Funktionen/Views erhalten einen festen `search_path` (z. B. `SET search_path = automatenlager, pg_temp`) statt eines veränderlichen. Verhindert das Objekt-Hijacking via manipuliertem `search_path` (CVE-2018-1058-Klasse: eine unqualifizierte Referenz, die auf ein vom Angreifer angelegtes Objekt in einem beschreibbaren Schema auflöst).
- **`tenant_id`-Indizes auf stark genutzten Tabellen prüfen.** Jede RLS-Policy fügt jeder Abfrage ein `tenant_id = …`-Prädikat hinzu. Vor der Scharfschaltung wird verifiziert, dass die heiß gelesenen Tabellen (`products`, `stock_batches`, `sales_transactions`, `slot_assignments`, `stock_movements`) einen vom Planer nutzbaren, `tenant_id`-führenden Index haben (Migration 0009 legte „Index je operativer Tabelle" an — der konkrete Nutzen unter dem RLS-Prädikat wird gegen `EXPLAIN` gegengeprüft, statt blind angenommen), damit RLS keine Seq-Scan-Regression auslöst.

### Rollout (invertiert zu Stufe 4: Code VOR Scharfschaltung)
- **Slice 0 — Vorbedingung:** Hotfix [#141](https://github.com/PatrickM-git/automatenlager/issues/141) gemergt + auf dem Mini deployt (zwei Read-Bypässe durch die Tür, Guard build-blocking auf `server.js`). **Plus Pre-Flight:** echte n8n-DB-Rolle verifizieren → auf die Infra-/`BYPASSRLS`-Verbindung legen (sonst krachen WF3/WF7-Writes bei `FORCE RLS` am fehlenden GUC).
- **Slice 1 — GUC-Code live (inert):** Tür setzt `set_config` auf jedem read+write-Pfad; harmlos, solange keine Policy existiert. Bootstrap/Migrationen/Refresh auf die separate Infra-Verbindung umstellen. **Harte Vorbedingung:** GUC-Code muss für **alle** Gruppen live sein, bevor die erste Gruppe scharf geht.
- **Slice 2 — Rollenwechsel + Smoke:** App verbindet als `automatenlager_app` (noch ohne Policies → muss normal laufen); `GRANT`s verifizieren.
- **Slice 3 — gestaffelte Scharfschaltung:** Policies/Security-Views idempotent vorbereiten → **je Tabellengruppe** `ENABLE` + `FORCE` + **Gruppen-Smoke** → nächste Gruppe. Reihenfolge: 1. Kern, 2. Finanz/GuV, 3. Inventory/Stock, 4. Config, 5. MatView-Security-Views. Endzustand „alles scharf", Weg kontrolliert.
- **Rollback:** `DISABLE ROW LEVEL SECURITY` als Ein-Befehl-Notausstieg — **nur Infra-Rolle**, auditiert/dokumentiert, **temporär**, erzeugt eine **nachverfolgte Remediation-Aufgabe**, und **kein zweiter Mandant** wird onboarded, solange ein Rollback aktiv ist.

## Testing Decisions

- **Was ein guter Test hier ist:** Er prüft **externes Verhalten** (sieht/schreibt Mandant A fremde Daten oder nicht), nicht die Implementierung. RLS lässt sich **nicht mocken** — Tests, die als Eigentümer/Infra verbinden, beweisen **nichts** (sie umgehen RLS). Die Tests verbinden daher **real als `automatenlager_app`** gegen eine echte Postgres-DB.
- **Harness:** der bestehende #94-Sandbox-Harness (live gegen die Mini-DB, **ROLLBACK** am Ende), erweitert um eine zweite Verbindung **als App-Rolle** und das Setzen/Löschen des GUC.
- **Negativ-Matrix (Kern der Beweisführung):**
  1. **kein GUC** → harter Fehler (nicht leeres Resultat),
  2. GUC = Mandant A liest B-Daten → **leer**,
  3. Schreibversuch mit fremder `tenant_id` → **`WITH CHECK`-Abweisung**,
  4. **roher MatView-Zugriff** als App-Rolle → `permission denied`,
  5. **Security-View ohne** App-`WHERE` → nur eigener Mandant (beweist den DB-Backstop unabhängig vom App-Filter),
  6. **Config:** eigener + `__default__` sichtbar, fremder nie; fehlender GUC auf Config → Fehler (kein `__default__`-Fallback).
- **Pro-Gruppe-Smoke (Slice 3):** nicht nur „Dashboard lädt", sondern die Negativ-Matrix **für die gerade scharfgeschaltete Gruppe** (positiver Read eigener Mandant + Cross-Tenant leer + fehlender GUC kracht).
- **acme/globex-Isolationstests:** je Domäne ein **nicht-vakuöser** Isolationstest (beide Mandanten tragen Daten; A darf B nie sehen) — Muster wie die bestehenden Stufe-3-Isolationstests. Gilt auch für die zwei #141-Endpunkte.
- **Module im Fokus:** `lib/tenant-db.js` (transaktionaler Read, GUC), die neue Migration `0022+` (Policies/Rollen/Security-Views, idempotent + pro Gruppe re-runnable), `lib/query-filter-guard.js` (server.js build-blocking), Bootstrap-Split in `server.js`/`lib/tenant-directory.js`.
- **Vorhandene Vorbilder:** die Stufe-3/4-Isolationstests (acme/globex, `doorForClient`, Advisory-Lock gegen DDL-vs-DML-Deadlock), `dashboard-query-filter-guard.test.js`, `dashboard-write-isolation-fundament.test.js`, `migration-sandbox.js`.
- **Observability:** RLS-Kontextfehler (fehlender GUC etc.) werden **distinkt** geloggt/auditiert, damit ein Bypass-Pfad auffindbar ist.

## Out of Scope

- **n8n-Eigenabsicherung** (tenant-aware machen ODER schrittweise durch Backend-Code ablösen) → **Stufe 6**. In Stufe 5 läuft n8n bewusst auf der **Infra-/Bypass-Verbindung**, **außerhalb** des Backstops, damit `FORCE RLS` die Produktion nicht bricht.
- **per-Mandant-Config / `__default__`-Abbau / `mandant_id`→`tenant_id`-Angleichung** (#108) → Stufe 6.
- **Globale `(key)`-Uniques droppen + `ON CONFLICT (tenant_id, key)`** (#111) → Stufe 6.
- **UI** (Mandanten-Verwaltung, Onboarding-Oberfläche) → Stufe 8.
- **IR-Runbook / Incident Response** (#109) → separat.
- **Cloud-Migration** (Cloudflare/Render/Supabase) → getrennte Architekturentscheidung, **keine** Voraussetzung für Stufe 6.
- **Vorbedingung, nicht Teil dieser SPEC:** Hotfix [#141](https://github.com/PatrickM-git/automatenlager/issues/141) (zwei Read-Bypässe schließen + Guard auf `server.js`). Stufe 5 startet erst, wenn #141 gemergt + deployt ist.

## Further Notes

- **Cutover-Ordnung ist invertiert zu Stufe 4:** Dort lief DDL additiv **vor** Code (ungefährlich). Hier ist `ENABLE`/`FORCE` ein **Verhaltens-Schalter** — fehlt der GUC-setzende Code, sieht die App **nichts** und Writes scheitern. Daher: Code zuerst (inert), Scharfschaltung zuletzt, gestaffelt, mit Rollback-Hebel.
- **Scharfe Konsequenz — kein zweiter echter Kunde vor Stufe 6.** Erst wenn n8n nicht mehr im Bypass schreibt, ist der Backstop **systemweit** dicht. Mit nur einem realen Mandanten (Faltrix) ist der Bypass-Korridor (n8n + MatView-`REFRESH` mandantenübergreifend) bewusst akzeptiertes Restrisiko.
- **Restrisiko ehrlich benannt:** Solange n8n auf der Bypass-Rolle schreibt, ist der Backstop für die von n8n geschriebenen Tabellen nur so gut wie n8ns eigene Mandanten-Logik; der MatView-`REFRESH` materialisiert mandantenübergreifend. Beides mit einem Kunden unkritisch und nach Stufe 6 bzw. „kein zweiter Kunde vorher" eingezäunt.
- **Leitprinzip (durchgängig seit Stufe 4):** Autorisierung (Render-/App-Schicht) und Datenzugriff (Supabase + RLS) sind zwei getrennte, cloud-agnostische Schichten. Stufe 5 baut nur Arbeit, die in jeder Zukunft (Cloudflare/Render/Supabase) gebraucht wird.
