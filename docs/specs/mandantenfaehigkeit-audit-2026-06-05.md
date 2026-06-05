# Mandantenfähigkeits-Audit (Multi-Tenant vor Supabase-Verkauf)

> Erstellt 2026-06-05 per Multi-Agenten-Audit (5 Schicht-Agenten + Synthese, ~476k Token).
> Landkarte für die Multi-Tenant-Migration. Siehe Memory [[mandantenfaehigkeit-audit-geplant]].

## Gesamt-Urteil

NICHT VERKAUFSFAEHIG (multi-tenant-readiness: ~15%). Das System ist faktisch Single-Tenant mit hartem Anker TENANT_OWNER='eigentuemer'. Es existiert eine gut vorgedachte Autorisierungs-Architektur (RBAC + IDOR-Hooks objectAccessAllowed/requireObjectAccess in auth.js/server.js), aber sie laeuft im Leerlauf: tenantId ist in resolveViewer (auth.js:140) hartcodiert, machineTenant() (server.js:243-245) ist ein Stub der immer TENANT_OWNER zurueckgibt, und 18 von 20 operativen Tabellen haben keine tenant_id-Spalte. Folge: JEDE Wirtschafts-, Verkaufs- und Bestands-Query liest ungefiltert ueber alle Zeilen. Bei einem zweiten Mandanten waeren GuV, Umsatz, Preise, Lager und Rechnungen aller Kunden gegenseitig sichtbar und teils schreibbar. Ein Supabase-Verkauf in diesem Zustand bedeutet ein garantiertes, mehrschichtiges Datenleck. Positiv: classification_settings und settings_thresholds zeigen das korrekte Muster, und die IDOR-Hooks sind als no-op bereits an einigen Endpunkten verdrahtet. Das ist Fundament, kein Fertigzustand. Realistischer Aufwand bis verkaufsfaehig: vollstaendige Schema-Migration + RLS + Query-Filter-Durchstich + JWT-Tenant-Aufloesung + n8n-Abl-/Parametrisierung, nicht in Tagen sondern Wochen.

## Kritische Lücken (Show-Stopper)

- **[API & Auth] tenantId hartcodiert auf TENANT_OWNER in resolveViewer (auth.js:140) und machineTenant() ist ein Stub (server.js:243-245, gibt immer TENANT_OWNER zurueck)**
  - Das ist der Wurzel-Show-Stopper. Die gesamte Autorisierungs-Architektur (RBAC, IDOR objectAccessAllowed/requireObjectAccess) funktioniert technisch, ist aber wirkungslos: jeder Viewer traegt denselben Mandanten, jedes Objekt 'gehoert' demselben Mandanten. Solange diese zwei Punkte konstant sind, hat keine andere Massnahme (RLS, Query-Filter) eine reale Tenant-Trennung zur Folge. Alles andere baut darauf auf.
- **[Database] Keine tenant_id-Spalte in den operativen Kerntabellen: guv_daily, sales_transactions, stock_batches, slot_assignments, prices, products, machines, locations**
  - Ohne tenant_id-Spalte in der Relation selbst ist Supabase-RLS unmoeglich (RLS kann nur auf Spalten der Relation filtern, nicht auf JOINs). Das ist die physische Voraussetzung fuer JEDE Isolation. Betrifft die finanz- und betriebssensibelsten Tabellen. Migration muss VOR Code-Rollout und VOR Mini-Deploy erfolgen.
- **[dashboard/lib] Finanz-Datenleck im Query-Layer: economics.js, economics-live.js, overview-monitoring.js, assortment-slots.js lesen guv_daily/sales_transactions komplett ohne tenant_id-Filter**
  - Direktes Leck von GuV, Tagesumsatz, Deckungsbeitrag, Live-Verkaeufen ALLER Kunden. Bei einem SaaS-Verkauf an Vending-Betreiber ist das Wettbewerbs-/Finanzspionage und ein sofortiger Vertrauens- und Rechts-Bruch (DSGVO/Geschaeftsgeheimnis). Hoechste Sensibilitaet.
- **[n8n / dashboard/lib] WF5/alert-digest.js verschickt MHD-/Bestandswarnungen per E-Mail OHNE tenant_id-Filter**
  - Anders als ein read-only Leck im UI: hier werden fremde Kundendaten aktiv per E-Mail in fremde Postfaecher exfiltriert. Nicht zurueckholbar, schwer auditierbar. Eskaliert das Leck von 'sichtbar bei Zugriff' zu 'aktiv versendet'.
- **[API & Auth] Schreibende IDOR an Bestands-Endpunkten ohne requireObjectAccess: /api/v2/refill/trigger, /api/v2/slot-assign-inline/confirm, /api/v2/refill/details**
  - Nicht nur Lesen, sondern Manipulieren fremder Daten: Admin von Mandant A kann mit fremder machine_id Nachfuellungen triggern und Slots zuweisen bei Mandant B. Integritaets-/Sabotage-Risiko ueber reines Lesen hinaus. Der IDOR-Hook existiert, ist hier aber nicht aufgerufen.
- **[n8n] n8n-Kern-Workflows (WF3/WF4/WF5/WF7) mit hartcodierter machine_id=457107528 und global-unfilterierten SQL-Queries; WF1 hardcodierte Google-Drive-Folder-IDs**
  - Selbst nach Schema+RLS+Query-Fix im Dashboard bleibt n8n ein paralleler, tenant-blinder Schreib-/Lesepfad direkt auf die DB. Ein hartcodierter Single-Machine-Anker macht den zweiten Mandanten technisch unmoeglich abzubilden und umgeht jede Dashboard-seitige Isolation. n8n schreibt heute mit globalen DB-Credentials.
- **[API & Auth / Infra] Credential-Modell ist Single-Tenant (Nayax/Google/n8n-Keys via Env-Var/JSON, kein Per-Tenant-Vault)**
  - Mehrere Kunden brauchen je eigene Nayax-Tokens und Datenquellen. Heute liegt EIN Credential-Set im Env/Klartext. Ohne Per-Tenant-Secret-Vault kann ein Mandant nicht von den Nayax-/Sheets-Daten eines anderen getrennt werden, und ein Leak eines Keys exponiert alle.
- **[Database / dashboard/lib] Materialized Views und Views (mv_inventory_value_daily, v_warnings_open, v_slot_turnover) aggregieren ueber tenant-lose Basistabellen**
  - Selbst nach Basis-Migration koennen aggregierte/materialisierte Sichten nicht ohne Neudefinition pro-Mandant gefiltert werden; RLS greift auf MVs nur eingeschraenkt. Leicht zu uebersehen, weil die Quelltabellen 'gefixt' aussehen, die Aggregate aber weiter mischen.

## Empfohlene Migrationsreihenfolge

1. **0. Tenant-Modell + __default__-Backfill-Strategie festlegen (tenant_id TEXT, Konvention 'eigentuemer'/'__default__', Shared-Entities wie Lieferanten/Produktkatalog explizit entscheiden)**
   - _Begründung:_ Vor jeder DDL muss entschieden sein, ob products/suppliers pro Mandant oder shared sind, und welcher Default die Bestandsdaten erbt. Falsche Default-Entscheidung muss sonst spaeter ueber alle Tabellen rueckabgewickelt werden. Reine Konzept-/Entscheidungsstufe, kein Code.
2. **1. Schema-Migration: tenant_id TEXT NOT NULL DEFAULT auf alle operativen Tabellen (machines, locations, slot_assignments, stock_batches, prices, products, sales_transactions, guv_daily, warnings, invoices, invoice_items, suppliers, product_aliases, machine_profiles, nayax_devices, workflow_state, product_change_proposals) + Indizes + Backfill bestehender Zeilen**
   - _Begründung:_ Physische Voraussetzung fuer ALLES Folgende. RLS braucht die Spalte in der Relation, Query-Filter brauchen sie, n8n braucht sie. Muss VOR Code-Rollout und VOR dem geplanten Mini-Deploy laufen (sonst crasht Code, der die Spalte erwartet). Trigger (fn_deduct_stock_on_machine_sale, fn_update_price_from_sale) im selben Schritt um tenant_id-Propagation erweitern, sonst entstehen NULL-/Falsch-Tenant-Zeilen.
3. **2. Auth/JWT zuerst funktionsfaehig machen: resolveViewer liest tenantId aus Login/JWT-Claim (auth.js:140), machineTenant() implementiert echten DB-Lookup (server.js:243-245)**
   - _Begründung:_ Bewusst VOR dem flaechendeckenden Query-Filter und RLS gezogen: Ohne dynamische tenantId aus dem Request und ohne echtes machineTenant() liefern alle nachfolgenden Filter und IDOR-Hooks nur den konstanten TENANT_OWNER und sind nicht testbar. Mit echter tenantId werden RLS und Query-Filter sofort gegen 2 Test-Tenants ('acme','globex') verifizierbar. Dies ist der Hebel, der die schon vorhandene RBAC/IDOR-Architektur aktiviert.
4. **3. Query-Layer-Durchstich: tenantId als Pflicht-Parameter durch alle Query-Funktionen (economics.js, economics-live.js, overview-monitoring.js, assortment-slots.js, inventory-mhd.js, alert-digest.js) + WHERE tenant_id=$N in jeder CTE/Query; server.js reicht viewer.tenantId an alle Aufrufe weiter**
   - _Begründung:_ Defense-in-depth-Schicht, die auch ohne/vor RLS greift und im Node-Layer testbar ist. Haengt an Schritt 1 (Spalte) und 2 (echte tenantId). Vorbild existiert bereits in category-config.js (WHERE mandant_id=$1). Parameter-Binding statt String-Interpolation gegen SQL-Injection.
5. **4. IDOR-Hooks scharfstellen: requireObjectAccess(viewer, machineTenant(machine_id), ...) an allen schreibenden/lesenden Machine-bezogenen Endpunkten ergaenzen (refill/trigger, refill/details, slot-assign-inline/confirm, slot-change/preview, nayax-abgleich/preview, correction-action/confirm)**
   - _Begründung:_ Schliesst die Manipulations-/Cross-Tenant-Zugriffe. Wird erst real wirksam durch das jetzt echte machineTenant() (Schritt 2). Kann parallel zu Schritt 3 laufen, aber nach Schritt 2.
6. **5. RLS-Policies in Supabase aktivieren (FOR ALL USING tenant_id = auth.jwt()->>'tenant_id') auf allen Tabellen aus Schritt 1; Views/MVs neu definieren mit tenant_id im SELECT bzw. partitioniert/pro-Tenant**
   - _Begründung:_ Die harte, datenbankseitige Garantie und der eigentliche Sinn des Supabase-Wechsels. Bewusst NACH Query-Filter (Schritt 3) und Auth (Schritt 2): RLS gegen einen statischen TENANT_OWNER zu testen ist sinnlos; mit echter JWT-tenantId aus Supabase Auth ist RLS sofort end-to-end pruefbar. MV/View-Neudefinition haengt an Schritt 1.
7. **6. n8n-Abloesung/Parametrisierung: WF0-WF5+WF8 (Kern-FIFO/GuV/Slot-Logik) als pg_cron + Supabase Edge Functions pro tenant_id+machine_id reimplementieren; machine_id=457107528 entfernen; WF1/WF2 als tenant-aware Dashboard-Formulare; WF7/WF9 Webhooks mit ?mandant_id; WF-PGW (pgw_write) um mandant_id-Pflichtparameter; Infra-WFs (Monitor/Drift/Val/Update-Check) bleiben/wandern nach Grafana/CI**
   - _Begründung:_ n8n ist der zweite, DB-direkte Schreibpfad und darf nicht tenant-blind bleiben, sonst unterlaufen die WFs RLS via Service-Role-Credentials. Erst nach Schema+RLS (Schritt 1/5) sinnvoll, weil die WFs sonst gegen ein Schema ohne tenant_id liefen. Reihenfolge innerhalb: erst Kern-Schreib-WFs (WF3/WF4/WF8/PGW) wegen Datenintegritaet, dann Form-/Webhook-WFs.
8. **7. Per-Tenant-Credential-Vault (Nayax/Google-Tokens) + Storage-Pfade pro Mandant (Supabase Storage bucket/path = tenant-{id}/) statt Env-Var/lokales FS**
   - _Begründung:_ Notwendig damit jeder Mandant seine eigene Nayax-/Sheets-Quelle hat. Haengt an Schritt 6 (n8n/Edge-Functions muessen den tenant-spezifischen Key ziehen). Klartext-Keys mit system.verwalten-Guard schuetzen, maskierte API-Rueckgabe.
9. **8. Frontend-Kontext: Backend filtert bereits (Schritt 3/5) — Frontend braucht nur Mandanten-Indikator/Selektor + State-Reset (clearState beim Wechsel), State-Objekte um tenantId erweitern**
   - _Begründung:_ Bewusst ZULETZT: Bei korrektem Backend-Filter ist das Frontend rein UX/Future-Proofing und kein Sicherheits-Show-Stopper. Niedrigstes Risiko, daher am Ende. Wichtig nur, sobald ein Nutzer mehrere Mandanten verwaltet (Stale-Daten beim Wechsel vermeiden).

## n8n → Supabase Ablöse-Landkarte

| Workflow | Ziel-Mechanismus |
|----------|------------------|
| WF0 - product_slot_id Backfill | Einmalig: Supabase Edge Function / CLI-Import-Tool mit tenant_id-Parameter; Quelle CSV/REST statt Google Sheets. Danach nur noch historisches Artefakt (kein Produktionspfad). |
| WF1 - Rechnungseingang automatisch mit Claude | Tenant-aware Dashboard-Upload (authenticated) -> Supabase Storage bucket pro mandant_id; Claude-Parsing als Edge Function; invoices/invoice_items mit tenant_id. Google-Drive-Folder-IDs entfallen. |
| WF2 - Smart Product Selection / Rechnungsvorschlaege freigeben | Tenant-aware Dashboard-Formular (authenticated); Proposal-Freigabe als versionierte Edge/Backend-Function; product_change_proposals + products + prices mit tenant_id und session-mandant-Filter. |
| WF3 - Nayax Lynx FIFO Lagerbestand | Kern: Supabase Edge Function via pg_cron pro tenant_id+machine_id; Nayax-Calls async; FIFO/normalize/batch-Logik in versionierter TS-Lib; manueller Trigger als API-Endpoint mit ?mandant_id&machine_id. machine_id=457107528 entfernen. |
| WF4 - MDB Produktzuordnung bearbeiten | Dashboard-Formular + Backend Edge Function; Slot-Lifecycle als SQL-Trigger statt WF-Code; machine_id+tenant_id aus Session; slot_assignments mit tenant_id (WF4 bleibt fachlich Source-of-Truth fuer aktive Slots, aber als Backend-Logik). |
| WF5 - MHD und niedrige Lagercharge ueberwachen | pg_cron (taeglich pro Tenant) + SQL-Trigger fuer warnings.tenant_id; Alert-Versand als Edge/Vercel-Function pro Tenant an Tenant-Admin-Adresse. KRITISCH: E-Mail-Versand muss tenant-gefiltert sein (sonst aktives Leck). |
| WF7 - Nachfuellung melden | Bleibt Webhook, aber Signatur ?product_key&machine_id&mandant_id bzw. bearer->tenant-context; SQL-Filter nach mandant_id; Slot-Updates/Warning-Resolves isoliert. Alternativ Dashboard-getrieben (refill-Endpunkte mit requireObjectAccess). |
| WF8 - GuV Tagesposten Aggregator | pg_cron (taeglich 02:00 UTC) mit PARTITION BY/WHERE mandant_id; guv_daily.tenant_id; Aggregation parallel pro Mandant. Beachten: Node-Schedule sagt 15min, Spec 02:00 - vor Migration vereinheitlichen. |
| WF9 - Pickliste verarbeiten | Supabase Storage pro Mandant statt globalem Google-Drive-Folder; Webhook ?mandant_id; Picklisten-Verarbeitung isoliert nach mandant_id+machine_id; Idempotenz-Check um Mandant erweitern. |
| WF-PGW - PostgreSQL Writer | pgw_write(event_type, batch_run_id, data, mandant_id) Pflichtsignatur; DB-Function prueft mandant_id-Konsistenz. Besser: ganz aufloesen -> direkte tenant-aware Inserts in Edge Functions (vermeidet generischen Service-Role-Schreibpfad, der RLS umgeht). |
| WF-MatView-Refresh | MVs partitioniert nach mandant_id; pg_cron-Refresh pro Mandant; perspektivisch auto-refresh via Trigger/Subscribe statt n8n. |
| WF-Nayax-Devices-Sync | Edge Function/pg_cron mit Tenant-API-Key aus Vault (Schritt 7); nayax_devices.tenant_id; Sync nur fuer machines des passenden Tenants. Nicht mehr ein globaler Nayax-Credential in n8n. |
| WF-Claude-Proposals | Edge Function/pg_cron; Proposals nach mandant_id filtern; Tenant-Kontext im Claude-Prompt; product_change_proposals.tenant_id; E-Mail pro Tenant-Admin. |
| WF-Val - DB Konsistenz-Check | Konsistenz-Checks pro Mandant (SQL WHERE mandant_id); WF3-Neustart-Signal mit Tenant-ID; langfristig DB-Constraints/Trigger statt Polling. Alerts nach Severity+Tenant differenzieren. |
| WF-Monitor / WF-Drift-Check / WF-Update-Check | Bleiben Infra/DevOps-Tools (keine Tenant-Dimension). Empfehlung: Migration nach Grafana/Prometheus/AlertManager (Monitor), GitHub Actions/ArgoCD (Drift/Update). Hardcodierte PatrickZinke@gmx.net ok fuer Infra, aber aus Prod-Tenant-Pfaden raushalten. |

## Zusammenfassung

Das Vending-System ist heute Single-Tenant und in diesem Zustand nicht verkaufsfaehig fuer Multi-Tenant/Supabase. Die Autorisierungs-Architektur ist klug vorgedacht (RBAC + IDOR-Hooks), laeuft aber im Leerlauf, weil tenantId in resolveViewer (auth.js:140) und machineTenant() (server.js:243-245) hartcodiert/Stub sind und 18 von 20 Tabellen keine tenant_id haben. Konsequenz: GuV, Umsatz, Preise, Lager und Rechnungen aller Kunden waeren gegenseitig sichtbar, teils schreibbar, und WF5 wuerde fremde Warndaten aktiv per E-Mail exfiltrieren. Show-Stopper sind: (1) der hartcodierte Tenant-Anker, (2) fehlende tenant_id-Spalten in den Finanz-/Bestandstabellen, (3) ungefilterte Finanz-Queries, (4) der tenant-blinde n8n-Schreibpfad. Empfohlene Reihenfolge wegen der Abhaengigkeiten: Tenant-Modell entscheiden -> Schema+tenant_id-Migration+Trigger (vor dem geplanten Mini-Deploy!) -> Auth/JWT + echtes machineTenant() (aktiviert die vorhandenen Hooks und macht alles testbar) -> Query-Filter-Durchstich -> IDOR-Hooks scharf -> Supabase-RLS -> n8n-Abloesung/Parametrisierung -> Per-Tenant-Credential-Vault -> Frontend-Kontext zuletzt. Auth vor RLS/Filter ist die wichtigste Reihenfolge-Entscheidung: ohne dynamische tenantId ist jede Isolation gegen eine Konstante und damit nicht verifizierbar. classification_settings und settings_thresholds liefern das korrekte Vorbild-Muster fuer alle uebrigen Tabellen.

---

## Detail-Befunde pro Schicht

### database — tenant-ready: **teilweise**

Das n8n-Vending-System ist faktisch Single-Tenant mit der Konstante TENANT_OWNER='eigentuemer' in lib/auth.js. Von 20 Tabellen haben nur 2 (classification_settings, settings_thresholds) bereits tenant_id/mandant_id. Die kritischsten fehlenden Spalten sind in den Bestands-, Finanzen- und Maschinentabellen, die für Supabase RLS unbedingt mandantenfähig werden müssen. Die Spalte purchase_date wurde in Migration 0001 ergänzt, aber 16 weitere Tabellen bleiben ohne Tenant-Isolation. Ein geplanter Mini-Deploy steht an; DDL sollte VOR Code-Roll-out erfolgen.

- **machines** _(Risiko: kritisch)_
  - Problem: Keine tenant_id/mandant_id-Spalte. Jeder Mandant kann sämtliche Automaten des Systems sehen/steuern. KRITISCH für Betreiber-Isolation bei Supabase-Verkauf (z.B. Betreiber-A sollte seine Automaten nicht sehen bei Betreiber-B).
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/auth.js:244 — SELECT tenant_id FROM machines WHERE machine_key = … (Kommentar zeigt geplantes Design, noch nicht umgesetzt); Queries in server.js zeigen keine WHERE-Klausel auf tenant_id.
  - Empfehlung: Migration: ALTER TABLE automatenlager.machines ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '__default__'; CREATE INDEX idx_machines_tenant ON machines(tenant_id). RLS-Policy: (auth.uid() = machines.tenant_id) für SELECT/UPDATE/DELETE. Supabase auth.jwt() → claims.tenant_id casten.
- **locations** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. Standorte sind systemweit sichtbar. Da machines sich auf locations beziehen, ist dies eine Verkettungs-Schwachstelle.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/location-profiles.js:213 — INSERT ohne tenant_id; db-schema.js EXPECTED_RELATIONS Zeile 45 nennt 'locations' ohne Tenant-Hinweis.
  - Empfehlung: Migration: ALTER TABLE automatenlager.locations ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'; INDEX + RLS wie machines. Auf machines.location_id referenzieren, RLS kaskadiern.
- **slot_assignments** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. Slot-Zuordnungen (Automat + Produkt) sind nicht mandantengebunden. Dies ist Kern der Betriebsdaten — kritisch für Multi-Tenant.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations/0003-stock-deduct-trigger.sql — Trigger nutzt Slots ohne Tenant-Filter. EXPECTED_RELATIONS Zeile 48 bestätigt Existenz ohne Tenant.
  - Empfehlung: Migration: ALTER TABLE automatenlager.slot_assignments ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: (auth.jwt()->>'tenant_id' = tenant_id). Trigger fn_deduct_stock_on_machine_sale hat keine Tenant-Bedingung — muss mitgepflegt werden.
- **stock_batches** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. Lagerchargen sind systemweit sichtbar. FIFO-Logik via Trigger hat keine Mandanten-Isolation. Bestandsverwaltung ist ohne Tenant komplett unsicher.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations/0001-stock-batches-purchase-date-machine-id.sql — purchase_date + machine_id hinzugefügt, aber KEINE tenant_id. Trigger trg_deduct_stock_on_machine_sale (Migration 0003) liest Chargen ohne WHERE tenant_id.
  - Empfehlung: Migration: ALTER TABLE automatenlager.stock_batches ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. Trigger fn_deduct_stock_on_machine_sale muss WHERE tenant_id = NEW.tenant_id bekommen (über FK zu slot_assignments.tenant_id leiten). RLS: SELECT/UPDATE nur für eigenen Mandant.
- **prices** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. Preise sind systemweit sichtbar. WF3-Trigger trg_update_price_from_sale schreibt Preise ohne Mandanten-Check.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations/0005-auto-price-from-sales.sql — fn_update_price_from_sale INSERT/UPDATE prices ohne tenant_id-Verweis. Dashboard-Reads in economics.js greifen auf prices zu — kein Tenant-Filter.
  - Empfehlung: Migration: ALTER TABLE automatenlager.prices ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. Trigger fn_update_price_from_sale muss tenant_id von slot_assignments.tenant_id via FK erben. RLS auf prices(tenant_id).
- **products** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. Produktstammdaten sind systemweit. Ein Betreiber sieht alle Produkte aller Betreiber. WF2 schreibt Produkte global ohne Tenant-Zuordnung.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/docs/audit/sheets-sql-audit-2026-06-04.md Zeile 31-32 zeigt WF2-Schreiben ohne Tenant-Scope; db-schema.js Zeile 49 nennt products ohne Tenant.
  - Empfehlung: Migration: ALTER TABLE automatenlager.products ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: Produkte sichtbar nur für Owner-Mandant oder shared (z.B. Lieferanten-Katalog mit special tenant). Dashboard-Reads alle mit WHERE tenant_id = $1 filtern.
- **sales_transactions** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. Verkaufshistorie ist systemweit sichtbar. Finanzberichte (GuV, Umsatz) können Daten von fremden Mandanten enthaften. DATENLECK für Betreiber-Finanzen.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations/0005-auto-price-from-sales.sql — sales_transactions hat keine Tenant-Dimension. Dashboard economics.js liest alles ohne Filter.
  - Empfehlung: Migration: ALTER TABLE automatenlager.sales_transactions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. Trigger trg_update_price_from_sale muss tenant_id via slot_assignment.tenant_id propagieren. GuV-Queries (WF8) Mandanten-filtern: WHERE tenant_id = $1.
- **guv_daily** _(Risiko: kritisch)_
  - Problem: Keine tenant_id-Spalte. GuV-Tagesposten sind systemweit sichtbar. Ein Betreiber kann Umsatz/Gewinn anderer Betreiber sehen. DIREKTES FINANZDATEN-LECK.
  - Beleg: Migration 0006 zeigt workflow_state (WF3-Tracking) ohne tenant_id. GuV wird von WF8 aggregiert (docs/audit Zeile 120) — keine Tenant-Isolation in der Schreib-Logik.
  - Empfehlung: Migration: ALTER TABLE automatenlager.guv_daily ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. WF8-Query (query GuV for this tenant) + RLS: Finanzberichte nur für Eigentümer lesbar.
- **warnings** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Warnungen (MHD, Bestand, etc.) sind systemweit sichtbar. Ein Betreiber sieht Lagerprobleme anderer Betreiber.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/docs/data-model/sheets-db-audit.md Zeile 93-105 dokumentiert warnings ohne tenant_id. Dashboard overview-monitoring.js filtert nicht nach Mandant.
  - Empfehlung: Migration: ALTER TABLE automatenlager.warnings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: Warnung sichtbar nur für Halb, der machine_id besitzt. Trigger liveWarningReconcileSql (lib/overview-monitoring.js) muss tenant_id-Filtering bekommen.
- **invoices** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Rechnungen sind systemweit sichtbar. Ein Betreiber kann Lieferant/EK von anderen sehen. Finanzielle SENSIBILITÄT.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/docs/audit/sheets-sql-audit-2026-06-04.md Zeile 146-165 dokumentiert Rechnungen ohne Tenant; WF1 schreibt Rechnungen ohne tenant_id-Kontext.
  - Empfehlung: Migration: ALTER TABLE automatenlager.invoices ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: Rechnungen gehören dem Mandanten, der die Automaten/Chargen besitzt. Lieferanten können shared sein (Supplier-Tenant-Zuordnung komplexer).
- **invoice_items** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Rechnungspositionen erben Sichtbarkeit der Mutter-Rechnung, aber ohne Spalte nicht RLS-bar. FK zu invoices.invoice_id reicht nicht für Supabase RLS (benötigt Spalte in der Relation).
  - Beleg: Keine dedizierte Migration; Spalte einfach nicht vorhanden. RLS in Supabase kann nur auf Spalten der Relation selbst basieren, nicht auf JOINs.
  - Empfehlung: Migration: ALTER TABLE automatenlager.invoice_items ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: SELECT/UPDATE WHERE tenant_id = auth.jwt()->>'tenant_id'. Invoice-Read-Queries joinen und filtern oder denormalisieren.
- **suppliers** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Lieferanten sind systemweit sichtbar. Ein Betreiber sieht Lieferanten-Kontakte anderer. Bei shared Lieferanten (z.B. Großhandel) design-dependent — aber aktuell keine Unterscheidung.
  - Beleg: docs/audit zeigt suppliers in invoices-Kontext (Zeile 154); keine tenant_id-Zuordnung visible in Code oder Migrations.
  - Empfehlung: Migration: ALTER TABLE automatenlager.suppliers ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. Shared-Suppliers können später mit extra Feld (is_shared BOOLEAN) markiert werden. Für jetzt: ein Mandant je Lieferant.
- **product_aliases** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Aliases (Nayax-Namen, Lieferanten-SKUs) sind systemweit. WF3/WF4 matchen Aliases — Daten-Matching könnte zwischen Mandanten kreuzweis geschehen.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/nayax-abgleich.js — buildAliasIndex, buildNayaxIdIndex Funktionen joinen Aliases global ohne Filter. WF4 liest product_aliases seit #14 direkt aus PG (wf4-product-reads.js).
  - Empfehlung: Migration: ALTER TABLE automatenlager.product_aliases ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. buildAliasIndex/buildNayaxIdIndex muss Tenant als Parameter bekommen. RLS: ein Alias gehört genau einer product + tenant Kombination.
- **product_change_proposals** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Änderungsvorschläge (Produktwechsel-Kandidaten) sind systemweit. Ein Betreiber kann Slots anderer Betreiber sehen in Wechsel-Überlegungen.
  - Beleg: docs/data-model/sheets-db-audit.md nennt product_change_proposals (Zeile 163-165, transient). Keine dedizierte Schreib-Logik visible, aber Module bauen diese auf.
  - Empfehlung: Migration: ALTER TABLE automatenlager.product_change_proposals ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: Proposal gehört zum Slot → zum Machine → zum Tenant.
- **machine_profiles** _(Risiko: mittel)_
  - Problem: Keine tenant_id-Spalte. Machine-Profile (Standort-Daten je Automat) sind systemweit. Dies verstärkt machines-Sichtbarkeitsleck.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/machine-create.js:77 — INSERT INTO machine_profiles ohne tenant_id. FK zu machines(machine_id) vorhanden, aber keine Spalte.
  - Empfehlung: Migration: ALTER TABLE automatenlager.machine_profiles ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: erbe tenant_id von machine, oder FK-Constraint mit ON DELETE CASCADE auf machines.
- **nayax_devices** _(Risiko: niedrig)_
  - Problem: Keine tenant_id-Spalte. Nayax-Devices (Hardware-IDs) sind systemweit. Ein Betreiber könnte Devices anderer über APIs sehen.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/nayax-devices.js:52 — INSERT ohne tenant_id. queryNayaxDevicesPg liest alle.
  - Empfehlung: Migration: ALTER TABLE automatenlager.nayax_devices ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__'. RLS: Device sichtbar nur für Mandant, dessen Automaten das Device nutzen (via machines.machine_key -> machines.tenant_id).
- **workflow_state** _(Risiko: niedrig)_
  - Problem: Keine tenant_id-Spalte. Workflow-State (WF3 Lauf-Tracking) ist systemweit. Bei Multi-Tenant könnten Workflows sich gegenseitig blockieren/beeinflussen.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations/0006-workflow-state.sql — CREATE TABLE ohne tenant_id. WF3 schreibt global einen Watermark.
  - Empfehlung: Migration: ALTER TABLE automatenlager.workflow_state ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__default__' + COMPOSITE PRIMARY KEY (workflow_key, tenant_id). WF3 muss Mandant-spezifischen Watermark je Tenant führen (später bei echtem WF-Scheduler).
- **classification_settings** _(Risiko: niedrig)_
  - Problem: HAT bereits mandant_id (PRIMARY KEY, JSONB config). Vorbildliche Umsetzung für Mandantenfähigkeit.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/category-config.js:198-204 — CREATE TABLE mit mandant_id PRIMARY KEY. Migration 0002: settings_thresholds nutzt tenant_id (Zeile 6).
  - Empfehlung: ✅ VORBILD: category-config.js readOverride/writeOverride (Zeilen 210-232) zeigen korrektes Muster. Alle anderen Tabellen sollten dieses Pattern nachahmen.
- **settings_thresholds** _(Risiko: niedrig)_
  - Problem: HAT bereits tenant_id (NOT NULL, UNIQUE NULLS NOT DISTINCT (tenant_id, machine_id, key)). Mandantenfähigkeit korrekt implementiert.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations/0002-settings-thresholds.sql:5-14 — Korrekte Spalten-Struktur mit tenant_id + Komment.
  - Empfehlung: ✅ VORBILD: settings-thresholds.js getThresholds/setThreshold (Zeilen 59/105) zeigen Filter-Pattern. Alle Reads mit WHERE tenant_id = $1 schützen Daten.
- **v_warnings_open** _(Risiko: mittel)_
  - Problem: View hat keine tenant_id-Spalte (erbt von underlying warnings). RLS auf Views ist in Supabase möglich, aber die View muss tenant_id aus Base-Tabelle selektieren.
  - Beleg: EXPECTED_RELATIONS Zeile 61 nennt v_warnings_open als View; keine DDL vorhanden, aber CREATE VIEW ... SELECT FROM warnings — ohne tenant_id in SELECT.
  - Empfehlung: View-Neudefinition: CREATE OR REPLACE VIEW v_warnings_open AS SELECT w.*, w.tenant_id FROM warnings w WHERE ... AND resolved IS NULL. RLS: SELECT nur für Viewer.tenant_id = view.tenant_id.
- **v_slot_turnover** _(Risiko: mittel)_
  - Problem: View hat keine tenant_id-Spalte (aggregiert über slots + stock_batches). Multi-Tenant-Aggregationen über Base-Tabellen ohne Tenant-Spalten können nicht RLS-gefiltert werden.
  - Beleg: EXPECTED_RELATIONS Zeile 62; keine DDL. View joinet wahrscheinlich slot_assignments + sales_transactions — beide ohne tenant_id.
  - Empfehlung: Nach Tenant-Spalten-Migration in Base-Tabellen: View-Neudefinition mit GROUP BY tenant_id oder explizitem WHERE-Filter. RLS: View selbst kann nicht gefiltert werden, daher Dashboard-Layer muss filtern.
- **mv_inventory_value_daily** _(Risiko: mittel)_
  - Problem: Materialized View (Materialized View) aggregiert Inventarwert täglich. Ohne tenant_id in Base-Tabellen kann die View nicht pro-Mandant aggregiert werden.
  - Beleg: EXPECTED_RELATIONS Zeile 63 nennt mv_inventory_value_daily; keine DDL vorhanden. economics.js (Zeile 701) SELECT * FROM mv_inventory_value_daily — global.
  - Empfehlung: Nach Tenant-Migration: REFRESH MATERIALIZED VIEW mv_inventory_value_daily mit Daten-Filter (WHERE tenant_id = ... oder zwei Views mv_inventory_value_daily_mandant_a, etc., oder Partition). Oder: economics-Module umbauen auf direkte Query (kein Materialized View).

### dashboard/lib (Query-Layer, Supabase-vorbereitung) — tenant-ready: **nein**

Die Dashboard-Query-Schicht ist SINGLE-TENANT heute, hat aber KEINE Mandantenfähigkeit für die kritischen Wirtschafts- und Bestandstabellen (guv_daily, sales_transactions, stock_batches, slot_assignments etc.). Auth-Layer (lib/auth.js) setzt tenantId, aber diese wird in keiner der Haupt-Queries gefiltert. Dadurch entstehen bei Multi-Tenant KRITISCHE DATENLECKS: jeder Mandant sieht alle Finanz-, Verkaufs- und Lagerdaten aller anderen Kunden. Isolation ist NICHT implementiert — queries laufen ungefiltert gegen alle Zeilen.

- **economics.js queryEconomicsPg() / queryEconomicsProvisionalPg()** _(Risiko: kritisch)_
  - Problem: GuV-Queries (guv_daily, sales_transactions) fehlt tenant_id-Filter. Jeder Aufruf sieht ALLE Umsätze/Kosten aller Mandanten. Datenleck: Konkurrenzanalyse, Rentabilität anderer Kunden (KOSTSPIELIG bei SaaS-Verkauf).
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/economics.js lines 665, 680, 692, 761, 803, 812 — FROM automatenlager.guv_daily / sales_transactions ohne WHERE tenant_id=$X
  - Empfehlung: Alle 6 Queries in queryEconomicsPg + queryEconomicsProvisionalPg um tenant_id-Filter erweitern. Voraussetzung: guv_daily, sales_transactions, stock_batches müssen tenant_id-Spalte tragen (DDL). Beispiel: `WHERE g.source != 'historic_backfill' AND g.tenant_id = $N::text` (vor Machine-Clause).
- **assortment-slots.js queryAssortmentSlotsPg()** _(Risiko: kritisch)_
  - Problem: Sortiments-/Slot-Query (guv_daily, sales_transactions) fehlt tenant_id. Liefert Deckungsbeitrag/Drehgeschwindigkeit für ALLE Automaten aller Mandanten. Datenleck: Andere Kunden sehen Rentabilität von Konkurrenz-Maschinen.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/assortment-slots.js lines 198, 222, 233, 243 — SELECT-Klauseln in WITH sales / money_window / last_sale / first_sale ohne tenant_id-Filter
  - Empfehlung: Alle CTEs in queryAssortmentSlotsPg (lines 191–245) um tenant_id-Filter erweitern: `WHERE g.source != 'historic_backfill' AND g.tenant_id = $N` in sales, money_window, last_sale, first_sale. Slot-Join bleibt über machine_id, aber Daten-Quelle muss mandantentrenn sein.
- **overview-monitoring.js queryOverviewMonitoringPg()** _(Risiko: kritisch)_
  - Problem: Umsatz HEUTE (sales_transactions) ohne tenant_id. Finanz-KPI zeigt Summe aller Mandanten als 'Umsatz heute'. Datenleck: Live-Revenue anderer Kunden, Preismodelle.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/overview-monitoring.js lines 302–309 — economicsResult Query gegen sales_transactions ohne WHERE tenant_id
  - Empfehlung: sales_transactions-Query um `WHERE (settlement_at AT TIME ZONE 'Europe/Berlin')::date = ... AND s.tenant_id = $N::text` erweitern. Parameter-Index $N kalibrieren.
- **inventory-mhd.js queryInventoryMhdPg()** _(Risiko: kritisch)_
  - Problem: Stock/MHD-Queries fehlt tenant_id-Filter. Alle stock_batches, slot_assignments, warnings werden ohne Isolation gelesen. Datenleck: Lagerzustände, MHD-Pläne, Bestandswarnungen anderer Kunden einsehbar.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/inventory-mhd.js lines 172–241 — FROM stock_batches / slot_assignments ohne WHERE ... AND tenant_id=$X
  - Empfehlung: Alle 3 Queries (lines 172, 214, 227) um tenant_id-Filter erweitern. Beispiel: `WHERE sb.status IN (...) AND sb.tenant_id = $X` beim stock_batches-Join.
- **alert-digest.js queryAlertDigestPg()** _(Risiko: kritisch)_
  - Problem: Alert-Digest (MHD, Lagerbestände, leere Slots) liest ungefiltert aus stock_batches, slot_assignments, warnings. Datenleck: Tägliche WF5-Mail mit MHD/Bestandswarnungen ALLER Mandanten an jeden Operator.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/alert-digest.js lines 190, 207, 227, 243 — FROM stock_batches / slot_assignments / warnings ohne tenant_id-Filter
  - Empfehlung: Alle 4 Queries um tenant_id-Filter erweitern. Besonders kritisch: WF5-Mail wird per E-Mail verschickt → ohne Filter landen andere Kunden-Daten in fremden Postfächern.
- **economics-live.js queryEconomicsLivePg()** _(Risiko: kritisch)_
  - Problem: Live-Umsatz (sales_transactions) ungefiltert. Datenleck: Echtzeit-Finanzview anderer Kunden (aktuelle Verkäufe, MDB-Codes/Automaten-IDs).
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/economics-live.js lines 84, 101 — FROM automatenlager.sales_transactions ohne WHERE tenant_id
  - Empfehlung: Beide Queries um `WHERE s.source <> 'historic_backfill' AND s.tenant_id = $X::text` erweitern.
- **server.js resolveViewer() / tenantId Deployment** _(Risiko: kritisch)_
  - Problem: Auth-Layer setzt viewer.tenantId = TENANT_OWNER (hardcodiert), aber wird NIRGENDWO an die Queries weitergereicht. Queries laufen als super-user ohne Mandantenkontext.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/auth.js line 140 — tenantId hardcodiert; server.js Zeilen 754, 785, 822, etc. — queryEconomicsPg/Slots/InventoryMhd ohne tenantId-Parameter
  - Empfehlung: 1. viewer.tenantId an alle Query-Funktionen als Parameter weitergeben. 2. Query-Funktionen obligatorisch mit tenantId erweitern. 3. Test: tenantId-Parameter-Binding prüfen (kein SQL-Injection).
- **Basis-Datenmodell (guv_daily, sales_transactions, stock_batches, slot_assignments, machines, locations)** _(Risiko: kritisch)_
  - Problem: KEIN tenant_id (mandant_id) in den Haupt-Datenquellen. Settings-Tabellen (classification_settings, settings_thresholds) haben es, aber nicht die operativen Tabellen. Isolation lässt sich NICHT bauen, solange die Spalte nicht existiert.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/db-migrations — 0002-settings-thresholds.sql hat tenant_id; guv_daily/sales_transactions/stock_batches haben KEINE Migration mit tenant_id
  - Empfehlung: DDL: Migrations für tenant_id-Spalte in guv_daily, sales_transactions, stock_batches, slot_assignments, machines, locations schreiben. Constraint: UNIQUE (tenant_id, key_columns). Backfill: alle Zeilen mit '__default__' (Single-Tenant für jetzt).
- **category-config.js loadEffectiveConfig(client, mandant_id)** _(Risiko: mittel)_
  - Problem: Vorbild für Mandanten-Isolation (liest EXAKT eine mandant_id), aber die Query-Funktionen folgen diesem Pattern NICHT.
  - Beleg: file:C:/Users/patri/Documents/mein-erstes-Projekt/dashboard/lib/category-config.js line 212 — `WHERE mandant_id = $1` — gut, aber andere libs machen das nicht
  - Empfehlung: Alle Query-Funktionen sollten category-config.js als Vorbild folgen: Parameter-Binding mit tenant_id, WHERE-Klausel exakt filtern.

### API & Auth Layer (dashboard/lib/auth.js + dashboard/server.js /api/v2/* endpoints) — tenant-ready: **teilweise**

Das System hat eine RBAC-Schicht (Fähigkeitsprüfung mit requireCapability) und einen IDOR-Schutz (objectAccessAllowed, requireObjectAccess) vorbereitet, nutzt diese aber INKONSISTENT. Die Tenancy ist im Code-Modell hart auf TENANT_OWNER konstant verdrahtet. Echte Multi-Tenant-Fähigkeit erfordert: (1) tenantId aus JWT/Login in resolveViewer, (2) systemweite requireObjectAccess-Prüfung bei Objektzugriffen (heute nur 2 von ~8 relevanten Schreib-Endpunkten), (3) SQL-layer NICHT mit tenant_id-Spalte versehen oder RLS konfiguriert, (4) Credential-Modell Single-Tenant (Env-Var pro Mandant unmöglich).

- **resolveViewer (auth.js:123-144)** _(Risiko: kritisch)_
  - Problem: tenantId ist hartcodiert auf Konstante TENANT_OWNER statt aus Login-Header/JWT extrahiert. Echte Multi-Tenant erfordert viewer.tenantId = extractTenantFromLogin(login) oder viewer.tenantId = jwtClaim.tenant_id
  - Beleg: auth.js:140 — tenantId: TENANT_OWNER (Konstante, nicht dynamisch)
  - Empfehlung: Ändern Sie resolveViewer, um tenantId aus dem Login-Header zu extrahieren: const tenantId = extractTenantFromLogin(login) || TENANT_OWNER; Für Supabase Auth: JWT-Claim verwenden (z.B. jwtPayload.app_metadata.tenant_id). Lokale Tests mit statischen Tenant-IDs ('acme', 'globex') durchführen.
- **/api/v2/refill/details (server.js:1972-2025, GET)** _(Risiko: kritisch)_
  - Problem: Keine requireObjectAccess-Prüfung. Endpoint liest slot_assignments für beliebigen machine_id aus Query-Parametern und liefert Details ohne Mandanten-Verifizierung. Bei echtem Multi-Tenant liest Admin von Mandant A via machine_id=MANDANT_B_AUTOMAT alle Bestandsdaten aus Mandant B aus (IDOR).
  - Beleg: server.js:1974-2005 — WHERE sa.machine_id = $1 ohne vorherigen requireObjectAccess(viewer, machineTenant(machineId))
  - Empfehlung: Fügen Sie nach Zeile 1984 hinzu: if (machineId && !requireObjectAccess(viewer, machineTenant(machineId), res, 'idor:refill-details')) return; Dann würde eine unberechtigte machine_id einen 404 werfen.
- **/api/v2/refill/trigger (server.js:2027-2093, POST)** _(Risiko: kritisch)_
  - Problem: Hat canTriggerActions-Prüfung, aber KEINE requireObjectAccess für machine_id. Admin von Mandant A könnte Nachfüllungen für Mandant B triggern (machine_id, mdb_code vom Body).
  - Beleg: server.js:2049 — const { machine_id, mdb_code, product_id, qty } = body || {}; kein requireObjectAccess danach
  - Empfehlung: Nach Zeile 2053 hinzufügen: if (machine_id && !requireObjectAccess(viewer, machineTenant(machine_id), res, 'idor:refill-trigger')) return;
- **/api/v2/slot-change/preview (server.js:2276-2326, GET)** _(Risiko: mittel)_
  - Problem: Keine Zugriffsprüfung auf machine_id. Gast/Admin von fremdem Mandanten kann Slot-Änderungsvorschau für Automaten anderer Mandanten abrufen (Informationsleck).
  - Beleg: server.js:2283 — const machineId = clean(parsed.query.machine_id || ''); kein Viewer-Check vor DB-Query
  - Empfehlung: Am Anfang des Endpunkts: const viewer = getViewer(req); Dann nach Zeile 2288 (nach Param-Validierung): if (machineId && !requireObjectAccess(viewer, machineTenant(machineId), res, 'idor:slot-change-preview')) return;
- **/api/v2/nayax-abgleich/preview (server.js:3486-3510, GET)** _(Risiko: mittel)_
  - Problem: Keine Viewer-Authentifizierung und keine requireObjectAccess. Jeder (auch Gast!) kann read-only Nayax-Abgleich-Diff für beliebigen machine_id abrufen und Gesamtbestands-/Slot-Struktur fremder Mandanten sehen.
  - Beleg: server.js:3487-3490 — machineKey aus Query, keine getViewer(), keine requireObjectAccess-Prüfung
  - Empfehlung: Fügen Sie am Anfang ein: const viewer = getViewer(req); Falls read-only OK sein soll, dann trotzdem: if (machineKey && !requireObjectAccess(viewer, machineTenant(machineKey), res, 'idor:nayax-preview')) return; Wenn Gäste ausgeschlossen sein sollen: if (!viewer.can('betrieb.lesen')) { sendJson(res, 403, ...); return; }
- **machineTenant() (server.js:243-245)** _(Risiko: kritisch)_
  - Problem: Funktion ist Stub — gibt immer TENANT_OWNER zurück. Reale Implementierung müsste machines.tenant_id aus der DB lesen: SELECT tenant_id FROM automatenlager.machines WHERE machine_key = $1. Single-Tenant tarnt die Lücke.
  - Beleg: server.js:243-245 — function machineTenant(/* machineId */) { return TENANT_OWNER; }
  - Empfehlung: Implementieren Sie: async function machineTenant(pgUrl, machineId) { const client = new Client({connectionString: pgUrl}); await client.connect(); const res = await client.query('SELECT tenant_id FROM automatenlager.machines WHERE machine_id = $1 LIMIT 1', [machineId]); await client.end(); return (res.rows[0]?.tenant_id) || TENANT_OWNER; } Oder vorbereiten mit Lazy-Loading + Caching pro Request.
- **/api/v2/slot-assign-inline/confirm (server.js:3756-3810, POST)** _(Risiko: kritisch)_
  - Problem: Hat bestand.schreiben-Guard, aber KEINE requireObjectAccess für machine_id. Admin kann Slot-Zuweisung für Automat anderer Mandanten durchführen.
  - Beleg: server.js:3764 — const { product_id, product_key, machine_id, mdb_code, qty, start_date } = body || {}; kein requireObjectAccess(viewer, machineTenant(machine_id))
  - Empfehlung: Nach Zeile 3764 hinzufügen: if (machine_id && !requireObjectAccess(viewer, machineTenant(machine_id), res, 'idor:slot-assign-inline')) return;
- **Datenbank-Schema: keine tenant_id-Spalten** _(Risiko: kritisch)_
  - Problem: Tabellen (machines, slot_assignments, stock_batches, products, locations) haben KEINE tenant_id-Spalte. Bei Supabase RLS unmöglich, per-Mandant-Tenancy-Queries unmöglich. Alle Queries müssen per Hand das tenant_id WHERE-Clause mitführen.
  - Beleg: server.js: Alle SELECT/INSERT/UPDATE-Statements übergreifend keine WHERE tenant_id = $X Klauseln (z.B. server.js:2214-2230, 3725-3735)
  - Empfehlung: DDL-Migration: ALTER TABLE automatenlager.machines ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'eigentuemer'; Für alle anderen Objekttabellen + Foreign-Key auf machines(tenant_id). Danach: CREATE POLICY rls_machines ON automatenlager.machines FOR ALL USING (tenant_id = auth.jwt() ->> 'app_metadata' -> 'tenant_id'); Test mit Supabase RLS.
- **Credential-Modell (server.js:181-209, dashboardConfig())** _(Risiko: mittel)_
  - Problem: n8nApiKey, Nayax-Creds, GoogleSheets-Creds sind SINGLE-TENANT via Env-Var/JSON-Datei. Bei echtem Multi-Tenant: mehrere Kundeninstanzen mit unterschiedlichen Nayax-Tokens dürfen NICHT im Klartext im Env liegen.
  - Beleg: server.js:195-197 — n8nApiKey = process.env.N8N_API_KEY | fileConfig | localEnv; kein tenant_id Lookup
  - Empfehlung: Implementieren Sie Secret-Vault (z.B. Supabase vault, HashiCorp Vault, AWS Secrets Manager) mit Schema: SELECT cred_value FROM credentials WHERE credential_type='nayax_token' AND tenant_id=$1. Credentials mit system.verwalten-Guard schützen. Maskierte Rückgabe für API-Keys (z.B. '••••••••' + letzte 4 Zeichen).
- **/api/v2/inventory/batch-search (server.js:2194-2238, GET)** _(Risiko: mittel)_
  - Problem: Hat betrieb.lesen-Guard, aber KEINE tenant_id-Filterung in der SQL-Query. Gast von Mandant A könnte alle Chargen aller Mandanten sehen (bei Supabase RLS ohne tenant_id-Spalte unanwendbar).
  - Beleg: server.js:2214-2230 — SELECT sb.batch_key, ... FROM automatenlager.stock_batches sb WHERE p.name ILIKE $1 (kein Mandanten-Filter)
  - Empfehlung: Nach Hinzufügen von tenant_id zu stock_batches: JOIN automatenlager.machines m ON m.machine_id = sb.machine_id WHERE p.name ILIKE $1 AND m.tenant_id = $2 [.... viewer.tenantId]

### n8n Workflow-Schicht — tenant-ready: **nein**

18 n8n-Workflows audiert. Kritische Befunde: (1) hardcodierte machine_id=457107528 in WF0, WF3, WF4, WF5 — verhindert Multi-Tenant; (2) kein Tenant-Filter in SQL-Queries (alle globale DB-Views); (3) Google Sheets-IDs hardcodiert (12KzLrJzZa...); (4) Nayax-Credentials sind n8n-seitig gespeichert, aber Workflow-Logik nicht tenant-parametrisiert; (5) WF-Drift-Check, WF-Monitor, WF-Val sind Infra-Tools ohne Tenant-Awareness. STRATEGIE: WF0-WF5 (Kern-FIFO/Produktlogik) → pg_cron + Edge Functions (Supabase), WF7/WF9 (Webhook-basiert) → bleibt in n8n aber mit Tenant-Routing, WF1/WF2 (Rechnungseingang + Proposals) → UI-getrieben über Dashboard (mandantenfähig), Infra-WFs (Monitor/Drift/Val) → migrieren in Observability-Layer (Grafana/Loki, nicht n8n).

- **WF0 - product_slot_id Backfill** _(Risiko: mittel)_
  - Problem: Hardcodierte Google Sheets-ID (12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo) + manual Trigger = nur für einen Mandanten. Google Sheets ist ein Arbeits-Layer, nicht ein Multi-Tenant-System. Backfill-Logik ist Stammdaten-Initializer, nicht wiederholbar.
  - Beleg: Config - WF0 node: google_sheet_id = '12KzLrJzZamaHNwDejQXdyBartHCoCbzN9PFK3tF9pSo', manual trigger (nicht geplant, nur ad-hoc)
  - Empfehlung: WF0 in Supabase Edge Function oder CLI-Tool migrieren. Backfill aus strukturiertem Import (CSV/REST) statt Google Sheets. Tenant-ID als Parameter. Nach Migration nur noch historisches Artefakt.
- **WF1 - Rechnungseingang automatisch mit Claude** _(Risiko: kritisch)_
  - Problem: Liest aus Google Drive (fixer Folder-ID), triggert Claude API, speichert Rechnungspostionen in Google Sheets + DB. Keine Tenant-Filter im SQL. Führt zu global-sichtbaren Rechnungen. Google Drive Folder-IDs sind Single-Tenant.
  - Beleg: drive_input_folder_id = '15_5fYaCgnR2pUFpXs6hXJRjvu1jsnS3H', drive_done_folder_id hardcodiert; SQL liest ALLE slot_assignments + Preise ohne WHERE mandant_id
  - Empfehlung: Umstieg auf n8n-interne Datei-Verarbeitung oder Supabase Storage (bucket pro mandant_id). SQL-Queries um tenant-Filter erweitern. Proposal-Status in DB mit mandant_id speichern (product_change_proposals.mandant_id). Langfristig: Form-basierter Input über Dashboard (authenticated, tenant-aware).
- **WF2 - Smart Product Selection - Rechnungsvorschlaege freigeben** _(Risiko: kritisch)_
  - Problem: Form-Trigger (manuell) liest Proposals aus DB (global, no tenant filter), manipuliert Produktdaten (Slots, Preise, Batches) ohne Tenant-Isolation. SQL-Queries sind global (SELECT ... from slot_assignments ohne WHERE mandant_id). Rechnungs-Prefix steht, aber nicht isoliert.
  - Beleg: Google Sheets - Produkte lesen: SELECT p.product_key ... JOIN slot_assignments sa — keine WHERE mandant_id; Form-Input liest approval_id aus product_change_proposals (global tabelle, kein Filter)
  - Empfehlung: Dashboard-Form (authenticated, tenant-aware) als primärer UI. SQL-Queries filtern nach session.mandant_id. product_change_proposals.mandant_id Spalte hinzufügen (DDL). Proposal-Freigabe in versioniertem TypeScript-Code (Vercel Function), nicht in n8n.
- **WF3 Nayax Lynx FIFO Lagerbestand - manueller Abruf - mit WF4 Integration** _(Risiko: kritisch)_
  - Problem: Hardcodierte machine_id=457107528 (Config node). Nayax Polling (manuell + Schedule) liest lastSales, mergt Produkte + Batches global, schreibt sales_transactions + warnings + product_change_suggestions. KEIN TENANT-FILTER IN SQL. Alle Maschinen werden als eine behandelt.
  - Beleg: Config: machine_id='457107528' hardcodiert; Code-Node (FIFO berechnen) iteriert globalData (kein mandant_id). SQL: SELECT ... FROM slot_assignments ... WHERE — fehlt WHERE mandant_id=... OR machine.mandant_id=...
  - Empfehlung: WF3 = Kern-FIFO-Logik → Edge Function (pg_cron Trigger) pro mandant_id + machine_id. Nayax-API-Calls async in Lambda/Deno. Code-Logik (normalize sales, FIFO deduct, batch tracking) in versionierter TypeScript-Lib. Webhook oder API-Endpoint für manuelle Trigger mit ?mandant_id=X&machine_id=Y.
- **WF4 - MDB Produktzuordnung bearbeiten** _(Risiko: kritisch)_
  - Problem: Hardcodierte Config (google_sheet_id, default_machine_id=457107528). Form Trigger (manuell) + Execute Workflow (aus WF3). Liest/schreibt Produktslots ohne Tenant-Filter. SQL-Queries sind global. Machine-ID ist Singleton, nicht skalierbar.
  - Beleg: Config: default_machine_id='457107528', google_sheet_id hardcodiert; SQL: SELECT ... FROM products p JOIN slot_assignments sa — fehlt WHERE mandant_id
  - Empfehlung: WF4 Logik (Slot-Lifecycle: Produkt-Wechsel, Schließung, Neuanlage) → Dashboard-Form + Backend Edge Function. Machine-ID + Tenant-ID aus Session. SQL-Trigger statt WF-Code für Produktslot-Updates (deterministic, schneller). product_slot_id bleibtt PK, aber mit mandant_id-Präfix oder separate FK.
- **WF5 - MHD und niedrige Lagercharge ueberwachen** _(Risiko: mittel)_
  - Problem: Hardcodierte Config (machine_id=457107528, google_sheet_id). Schedule-Trigger täglich 07:00 (UTC). Liest Batches + Slots global, schreibt Warnungen in Fehler_und_Hinweise Sheet. Keine Tenant-Isolation. Warnungen sind global-sichtbar.
  - Beleg: Config: machine_id='457107528'; SQL: SELECT sb.batch_key ... WHERE sb.status IN ('aktiv',...) — keine Tenant-Filter. Warnungen gehen ins globale Sheet.
  - Empfehlung: WF5 Monitoring-Logik → pg_cron (täglich 07:00 UTC per Tenant) + SQL-Triggers. Batches + Slot-Capacity-Alerts generiert direkt in DB (warnings.mandant_id). Alert-Versand (Email, Push) über Vercel Function pro Tenant.
- **WF7 - Nachfuellung melden** _(Risiko: mittel)_
  - Problem: Webhook-basiert (gut), aber parametrisiert nur über product_key. Machine-ID ist hardcodiert in Config. Liest Slots + Hinweise global (no tenant filter). Slot-Updates und Hint-Resolutions sind global.
  - Beleg: Config: machine_id default='457107528' (via node); SQL: SELECT p.product_key ... FROM slot_assignments sa — keine Tenant-Filter
  - Empfehlung: Webhook-Signatur erweitern: ?product_key=X&machine_id=Y&mandant_id=Z oder bearer-token → tenant-context. SQL-Filter nach mandant_id. Slot-Updates nur für aktuelle Tenant. Warnungs-Resolutions isolieren nach mandant_id.
- **WF8 - GuV Tagesposten Aggregator** _(Risiko: mittel)_
  - Problem: Schedule Trigger (15min, laut Node; laut Spec täglich 02:00). Liest Sales_Transactions + Lagerchargen + Slot_Assignments global. Aggregiert GuV-Tagesposten, schreibt in DB. Keine Tenant-Spalte in GuV-Abfragen. Alle Transaktionen werden zusammen aggregiert.
  - Beleg: SQL Read - Verarbeitete_Transaktionen: SELECT ... FROM sales_transactions st WHERE st.settlement_at > NOW() - INTERVAL '120 days' — kein Filter nach mandant_id oder machine.mandant_id
  - Empfehlung: WF8 Aggregation → pg_cron (täglich 02:00 UTC) mit PARTITION BY mandant_id. GuV-Aggregation läuft parallel pro Mandant. guv_daily.mandant_id Spalte hinzufügen. Dashboard zeigt GuV pro Mandant gefiltert.
- **WF9 - Pickliste verarbeiten** _(Risiko: mittel)_
  - Problem: Google Drive Trigger (auf Folder 1Djrp-44NtazCB3pa-07S-uK769gJ2ZcS) oder Webhook. Liest aus DB (Hinweise) global. Picklisten-Verarbeitung hat keine Tenant-ID. Folder-ID ist global für ein Multi-Tenant-System.
  - Beleg: folderToWatch hardcodiert; Code-Idempotenz prüft nur Dateinamen, nicht Mandant. SQL: SELECT w.warning_key ... — kein Tenant-Filter
  - Empfehlung: Google Drive Folder pro Mandant oder migrieren zu Supabase Storage. Webhook mit ?mandant_id=X. Picklisten-Verarbeitung isoliert nach Mandant + Machine-ID.
- **WF-PGW - PostgreSQL Writer** _(Risiko: kritisch)_
  - Problem: Helper-Workflow: executeWorkflowTrigger + PG-Execute-Node. Wird von anderen WFs aufgerufen um pgw_write() zu triggern. Keine Tenant-Isolation im Code. Database-Credentials sind global (Jept3990Uq8aN3Tr). Query-Replacements (event_type, batch_run_id, data) sind nicht tenant-aware.
  - Beleg: Query-Replacement: '{{ $json.event_type }},={{ $json.batch_run_id }},={{ JSON.stringify($json.data ?? {}) }}' — Daten-Parameter enthält keine mandant_id
  - Empfehlung: pgw_write(event_type, batch_run_id, data, mandant_id) Signatur. Alle Aufrufer müssen mandant_id in data oder als 4. Parameter übergeben. DB-Function prüft mandant_id-Konsistenz. Alternativ: pgw_write() ganz aus n8n heraus, nur direkte SQL-Inserts in Edge Functions.
- **WF-MatView-Refresh** _(Risiko: niedrig)_
  - Problem: Schedule-Trigger (täglich 04:45 UTC). Refresht Materialized Views (global). Kein Tenant-Filter. Alle Mandanten teilen sich Refresh-Timing. Potenzielle Contention bei vielen Mandanten.
  - Beleg: REFRESH MATERIALIZED VIEW CONCURRENTLY automatenlager.mv_db_per_slot_monthly — nicht partitioniert nach Mandant
  - Empfehlung: Materialized Views partitionieren nach mandant_id. Refresh pro Mandant parallel (pg_cron mit WHERE mandant_id = X). Oder: Views als auto-refresh über Triggers/Subscribe statt n8n.
- **WF-Nayax-Devices-Sync** _(Risiko: mittel)_
  - Problem: Schedule Trigger (täglich 04:20). HTTP-Request zur Nayax-API (global, keine Tenant-Parametrisierung). Liest Machines-Liste, speichert in DB (nayax_devices). Keine Tenant-Filter. Nayax-Credentials sind n8n-seitig (6JLrl6bb2ns3ISYe).
  - Beleg: Nayax - Get Machines: URL hardcodiert https://lynx.nayax.com/operational/v1/machines; keine Tenant-Filterung der Responses. nayax_devices.mandant_id Spalte fehlt
  - Empfehlung: Nayax-API-Calls mit Tenant-API-Key versehen (falls API Multi-Tenant unterstützt). nayax_devices.mandant_id eintragen. Sync nur für Machines die tenant_id matchen. Langfristig: API-Key pro Mandant in Secrets, nicht in n8n-Credentials.
- **WF-Claude-Proposals** _(Risiko: mittel)_
  - Problem: Schedule Trigger (täglich 04:30). Liest Proposals aus DB (global, no filter). Claude API evaluiert Proposals (approve/reject/escalate). Schreibt Status zurück in product_change_proposals + Email. Keine Tenant-Isolation.
  - Beleg: PG - Proposals lesen: SELECT pcp.proposal_key ... WHERE pcp.status = 'pending' — kein WHERE mandant_id. Email-Versand ohne Tenant-Info
  - Empfehlung: product_change_proposals.mandant_id + Tenant-Kontext in Claude-Prompt. Proposals filtern nach Mandant. Email-Alerts pro Tenant-Admin-Adresse versenden.
- **WF-Update-Check** _(Risiko: niedrig)_
  - Problem: Schedule Trigger (wöchentlich Montag 06:00). Docker Hub API-Check (n8n-Version). Versand Email zu PatrickZinke@gmx.net (hardcodiert). Keine Mandanten-Relevanz.
  - Beleg: sendTo: 'PatrickZinke@gmx.net' hardcodiert. Docker Hub Check ist global, keine Tenant-Dimension
  - Empfehlung: OK — Infra-Tool. Kann in n8n bleiben oder in Uptime-Monitoring-Service (Grafana, Datadog) migrieren.
- **WF-Monitor** _(Risiko: niedrig)_
  - Problem: Schedule Trigger (alle 5 Min). Prüft HTTP-Endpoints (ollama, open-webui, dashboard, postgres). Versand Email zu PatrickZinke@gmx.net (hardcodiert). Keine Mandanten-Relevanz, reines Infra-Monitoring.
  - Beleg: Endpoints sind infrastruktur-global. Email-Adresse hardcodiert. Keine DB-Abfragen.
  - Empfehlung: OK — Infra-Monitoring. Besser: in Grafana/Prometheus/AlertManager oder Uptime-SaaS (Betterstack, Sentry). Nicht in n8n halten für Production.
- **WF-Drift-Check** _(Risiko: niedrig)_
  - Problem: Schedule Trigger (täglich 03:10). Liest Live-Workflows von lokaler n8n-Instanz (localhost:5678), lädt Repo-Workflows von GitHub. Vergleicht und sendet Drift-Report zu PatrickZinke@gmx.net. Keine Tenant-Relevanz.
  - Beleg: Hardcodierte localhost:5678 API, GitHub Repo (PatrickM-git/automatenlager), Email-Adresse. Code: PGW_ID = 'Sajezv8tJll0CLIv' (workflow-ID), EMAIL = 'PatrickZinke@gmx.net'
  - Empfehlung: OK — DevOps/CI-Tool. Passt besser in CI/CD-Pipeline (GitHub Actions) oder GitOps-Controller (ArgoCD). Nicht in n8n für Prod-Monitoring.
- **WF-Val - DB Konsistenz-Check** _(Risiko: mittel)_
  - Problem: Schedule Trigger (täglich 04:15). Konsistenzprüfungen: keine_preise, negative_qty, wf3_stale, alte_warnungen, pending_proposals. Alle Checks sind global (keine Tenant-Filter). Wenn WF3 stale → Auto-Neustart. Alerts zu Email-Adresse (hardcodiert erwartet, aber nicht sichtbar in Export).
  - Beleg: SQL Checks: SELECT ... WHERE sa.active = TRUE (no mandant filter); SELECT ... WHERE sb.status IN ('aktiv','active','reserve') (global); IF-Node: restart_flag='JA' triggert WF3-Neustart ohne Tenant-Kontext
  - Empfehlung: Konsistenz-Checks pro Mandant laufen lassen. SQL-Queries filtern nach mandant_id. WF3-Neustart-Signal enthalte Tenant-ID. Alerts differenzieren nach Severity + Tenant. Langfristig: DB-Constraints + Triggers statt WF-Polling.

### Frontend (v3.js, app.js) — tenant-ready: **teilweise**

Das Frontend v3.js lädt implizit ALLE Automaten, Standorte, Produkte und Chargen ohne Mandanten-Kontext-Filter. Der Mandanten-Kontext (tenantId = "eigentuemer" fix hardcoded in auth.js) wird vom Server bereitgestellt, aber im Frontend NICHT genutzt um Filter zu setzten. Bei echter Multi-Tenant-Migration wird das Frontend ungefilter Daten mehrerer Kunden vermischen. Der HTML-Escape mit `esc()` ist vorhanden (SQL-Injection-Risiko niedrig), aber kein RLS/Mandanten-Kontext-Schutz.

- **v3.js - automatenClientView() + loadPage('/automaten')** _(Risiko: mittel)_
  - Problem: Automaten/Standorte werden ohne WHERE tenant_id Filter geladen. Endpoint /api/v2/machine-profiles + /api/v2/locations liefern ALLE Automaten aller Mandanten; Frontend zeigt sie alle an statt zu filtern.
  - Beleg: v3.js:1076-1098 loadPage('/automaten') → fetchJson('/api/v2/machine-profiles') + fetchJson('/api/v2/locations') ohne Tenant-Parameter; Backend gibt auf line 1082-1083 machines/locations ohne Tenant-Filterung zurück.
  - Empfehlung: 1. Server: /api/v2/machine-profiles und /api/v2/locations müssen aktuellen Mandanten (req.viewer.tenantId) automatisch WHERE-Filter anwenden (RLS später in Supabase). 2. Frontend: Optional visuell anzeigen welcher Mandant gerade aktiv ist (z.B. im Topbar); kein zusätzlicher Frontend-Filter nötig wenn Backend korrekt filtert.
- **v3.js - renderLagerPage() + loadPage('/lager')** _(Risiko: kritisch)_
  - Problem: Lagerchargen (MHD/Bestand) werden für ALLE Mandanten geladen. /api/v2/inventory-mhd gibt global alle Chargen zurück; kein Tenant-Filter angewendet.
  - Beleg: v3.js:1013-1031 loadPage('/lager') → fetchJson('/api/v2/inventory-mhd') ohne Mandanten-Kontext. Bei Multi-Tenant würde Mandant A die Chargen von Mandant B sehen (und potenziell aussortieren können).
  - Empfehlung: 1. Backend: /api/v2/inventory-mhd muss Query-Filter `batches.machine_id IN (SELECT machine_id FROM machines WHERE tenant_id = ?)` anwenden. 2. Später: RLS in Supabase absichern (batches.machine_id → machines.tenant_id). 3. Frontend: Optional Hinweis 'Chargen für Mandant [X] nur' anzeigen wenn mehrere Mandanten existieren.
- **v3.js - assortment-slots (loadPage('/slots'))** _(Risiko: kritisch)_
  - Problem: Sortiment-Slots werden global geladen. /api/v2/assortment-slots gibt Slots für ALLE Automaten aller Mandanten; keine Tenant-Filterung.
  - Beleg: v3.js:1038-1059 loadPage('/slots') → fetchJson('/api/v2/assortment-slots') ohne tenant_id Filter. User könnte Slots anderer Mandanten einsehen/bearbeiten (slot-change/confirm Endpoint ab 3240 akzeptiert beliebige machine_ids).
  - Empfehlung: 1. Backend /api/v2/assortment-slots: Filter `slots.machine_id IN (SELECT machine_id FROM machines WHERE tenant_id = req.viewer.tenantId)` anwenden. 2. Slot-Change-Endpoints (3240, 3243): Vor dem POST zusätzlich prüfen ob the machine_id zum aktuellen Tenant gehört via objectAccessAllowed(). 3. RLS in Supabase später absichern.
- **v3.js - /guv (economics), line 1033-1036** _(Risiko: kritisch)_
  - Problem: GuV-Daten werden global geladen. /api/v2/economics liefert Umsatz aller Automaten aller Mandanten aggregiert. Keine WHERE tenant_id Filterung.
  - Beleg: v3.js:1033-1036 loadGuvData(_guvQuery) → /api/v2/economics?mode=...&machines=... ohne tenant-ID Parameter. Aggregierte KPIs (Umsatz, GuV) zeigen finanzielle Daten anderer Kunden.
  - Empfehlung: 1. Backend /api/v2/economics: Automatisch WHERE machines.tenant_id = req.viewer.tenantId anwenden bevor aggregiert. 2. Frontend: Optional Mandanten-Selektor in GuV-Seite rendern (später wenn Multi-Tenant live); aktuell nur ein Tenant, daher keine Selektor nötig.
- **v3.js - /onboarding (Rechnungsverarbeitung), line 1100-1109** _(Risiko: mittel)_
  - Problem: Onboarding-Daten (Rechnungen, Produkte) werden global geladen. /api/v2/onboarding gibt Pending Approvals aller Mandanten; keine Tenant-Filterung.
  - Beleg: v3.js:1100-1109 fetchJson('/api/v2/onboarding') + putJson('/api/v2/settings/definitions') ohne tenant-ID. Upload-Ziel /api/v2/uploads/invoice (928) akzeptiert Rechnungen ohne Tenant-Kontext.
  - Empfehlung: 1. Backend /api/v2/onboarding: Filter Approvals/Products WHERE supplier_invoices.tenant_id = req.viewer.tenantId. 2. /api/v2/uploads/invoice: Speichere Rechnung mit tenant_id = req.viewer.tenantId (später aus login gelesen). 3. Dateibasierte Uploads sollten in Supabase Storage landen (path = /tenant-{id}/.../) statt lokales Filesystem.
- **v3.js - Monitoring + Correction Cases, line 1060-1075** _(Risiko: kritisch)_
  - Problem: Monitoring-Ampeln und Korrekturfälle werden ohne Mandanten-Filter geladen. /api/v2/monitoring + /api/v2/correction-cases geben alle Fälle aller Automaten zurück.
  - Beleg: v3.js:1060-1075 loadPage('/monitoring') → fetchJson('/api/v2/monitoring') + fetchJson('/api/v2/correction-cases') ohne tenant_id. Ein User sieht Fehler aller Kunden; can(workflows.starten) erlaubt autoPost('...') auf beliebige Case-IDs.
  - Empfehlung: 1. Backend: /api/v2/monitoring Filter ampels WHERE machines.tenant_id = req.viewer.tenantId. /api/v2/correction-cases Filter cases WHERE machines.tenant_id = req.viewer.tenantId. 2. Correction-Confirm Endpoint (452-470, /api/v2/correction-action/confirm): Prüf objectAccessAllowed(req.viewer, case.tenant_id) VOR dem Update.
- **app.js - GuV, Line 314-409** _(Risiko: kritisch)_
  - Problem: app.js lädt GuV-Daten ebenfalls ohne Mandanten-Filter. loadGuv() macht Fetch zu /api/guv mit zeitraum/maschine Parametern, aber OHNE tenant_id Parameter.
  - Beleg: app.js:330 → /api/guv?zeitraum=...&maschine=... ohne tenant-Filter. Falls dieser Endpoint (legacy app.js, nicht v3.js) live ist, zeigt er GuV-Daten aller Mandanten.
  - Empfehlung: 1. Beide Endpoints (/api/guv alt, /api/v2/economics neu) müssen Tenant-Filter anwenden. 2. Konsistenz: Auf v3.js standardisieren (app.js ist legacy); v3.js-Endpoints verwenden.
- **v3.js - Frontend State Management (Global Variables)** _(Risiko: niedrig)_
  - Problem: Frontend hat globale State-Variablen (_slotsFocus, _monState, _lagerBatches, _guvData, etc.) die NICHT an den aktiven Mandanten gebunden sind. Wenn User zwischen Mandanten wechselt (später), könnten alte Daten weitergegeben werden.
  - Beleg: v3.js:251 _monState = {...}, 1325 _lagerBatches = [], 1719 _guvData = null, 3747 _slotsState = {...} — alle global, keine tenant_id im State-Objekt.
  - Empfehlung: 1. Später (bei echtem Multi-Tenant): State-Objekte um tenantId erweitern, z.B. _monState = {tenantId: null, ...}. 2. Bei navigate() oder Mandanten-Wechsel: clearState(). 3. Aktuell Single-Tenant: Nicht kritisch, aber für Future-Proofing beachten.
- **v3.js - API-Aufrufe ohne Tenant-Parameter** _(Risiko: mittel)_
  - Problem: Alle POST/PUT/DELETE Aufrufe (autoPost, postJson, putJson, deleteJson) schicken Daten ohne Tenant-ID mit. Server muss aus req.viewer.tenantId ableiten, aber kein expliziter Tenant-Parameter im Body.
  - Beleg: v3.js:701 autoPost('/api/v2/machines/active', {machine_key, active}) — machine_key ist eindeutig, aber kein tenant_id im Payload. Server-seitig muss über machines.machine_key → tenant_id lookup gehen.
  - Empfehlung: 1. Optional: Tenant-ID im Request-Body mitschicken (z.B. {machine_key, active, tenant_id: X}), Server kann doppelt prüfen. 2. Server MUSS Validierung: machine_key gehört zu req.viewer.tenantId via objectAccessAllowed(). 3. Later: Token enthält tenant_id → Server extrahiert daraus automatisch.
- **v3.js - HTML-Rendering ohne Kontext-Indikator** _(Risiko: niedrig)_
  - Problem: Kein visueller Indikator welcher Mandant/Betrieb gerade aktiv ist. Bei Multi-Tenant könnte User verwirrt sein in welchem Kontext er arbeitet (besonders für Schreib-Operationen).
  - Beleg: v3.js: Alle Seiten rendern ohne 'Aktueller Mandant: [X]' Label. Navigation/Topbar hat keinen Tenant-Indicator.
  - Empfehlung: 1. Navigation (v3.js ~4500) um Mandanten-Anzeige erweitern wenn mehrere Mandanten vorhanden. 2. Optional Mandanten-Dropdown zum Wechseln. 3. Aktuell Single-Tenant: Nicht dringend; für Demo/UX später beachten.
