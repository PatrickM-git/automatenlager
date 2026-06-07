# SPEC — Mandantenfähigkeit STUFE 6: n8n vollständig ablösen (v1)

> Status: geplant · Vorgänger: `docs/specs/multi-tenant-rls-stufe-5-v1.md` · Kontext/Reihenfolge: `docs/ROADMAP.md` (Phase A2)
> Diese SPEC basiert auf einer Verifikation gegen die **echten WF-JSONs und den echten Dashboard-Code** (4-Agenten-Lauf über alle 17 Workflows + gezielte Code-Reads), nicht auf Doku-Annahmen.

## Problem Statement

Das Dashboard ist heute **lese- und schreibseitig durch die Mandanten-Tür + RLS abgesichert** (Stufe 3–5). Aber **n8n ist es nicht**: Alle Hintergrund-, Ingestion- und Aggregations-Prozesse laufen in **17 n8n-Workflows**, die

1. **im RLS-BYPASS schreiben.** Seit Stufe 5 hat n8ns Login-Rolle (`n8n_app`) bewusst `BYPASSRLS` — sonst hätte `FORCE ROW LEVEL SECURITY` die Produktion (WF3/WF7) gebrochen. Damit ist der RLS-Backstop **nicht systemweit dicht**: für jede Tabelle, in die n8n schreibt, ist die Mandanten-Trennung nur so gut wie n8ns eigene Logik — und die ist **mandantenblind** (siehe Punkt 2). Das ist die **größte verbleibende Sicherheitslücke** und der erklärte Grund, warum **kein zweiter echter Kunde** vor Stufe 6 onboarded wird.
2. **keinerlei Mandanten-Bewusstsein haben.** Die Verifikation aller 17 Workflows ergab: **kein einziger** Workflow trägt `tenant_id`/`mandant_id`; die Maschine `457107528` (Faltrix) ist hartkodiert. Mit einem zweiten Mandanten würde n8n dessen Daten ungetrennt mitverarbeiten.
3. **schwer testbar, intransparent und driftanfällig** sind. Die eigentliche Schreiblogik liegt zentral in einer **DB-Funktion `automatenlager.pgw_write(event_type, batch_run_id, data)`** außerhalb des Repos (WF-PGW ist nur ein „dummer" Durchreicher dorthin); WF4 baut Warnungs-INSERTs per **String-Templating** (Injection-nah). Dass Workflows von der Repo-Wahrheit abdriften, ist real genug, dass eigens **WF-Drift-Check** existiert, um genau das zu überwachen.
4. **die Cloud-Migration blockieren.** Der Nordstern (`docs/ROADMAP.md`) ist Cloudflare/Render/Supabase. Auf **Render** laufen **Cron-Jobs und Worker-Dienste**, kein n8n. Solange die Prozesse in n8n stecken, ist Phase B nicht möglich.

Kurz: n8n ist für diese Prozesse das **falsche Werkzeug** — es ist der einzige Pfad, der den RLS-Backstop noch umgeht, es ist mandantenblind, und es steht der Cloud im Weg.

## Solution

Stufe 6 **ersetzt alle n8n-Workflows durch eigenen, getesteten Backend-Code** und schaltet n8n danach komplett ab. Damit fällt n8ns BYPASS-Verbindung weg → **der RLS-Backstop wird systemweit und nachweisbar dicht** (Hauptgewinn), und die Prozesse werden **cloud-portabel** (Render-Cron/Worker statt n8n) — Voraussetzung für Phase B.

Aus Nutzersicht ändert sich am Verhalten **nichts**: Faltrix' Nachfüllung, Pickliste, Nayax-Abruf, Rechnungseingang, MHD-Mail, GuV-Aggregat und die nächtliche Pflege laufen weiter — nur eben aus dem eigenen Backend statt aus n8n.

Drei Bausteine, alle **cloud-agnostisch** (Umzug statt Rewrite):

1. **Job-Logik als getestete Module (`lib/jobs/*`).** Jeder Prozess wird ein **Deep Module** mit kleiner Schnittstelle `(db, kontext, opts) → ergebnis` — genau das Muster, das mit `lib/alert-digest.js` (der bereits portierten WF5-Leseseite, `queryAlertDigestPg(db, tenant, opts)`) **schon erprobt** ist. Jeder Job ist **einzeln aufrufbar** (`node jobs/<name>.js`, für Render-Cron) **und** in-process (vom Web-Dienst für Webhook/manuelle Trigger).
2. **Ein separater Worker-Dienst mit `node-cron`** als eigener docker-compose-Service auf dem Mini (`restart: always`, self-healing), **getrennt vom Web-Prozess**. Er ersetzt n8n als **Scheduler** (heute existiert kein In-Process-Scheduler — n8n terminiert alles) und ist 1:1 nach **Render (Background Worker / Cron Job)** portierbar.
3. **Webhook/manuelle Trigger → direkte Backend-Endpunkte.** Das Dashboard ruft heute schon n8n-Webhooks per `fetch()` auf (z. B. `…/webhook/nachfuellung` für WF7, der Nayax-Webhook in `computeNayaxAbgleichDiff` für WF3). Diese `fetch(n8n)`-Aufrufe werden durch **direkte In-Process-Modulaufrufe** ersetzt.

**Eisernes Prinzip:** **Alle** Schreib- und Lesepfade laufen durch die **Mandanten-Tür** (`lib/tenant-db.js`) — per-Mandant über die GUC (`set_config('automatenlager.current_tenant', …)`), mandantenübergreifende Pflege (MatView-`REFRESH`) über die **Infra-Rolle**. **Kein neuer BYPASS.** Damit ist jeder ex-n8n-Schreibpfad RLS-unterworfen.

Der Weg ist bewusst **gestaffelt nach Risiko**: idempotente/ableitbare Prozesse per **direktem Wechsel**; datenkritische Ingestion (Nayax-Verkäufe, Rechnungseingang) im **Schattenbetrieb** (parallel rechnen + Ergebnis gegen n8n vergleichen, erst dann umschalten); benutzerausgelöste Webhooks per **Trigger-Umlegung** (Dashboard von `fetch(n8n)` auf in-process, n8n-WF direkt danach aus).

## User Stories

1. As a Plattform-Betreiber, I want, dass **kein Prozess mehr im RLS-BYPASS** schreibt, so that der Backstop **systemweit** dicht ist und ein zweiter echter Kunde sicher onboarded werden kann.
2. As a Plattform-Betreiber, I want jeden ex-n8n-Schreibpfad **durch die Mandanten-Tür mit gesetzter GUC**, so that die Datenbank fremde Zeilen abweist, selbst wenn ein Job seinen `tenant_id`-Filter vergisst.
3. As an Entwickler, I want die Prozesslogik als **getestete Backend-Module** statt als undurchsichtige n8n-JSONs, so that ich sie versionieren, lokal ausführen, im TDD absichern und review-en kann.
4. As an Entwickler, I want jeden Job **einzeln (`node jobs/x.js`) und in-process** ausführbar, so that derselbe Code als Render-Cron, als Worker-Tick und als Webhook-Endpunkt läuft (cloud-agnostisch).
5. As an Operator, I want einen **separaten Worker-Dienst mit `restart: always`**, so that ein abgestürzter Job-Lauf den Web-Dienst nicht mitreißt und sich selbst heilt — portierbar als Render Background Worker.
6. As an Operator, I want **datenkritische Ingestion (Nayax-Verkäufe, Rechnungen) im Schattenbetrieb** parallel rechnen und gegen n8n vergleichen, so that ich erst umschalte, wenn die Ergebnisse beweisbar identisch sind.
7. As an Operator, I want **idempotente/ableitbare Prozesse direkt umschalten** und **benutzerausgelöste Webhooks per Trigger-Umlegung** wechseln, so that ich nur dort den teuren Schattenbetrieb fahre, wo das Risiko es rechtfertigt.
8. As der Betreiber (Faltrix), I want, dass Nachfüllung, Pickliste, Nayax-Abruf, Rechnungseingang, MHD-Mail und GuV **unverändert funktionieren**, so that die Ablösung für mich unsichtbar ist.
9. As an Entwickler, I want die **out-of-band-Logik `pgw_write()` und die echten n8n-Trigger/Credentials vorab verifizieren** (Pre-Flight, wie die Rollen-Hierarchie in Stufe 5), so that ich gegen den realen DB-/Laufzeit-Stand portiere und keine Doku-Annahme.
10. As an Operator, I want, dass der Worker **jeden Job-Lauf in `audit.workflow_runs` protokolliert** (Start/Ende/Status/Fehler), so that Monitoring/Konsistenz-Checks weiterlaufen, obwohl n8ns `execution_entity` wegfällt.
11. As a Sicherheits-Reviewer, I want am Ende einen **Nachweis „RLS systemweit"**: `n8n_app` verliert `BYPASSRLS`, ein Schreibversuch ohne GUC **kracht** (fail-closed), so that der Hauptsicherheitsgewinn belegt und nicht nur behauptet ist.
12. As a Reviewer, I want, dass der **#107-Wächter auch `lib/jobs/*` und den Worker-Einstieg build-blocking** scannt, so that ein Job nicht versehentlich an der Tür vorbei schreibt.
13. As an Entwickler, I want **obsolete Workflows ehrlich stilllegen statt portieren** (WF0 = Sheets-Backfill bei abgelöstem Sheets; WF-Update-Check / WF-Drift-Check = n8n-spezifisch), so that ich keine tote Logik mitschleppe.
14. As an Entwickler, I want die **n8n-Credentials (Nayax, Claude, Google Drive, E-Mail) nach `dashboard/.env.local`** überführen, so that die Jobs ohne n8n laufen — die Verschlüsselung pro Mandant (Vault) bleibt bewusst Stufe 7.
15. As an Entwickler, I want **#108** (tenantColumn-Brücke + `__default__`-Abbau) und **#111** (globale `(key)`-Uniques droppen → `ON CONFLICT (tenant_id, key)`) im Abschluss-Slice, so that das Datenmodell nach dem Wegfall des mandantenblinden n8n sauber mandantengeschlüsselt ist.
16. As a Cloud-Architekt, I want den Worker und die Jobs so gebaut, dass der Umzug nach Render ein **Konfigurations-/Deploy-Wechsel** ist (kein Rewrite), so that Phase B direkt anschließen kann.
17. As an Operator, I want **jeden Slice einzeln deploybar mit Live-Smoke** und die Test-Suite durchgehend grün, so that ein Fehler isoliert bleibt und der Rückweg (n8n-WF reaktivieren) jederzeit offen ist.

## Implementation Decisions

### Architektur der Job-Schicht
- **`lib/jobs/<name>.js` als Deep Modules.** Jeder Job kapselt seine Logik hinter einer kleinen Schnittstelle und bekommt seine DB-Zugriffe **injiziert** (`db` = die Mandanten-Tür, Kontext = Mandant oder „infra"). Reine Berechnung (z. B. FIFO, GuV-Aggregat, Digest-Aufbau) wird von I/O getrennt — wie heute `buildAlertDigest` (rein) vs. `queryAlertDigestPg` (I/O durch die Tür). **Vorbild ist bereits im Repo:** `lib/alert-digest.js`.
- **Drei Lauf-Modi pro Job, ein Code:** (a) Standalone-CLI `node jobs/<name>.js` (für Render-Cron / manuellen Lauf), (b) in-process vom Worker-Tick (node-cron), (c) in-process vom Web-Endpunkt (benutzerausgelöst). Dieselbe exportierte Funktion in allen drei.
- **Worker-Dienst (`worker.js` o. ä.) mit `node-cron`** als **separater docker-compose-Service** (gleiches App-Image, anderer Entry-Point; getrennt vom Web-Prozess; `restart: always`). Die compose-Definition liegt — wie der bestehende Deploy — **außerhalb des Repos** im Homelab des Mini (siehe Memory `mini-deploy-mechanismus`); im Repo liegen Worker-Code + Beispiel-Service-Snippet. Auf Render wird derselbe Entry-Point ein **Background Worker / Cron Job**.

### Datenzugriff — alles durch die Tür, kein neuer BYPASS
- **Per-Mandant-Jobs** iterieren die **Mandanten-Registry** (`lib/tenant-directory.js`) und laufen **je Mandant** durch die Tür mit gesetzter GUC — exakt wie `alert-digest` es heute schon tut (expliziter Mandant, **nie** ein Default). Fail-closed: kein/leerer Mandant ⇒ der Job verarbeitet für diesen Mandanten nichts.
- **Mandantenübergreifende Pflege** (MatView-`REFRESH`) läuft über die **Infra-/`BYPASSRLS`-Verbindung** (die Stufe 5 bereits für Bootstrap/Migrationen/Refresh eingeführt hat) — das ist der **einzige** legitime Nicht-Tür-Pfad und wird beim #107-Wächter mit Begründung dokumentiert (analog `db-schema.js`).
- **Schreiben transaktional über `db.tx`** (Parent-Prüfung + Write atomar; der Stufe-5-GUC-Haken greift) — keine String-SQL, keine async-nicht-blockierenden Writes mit verschluckten Fehlern (beides heute n8n-Schwächen: WF4-Templating, WF-PGW `waitForSubWorkflow:false`).

### Die WF-PGW / `pgw_write()`-Frage (zentraler Knoten)
- **Befund:** WF-PGW ist ein Durchreicher auf **`SELECT automatenlager.pgw_write($1::text,$2::text,$3::jsonb)`**. WF1, WF4, WF5, WF7, WF8, WF9 und WF-Monitor schreiben über **Events** (`event_type` u. a. `slot_assignment`, `stock_movement`, `invoice`/`invoice_item`, `guv_daily`, `warning`) dorthin. Die eigentliche Insert/Upsert/Validierungs-Logik steckt **in der DB-Funktion** (out-of-band, nicht im Repo) — analog zur Rollen-Hierarchie, die Stufe 5 erst im Pre-Flight fand.
- **Entscheidung:** Pro `event_type` ein **typisierter Backend-Schreibpfad durch die Tür** (`db.tx`), der die `pgw_write()`-Semantik **nachbildet** (gleiche Tabellen, gleiche Konflikt-/Upsert-Regeln). `pgw_write()` und WF-PGW werden **im Abschluss-Slice stillgelegt**, sobald kein Anrufer mehr existiert.
- **Pre-Flight-Pflicht:** Vor dem Portieren wird die **Definition von `pgw_write()`** aus der Mini-DB gezogen (`pg_get_functiondef` / `\sf`) und die behandelten `event_type`s + Zieltabellen + Konfliktschlüssel dokumentiert. Ohne diesen Dump kein Port (sonst Doku-Annahme statt Realität).

### Job-Lauf-Telemetrie (Ersatz für n8ns `execution_entity`)
- WF-Monitor und WF-Val lesen heute n8ns interne `execution_entity`, um fehlgeschlagene/hängende Läufe zu erkennen; alert-digest/overview-monitoring lesen bereits **`audit.workflow_runs`**. Diese Tabelle **existiert schon**, wird vom Dashboard aber nur gelesen.
- **Entscheidung:** Der Worker **schreibt `audit.workflow_runs`** (Start/Ende/Status/Fehler je Lauf, `workflow_key` = Job-Name) — als zentrale Lauf-Telemetrie. Damit funktionieren Monitoring/Konsistenz-Checks weiter, ohne n8n. `audit.workflow_runs` ist **System-Telemetrie ohne `tenant_id`** (geteilte Pipeline) und bleibt es.
- Die n8n-spezifischen Selbstheilungen werden **ersetzt, nicht portiert:** WF-Vals „WF3 per n8n-API deaktivieren/aktivieren" und WF-Monitors „n8n-Auth-/Error-Spike-Checks" entfallen — an ihre Stelle tritt `restart: always` des Workers + die `audit.workflow_runs`-Auswertung.

### Externe Integrationen (raus aus n8n-Credentials)
- **Nayax Lynx** (WF3, WF-Nayax-Devices-Sync, WF-Val): HTTP-Client im Backend, Token aus `.env.local`.
- **Claude/Anthropic** (WF1 PDF-Extraktion `claude-sonnet-4-6`, WF9 OCR + WF-Claude-Proposals `claude-haiku-4-5`): Anthropic-Client, Key aus `.env.local`.
- **Google Drive** (WF1/WF9 ziehen PDFs aus Ordnern via `googleDriveTrigger`): als **Drive-Polling-Job** portieren (erhält das gewohnte „PDF in Ordner ablegen") — ein Upload-Endpunkt statt Drive ist die cloud-agnostische Zukunft, aber **out of scope** (s. u.), um Verhalten nicht zu ändern.
- **E-Mail-Benachrichtigung** (WF5, WF-Monitor, WF-Drift-Check, WF-Val, WF-Claude-Proposals senden via Gmail): ein **Mailer-Modul** kapselt den Versand; Transport bleibt zunächst der bestehende (Gmail), Wechsel zu Postmark/Brevo ist ROADMAP A4.
- **Geheimnis-Verwaltung:** Stufe 6 legt die bewegten Secrets in `dashboard/.env.local`. **Verschlüsselung pro Mandant (Credential-Vault) = Stufe 7** — bewusst nicht hier.

### Pro-Workflow-Disposition (PORT / MERGE / DROP) — gegen die echten JSONs
**DROP (obsolet, nicht portieren — ehrlich stilllegen):**
- **WF0** (product_slot_id Backfill): schreibt **nur Google Sheets**; Sheets ist seit SQL-Cutover abgelöst → obsolet.
- **WF-Update-Check** (n8n-Image-Updates via Docker Hub): ohne n8n gegenstandslos.
- **WF-Drift-Check** (live-n8n vs. Repo-JSONs): ohne n8n nichts mehr zu vergleichen.

**MERGE (Leseseite/Trigger existiert im Dashboard schon; nur der Schreib-/Plan-Teil ist zu ergänzen):**
- **WF5** (MHD/Bestand-Mail): Leseseite **bereits portiert** (`alert-digest.js`); zu ergänzen: zeitgesteuerter Versand (Worker) + Warnungs-`resolve`/-INSERT durch die Tür.
- **WF7** (Nachfüllung): Endpunkt-Trigger existiert im Dashboard (`fetch(/webhook/nachfuellung)`); Logik in `lib/refill.js`/`bulk-refill.js` vorhanden — Schreibpfad (slot_assignments-Update, warnings-resolve/-INSERT, `stock_movement`) durch die Tür ziehen, `fetch(n8n)` durch in-process ersetzen.
- **WF4** (MDB/Slot-Zuordnung, Autorität): UI/Trigger in `slot-editor.js`/`slot-change.js`/`slot-assign-inline.js`; der **Slot-Lebenszyklus-Write** (alte Zeilen schließen / neue öffnen, `valid_from/to`, Change-Log, Warnungs-INSERT) wird vom n8n-Templating/WF-PGW in ein **transaktionales `db.tx`** überführt.
- **WF3-Reads** liegen schon mandantengetrennt in `wf3-product-reads.js`/`nayax-abgleich.js`.

**PORT (neue Jobs/Endpunkte):**
- **WF3** (Nayax FIFO Lagerbestand): Verkäufe von Nayax holen, FIFO-Abbuchung (`stock_batches`), `sales_transactions`, Watermark (`workflow_state`), Auto-Korrektur-Warnungen → **datenkritisch, Schattenbetrieb** (Slice 3). Trigger: Worker-Cron **+** manueller Dashboard-Abruf.
- **WF1/WF2** (Rechnungseingang + Smart-Selection-Freigabe): PDF→Claude→`product_change_proposals`→Freigabe→`products`/`product_aliases`/`stock_batches`/`invoice`(+items) → **datenkritisch, Schattenbetrieb** (Slice 3). WF2s Mensch-im-Loop-Freigabe wird ein Dashboard-Endpunkt.
- **WF8** (GuV-Tagesposten): Aggregat `guv_daily` aus `sales_transactions`+`stock_batches`+`classification_settings` → **idempotent/ableitbar, direkter Wechsel** (Slice 1).
- **WF-MatView-Refresh**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` auf `mv_inventory_value_daily`, `mv_db_per_product_monthly`, `mv_db_per_slot_monthly` → **Infra-Verbindung, direkter Wechsel** (Slice 1).
- **WF-Val** (DB-Konsistenz): Checks (Slots ohne Preis, negative Mengen, alte Warnungen/Proposals, Verkaufs-Lag) → **direkter Wechsel** (Slice 1); WF3-Neustart-Mechanik **entfällt** (Worker-Self-Heal).
- **WF-Monitor** (Betrieb): Container-/Heartbeat-/Backup-Checks bleiben (knüpft an ROADMAP A3); n8n-`execution_entity`-Checks entfallen → **direkter Wechsel** (Slice 1).
- **WF-Nayax-Devices-Sync**: `nayax_devices`-Upsert aus Nayax → **direkter Wechsel** (Slice 1).
- **WF9** (Pickliste): Drive→Claude-OCR→Slot-Verteilung→Warnungen→`stock_movement` → **leicht/benutzerausgelöst** (Slice 2).
- **WF-Claude-Proposals**: alte Proposals von Claude vorentscheiden → `product_change_proposals`-Update → **leicht** (Slice 2).

### #107-Wächter & Migrationen
- **Wächter erweitern:** `lib/jobs/*` und der Worker-Einstieg kommen in den **build-blocking Standard-Scan** (jeder Job muss durch die Tür); die Infra-Verbindung für Refresh ist die dokumentierte Ausnahme.
- **Migrationen `0027+`** (idempotent, etabliertes DO-Block-Muster): (a) Schreibvertrag/Indizes für `audit.workflow_runs`, falls nötig; (b) **#111** globale `(key)`-Uniques droppen → `UNIQUE (tenant_id, key)` + Code auf `ON CONFLICT (tenant_id, key)`; (c) **#108** `mandant_id`→`tenant_id`-Angleichung (`classification_settings`) + `__default__`-Abbau, wo nach dem n8n-Wegfall möglich. Diese DDL erst im **Abschluss-Slice**, wenn alle Schreiber durch die Tür gehen.
- **Encoding UTF-8** beim Extrahieren der Logik aus den WF-JSONs (Umlaut-/`U+FFFD`-Falle, CLAUDE.md) — niemals Latin-1-Round-Trip.

### Rollout (Slices, je einzeln deploybar + Live-Smoke)
- **Slice 0 — Fundament (kein Verhaltenswechsel):** Worker-Dienst + node-cron + compose-Service-Snippet; `audit.workflow_runs`-Schreiber; generischer **Per-Mandant-Job-Runner** (Registry→Tür) + **Infra-Runner**; **Schatten-/Vergleichs-Harness**; #107-Wächter auf `lib/jobs/*`+Worker; **Pre-Flight:** `pgw_write()`-Dump + reale n8n-Trigger/Credentials verifizieren. n8n bleibt autoritativ.
- **Slice 1 — idempotent/ableitbar (direkter Wechsel):** WF-MatView-Refresh, WF8 GuV, WF-Val, WF-Monitor, WF-Nayax-Devices-Sync portieren → je Smoke → entsprechende n8n-WF deaktivieren.
- **Slice 2 — leicht/benutzerausgelöst (Trigger-Umlegung):** WF7 (`/nachfuellung`→in-process), WF9 (Pickliste), WF-Claude-Proposals, WF5-Versand-Abschluss; **DROP** WF0/WF-Update-Check/WF-Drift-Check dokumentiert.
- **Slice 3 — datenkritisch im Schatten:** WF3 (Nayax-Verkäufe) parallel rechnen + vergleichen → Cutover; danach WF1/WF2 (Rechnungseingang) analog; WF4-Slot-Write transaktional umstellen (direkter Wechsel mit starken Tests, Rückweg = Trigger zurück auf n8n).
- **Slice 4 — Abschluss + Sicherheitsnachweis:** WF-PGW + `pgw_write()` stilllegen; **`n8n_app` verliert `BYPASSRLS`**; n8n komplett aus; **#108** + **#111**; Negativ-Test „Schreiben ohne GUC kracht" als Beleg **„RLS systemweit / kein BYPASS"**.
- **Rückweg je Slice:** n8n-WF reaktivieren (Slice 1/2) bzw. Dashboard-Trigger auf n8n zurücklegen (Slice 2/3); `BYPASSRLS` erst in Slice 4 entziehen, also bis dahin jederzeit zurück.

## Testing Decisions

- **Was ein guter Test hier ist:** Er prüft **externes Verhalten** — (a) erzeugt der portierte Job **denselben DB-Effekt** wie n8n (Schatten-Vergleich) und (b) respektiert er **Mandanten-Isolation** (acme/globex, nicht-vakuös: beide tragen Daten, A sieht/schreibt B nie). Nicht die interne Mechanik.
- **Schatten-/Vergleichs-Harness (Slice 0, Kern für Slice 3):** Der neue Job läuft im **Compute-+-Compare-Modus** (rechnet die beabsichtigten Writes, schreibt **nicht**) parallel zu n8n; ein Diff vergleicht beabsichtigte vs. tatsächliche n8n-Writes. Erst bei Deckungsgleichheit Cutover. **Kein Doppel-Schreiben** im Schatten.
- **Pro Job:** reine Logik unit-getestet (wie `buildAlertDigest`) + **Live durch die Tür** gegen die echte DB im **#94-Sandbox-Harness** (ROLLBACK) als **`automatenlager_app`** (RLS aktiv, kein Mock) + nicht-vakuöser acme/globex-Isolationstest.
- **Sicherheits-Nachweis (Slice 4):** nachdem `n8n_app` `BYPASSRLS` verliert, beweist ein Negativ-Test, dass ein Schreibversuch **ohne** gesetzte GUC **fehlschlägt** (fail-closed) — die zentrale Behauptung „Backstop systemweit".
- **Worker-Smoke:** node-cron feuert, der Lauf landet in `audit.workflow_runs`, `restart: always` heilt einen abgestürzten Tick.
- **Module im Fokus:** `lib/jobs/*` (alle portierten Jobs), `worker.js`, der Per-Mandant-/Infra-Runner, der Schatten-Harness, `lib/query-filter-guard.js` (jobs build-blocking), die `0027+`-Migrationen (#108/#111, idempotent).
- **Vorhandene Vorbilder:** `lib/alert-digest.js` + dessen Tests (per-Mandant-Job durch die Tür), die Stufe-3/4/5-Isolationstests (`doorForClient`, Advisory-Lock gegen DDL-vs-DML-Deadlock), `dashboard-mt-rls-isolation.test.js` (real als App-Rolle), `migration-sandbox.js`.
- **Suite bleibt grün** über alle Slices (heute 1089/1089).

## Out of Scope

- **Der eigentliche Cloud-Umzug** (DB→Supabase, Backend/Worker→Render, Frontend→Cloudflare) = **Phase B**. Stufe 6 baut nur die **portable Form**; sie zieht nicht um.
- **UI** für Mandanten-Selbstverwaltung = **Stufe 8**; Onboarding-Wizard = ROADMAP **A4**.
- **Credential-Vault** (Secrets pro Mandant verschlüsselt) = **Stufe 7**. Stufe 6 nutzt `dashboard/.env.local` für die bewegten Secrets.
- **Google Drive durch einen Upload-Endpunkt/-UI ersetzen** (cloud-agnostischer als Drive-Polling) = Zukunft (A4/Phase C). Stufe 6 portiert das Drive-Polling, um Verhalten nicht zu ändern.
- **Billing/Marketing** = Phase C.
- **per-Mandant-Config über #108 hinaus** (vollständige Konfigurierbarkeit je Mandant) = späterer Ausbau.
- **Betriebsreife-Ausbau** (Sentry, Statusseite, Off-Site-Backup-Alarm) = ROADMAP **A3** — Stufe 6 liefert nur die Lauf-Telemetrie (`audit.workflow_runs`) als Fundament.
- **Kein zweiter echter Kunde** vor Abschluss von Stufe 6 **und** Cloud (Phase B).

## Further Notes

- **`pgw_write()` ist out-of-band** (DB-Funktion, nicht im Repo) — Stufe 5 hat gelehrt, den realen DB-/Laufzeit-Stand vor dem Bauen zu verifizieren statt der Doku zu glauben (damals: die Rollen-Hierarchie). Der Pre-Flight-Dump ist deshalb **Pflicht**, nicht optional.
- **Nicht alle 17 sind 1:1-Ports.** Die echte JSON-Analyse zeigt: 3 sind obsolet (DROP), mehrere haben ihre Leseseite/Trigger schon im Dashboard (MERGE). Das verkleinert den Port und verhindert das Mitschleppen toter Logik.
- **Alle Google-Sheets-Schreibknoten in n8n sind bereits deaktiviert** (SQL-Cutover) — Portierungsziel sind **ausschließlich** die Postgres-/WF-PGW-Schreibpfade.
- **Größtes Restrisiko bis Slice 4:** Solange n8n_app `BYPASSRLS` hat, ist der Backstop nicht systemweit. Deshalb ist die `BYPASSRLS`-Entziehung der **letzte** Schritt — vorher ist der Rückweg jederzeit offen, nachher ist der Gewinn bewiesen.
- **Leitprinzip (durchgängig seit Stufe 4):** Autorisierung (Render-/App-Schicht) und Datenzugriff (Supabase + RLS) bleiben zwei getrennte, cloud-agnostische Schichten. Stufe 6 baut nur Arbeit, die in jeder Zukunft gebraucht wird — und macht den RLS-Backstop endlich lückenlos.
