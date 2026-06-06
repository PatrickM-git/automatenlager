# Ubiquitous Language — Domänen-Glossar

Verbindlicher Wortschatz für Backend, Frontend und Doku des Automatenlager-Systems.
Wenn ein Begriff hier steht, wird er überall **gleich** verwendet (Code-Bezeichner,
UI-Labels, Workflow-Namen, Commit-Messages). Neue Begriffe werden hier ergänzt,
bevor sie sich im Code verteilen.

> Angelegt im Rahmen von Phase „Dashboard v3 Multipage" (Issue v3-H / #8). Quelle
> der Slow-Mover-Definitionen ist `dashboard/lib/slow-mover.js` (`SLOW_MOVER`); die
> Werte hier müssen damit übereinstimmen und werden unter `/einstellungen` angezeigt.

---

## Drehgeschwindigkeit (Branchen-Anker-Klassifikation) *(aktualisiert)*

> Umgestellt von relativer Quartil-/Stückzahl-Logik auf einen **absoluten,
> kategoriebasierten Maßstab**. Quelle: SPEC `docs/specs/branchen-anker-drehgeschwindigkeit-v1.md`.
> Bevorzugter Cluster-Name: **Drehgeschwindigkeit** (*zu vermeiden als Synonym: „Drehzahl",
> „Umschlag" als Klassen­begriff*). Logik liegt im Backend (`classifyTurnover`,
> `dashboard/lib/slow-mover.js`); das Frontend zeigt nur die gelieferte `turnover_class` als **Badge**.

**Drehgeschwindigkeits-Klasse** = wie wirtschaftlich sich ein **Slot/Automat** dreht, gemessen am
**Deckungsbeitrag pro Slot pro Woche** (nicht an Stückzahl, nicht global pro Produkt):

| Klasse (`key`) | Label | Definition |
|---|---|---|
| `renner` | **Renner** | Deckungsbeitrag/Slot/Woche **über** der kategorie­spezifischen oberen Latte. Der Platz verdient überdurchschnittlich. |
| `normal` | **Normal** | Deckungsbeitrag/Slot/Woche **zwischen** unterer und oberer Latte. |
| `langsam_dreher` | **Langsam-Dreher** | Deckungsbeitrag/Slot/Woche **unter** der unteren Latte. Der Platz verdient zu wenig — tauschen erwägen. |
| `ladenhueter` | **Ladenhüter** | **0 Verkäufe seit ≥ `ladenhueterDays` (Default 30) Tagen** — totes Kapital + MHD-Risiko. **Zeitbasiert, Vorrang** vor den Geld-Klassen. |
| `ek_fehlt` | **Bewertung nicht möglich (EK fehlt)** *(neu)* | Kein Einkaufspreis hinterlegt → Deckungsbeitrag nicht berechenbar → **keine geratene Klasse**, sondern neutraler Hinweis (= Nachpflege-Arbeitsvorrat). |
| `neu` | **Neuling (Schonfrist)** *(neu)* | Produkt seit weniger als `graceDays` (Default 14) gelistet → von Renner/Langsam ausgenommen, damit Neulinge nicht vorschnell aussortiert werden. |

Festlegungen:

- **Granularität:** pro Slot/Automat, nicht pro Produkt; durchgängig `machine_id`-parametrisch (N Automaten).
- **Zeitfenster:** rollierend **4 Wochen (28 Tage)**; Verkäufe aus `automatenlager.sales_transactions`,
  EK-Netto über `dashboard/lib/guv-ek.js`.
- **Zwei getrennte Signale:** **Drehgeschwindigkeit** (Geld, „lohnt sich der Slot?") und **Ladenhüter**
  (Zeit, „verrottet hier Kapital?") sind bewusst unabhängig.
- Alle Schwellen (Latten, `graceDays`, `ladenhueterDays`) sind **editierbar und mandantenspezifisch**;
  Defaults greifen ab Tag 1 (Onboarding ohne Konfiguration).

---

## Branchen-Anker, Kategorie-Marge & Produktkategorie *(neu)*

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Branchen-Anker** | Die **von außen** (aus der Branchennorm) gesetzte Default-Latte für die Drehgeschwindigkeit — **nicht** aus den eigenen Ist-Zahlen abgeleitet. | „relativer Vergleich", „eigener Schnitt" |
| **Deckungsbeitrag pro Slot/Woche** | Klassifikations-Kennzahl: `(Menge im 4-Wochen-Fenster × (VK_netto − EK_netto)) ÷ Wochen`, je Slot. | „Drehzahl", „Umsatz pro Slot" |
| **Umsatz-Norm** | Branchenüblicher Umsatz eines gut positionierten Automaten (≈ 800–1200 €/Monat); **Quelle** der Default-Latte (× Kategorie-Marge), nicht selbst die Latte. | „Zielumsatz" |
| **Kategorie-Marge** | Kategoriespezifischer Rohmargen-Anteil zum Ableiten der Latte. Defaults: **Getränke 43 %, Snacks 52 %, Fallback 50 %**. | „Aufschlag" |
| **Produktkategorie (`produktart`)** | Warengruppe eines Produkts (`getraenk`, `snack`, …); mandantenerweiterbar. Wird aus Google Sheets **in die SQL-DB übernommen** (Single source of truth). | „Typ" (kollidiert mit Automaten-`type`) |
| **Latte (untere/obere)** | Der kategoriespezifische Schwellwert des Deckungsbeitrags/Slot/Woche: **unter** der unteren Latte = Langsam-Dreher, **über** der oberen = Renner, dazwischen = Normal. Der Default jeder Latte ist der Branchen-Anker. | „Grenze", „Cutoff", „Quartil" |

Beziehungen: Produkt **hat** genau eine Produktkategorie · Kategorie **trägt** eine Kategorie-Marge ·
Umsatz-Norm × Kategorie-Marge **ergibt** den Branchen-Anker (Default-Latte) je Kategorie ·
Mandant **kann** eigene Kategorien anlegen, zuordnen und deren Marge setzen.

---

## Slot, MDB-Code & Etagen-Konvention

- **Slot** = ein Verkaufsplatz in einem Automaten, adressiert über `machine_id`
  (Automat) + `mdb_code` (Position laut MDB-Protokoll).
- **MDB-Slot-Code-Schema:** Die **erste Ziffer** des MDB-Codes = **Etage**, die
  **folgenden Ziffern** = **Position innerhalb der Etage** (z. B. `12` = Etage 1,
  Position 2).
- **Etagen-Konvention:** **oberste Reihe zuerst** — Etage 1 ist oben, höhere
  Etagennummern liegen darunter. Die Slot-Position wird, sofern nicht explizit
  gespeichert, rückwärtskompatibel aus dem Slot-Code abgeleitet.
- **`product_slot_id` / aktive Zuordnung:** WF4 ist die einzige Quelle der
  Wahrheit für aktive MDB/Slot-Zuordnungen (`active = TRUE/FALSE`,
  `valid_from`/`valid_to`). `active = TRUE` bedeutet **aktive Slot-Zuordnung**,
  nicht bloße Produktexistenz.

---

## Wirtschaftlichkeit: Deckungsbeitrag & Marge

- **Umsatz (netto / brutto):** `revenue_net` ist netto, `revenue_gross` ist brutto.
- **Deckungsbeitrag (DB, netto):** `db_net` = Netto-Umsatz − Netto-Wareneinsatz.
  Der Netto-Wareneinsatz wird über den MwSt-Faktor `revenue_net / revenue_gross`
  aus den Brutto-Kosten abgeleitet (ab Migration `0016`, exakt da Einkaufs-MwSt =
  Verkaufs-MwSt je Produktart).
- **Marge:** `margin_pct` = `db_net / revenue_net × 100`.
- **Achtung Spaltennamen:** In `guv_daily` sind `revenue_gross` und
  `cost_of_goods` **brutto**, `gross_profit` ist eine **Brutto**-Differenz. Für
  netto-konsistente KPIs immer die KPI-Views ab `0016` nutzen — **nie**
  `gross_profit` direkt durch `revenue_net` teilen.

---

## Standort-Status

- **aktiv / inaktiv / geplant** — Betriebsstatus eines Standorts. Im normalisierten
  PG-Schema ohne eigene Spalte; lesend aus der Maschinen-Aktivität abgeleitet
  (≥ 1 aktive Maschine → `aktiv`, Maschinen aber keine aktiv → `inaktiv`, keine →
  `geplant`). Siehe `dashboard/lib/location-profiles.js`.

---

## Zugriffsrollen & Fähigkeiten (RBAC)

> Quelle: SPEC `docs/specs/auth-sicherheitskonzept-v1.md`. Berechtigungen werden als
> **Fähigkeiten (Verben)** modelliert, nicht pro Reiter. Ein Reiter wird sichtbar,
> sobald der Viewer **mindestens eine** passende Fähigkeit hat. Durchsetzung erfolgt
> **serverseitig** (HTTP `403` bei fehlender Fähigkeit); das Ausblenden in der UI ist
> nur Komfort, nicht der Schutz.

- **Fähigkeit (Verb):** Eine einzelne, benannte Berechtigung. Kanonisch genau sechs:
  - **`betrieb.lesen`** — Tagesgeschäft ansehen (Reiter Heute, Bestand, Monitoring, Automaten).
  - **`finanzen.lesen`** — GuV/Umsatz/Marge sehen (Reiter GuV). Eigener Vertraulichkeits-Schalter.
  - **`bestand.schreiben`** — Korrektur, Slot-Editor, Onboarding, Refill schreiben (Wahrheitsquelle WF4).
  - **`workflows.starten`** — n8n-Workflows triggern (querschnittlich, kein einzelner Reiter).
  - **`nayax.schreiben`** — Nayax-Apply/Push ausführen. **Höchstes Risiko.**
  - **`system.verwalten`** — Einstellungen + Zugangsdaten verwalten. **Master-Fähigkeit.**
- **Rolle:** Ein benanntes **Bündel** von Fähigkeiten (Voreinstellung). Kanonisch drei:
  - **Eigentümer** — alle sechs Fähigkeiten.
  - **Auffüller** (*Synonym Operator; bevorzugt: Auffüller*) — `betrieb.lesen` + `bestand.schreiben`
    (optional `workflows.starten`); **kein** `finanzen.lesen`, `system.verwalten`, `nayax.schreiben`.
  - **Gast** — nur `betrieb.lesen` (read-only). *Zu vermeiden: „Read-Only-Benutzer" als Rollenname.*
- **Viewer** *(aktualisiert)***:** Das vom Server pro Anfrage aufgelöste Subjekt (`getViewer`) mit Login,
  Rolle, Fähigkeiten, **Heimat-Mandant** und **effektivem** `tenantId` (Trennung siehe Cluster „Auth scharf").
  Einziger Knotenpunkt der Identitätsauflösung.

Beziehungen: Rolle **bündelt** 1..n Fähigkeiten · Reiter/Endpunkt **fordert** 1..n Fähigkeiten ·
Viewer **hat** genau eine Rolle (und damit deren Fähigkeiten).

---

## Authentifizierung & Vertrauen

> Identität ist nur dann vertrauenswürdig, wenn sie über den richtigen **Pfad** kommt
> (Sicherheits-Review **F1**). Der Loopback-Bind allein genügt nicht gegen Spoofing.

- **Identity-Header:** Der `Tailscale-User-Login`-Header. Nur **Tailscale Serve** setzt
  bzw. überschreibt ihn vertrauenswürdig; client-gesetzte Werte werden dort verworfen.
- **Serve-Pfad:** Zugriff über **Tailscale Serve, HTTPS auf `:8443`**. **Nur hier** wird
  der Identity-Header ausgewertet. *Zu vermeiden: roher TCP-Zugang auf `:8787`.*
- **Interner Pfad:** Zugriff übers Docker-Netz `homelab-network` (z. B.
  `homelab-dashboard:8787`, etwa durch WF-Monitor). `Tailscale-*`-Header werden hier
  **verworfen**; der Aufruf gilt **immer als Gast/read-only**. = **pfad-basiertes Vertrauen**.
- **Default-Deny:** „Kein Identity-Header → **kein** Admin." Kehrt das frühere
  Fehlverhalten (`!header → Admin`) um. *Zu vermeiden: „Operator-Trust".*
- **Loopback-Notausgang (Dev-Flag):** Kein Header + lokaler Loopback ⇒ Admin **nur**, wenn
  `DASHBOARD_DEV_LOCAL_ADMIN` gesetzt ist (Entwicklung). In Produktion **aus**.
- **Exakte Allowlist:** Nur **exakt** hinterlegte Logins erhalten eine Rolle. Die alte
  Präfix-Regel (`startsWith('patrick')`) entfällt ersatzlos.

---

## Mandant & editierbare Schwellwerte

- **Mandant / `tenant_id`** *(aktualisiert)***:** Ein **Betrieb/eine Firma** als logische Eigentümer-Einheit
  der Daten — **nicht** eine Person; mehrere Logins können zu einem Mandanten gehören (z. B. eine Firma
  mit zwei Eigentümern = zwei Logins, **ein** Mandant). `tenant_id` ist der **einheitliche, kanonische
  Spaltenname auf jeder operativen Tabelle** (denormalisiert, RLS-fertig); die frühere Abweichung
  `classification_settings.mandant_id` wird darauf angeglichen. Im UI/Fachsprech bleibt „Mandant".
  *Zu vermeiden: „Kunde" als Code-Begriff; „Mandant = Login".*
- **Schwellwert (editierbar):** In `/einstellungen` (`system.verwalten`) änderbarer Wert. Kanonisch:
  **Ladenhüter-Tage** (Default 30, vgl. Slow-Mover-Cluster) und **MHD-Risiko-Fenster** (Default 30 Tage).
- **Globaler Default vs. Pro-Automat-Override:** Ein Schwellwert gilt **global**, solange kein
  Automat per `machine_id` abweicht; ein **Override** ist eine Wert-pro-Automat-Festlegung, die den
  globalen Default schlägt.
- **„Auf Standard zurücksetzen":** Reset eines Schwellwerts auf den Code-Default — **pro Wert** (↺)
  und als **globale** Aktion (alles zurücksetzen).
- **Editierbar je Mandant** sind neben den Schwellwerten auch **Kategorien**, **Kategorie-Margen** und
  die **Latten** der Drehgeschwindigkeit (siehe Branchen-Anker-Cluster).

---

## Mandantenfähigkeit: Standort, Lager & Mitgliedschaft *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-datenmodell-v1.md` (Stufe 0). Grundsatz: **eine** Isolations-Regel —
> jede operative Tabelle trägt `tenant_id` (denormalisiert, RLS-fertig), keine geteilten Zeilen.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Standort (`locations`)** | Aufstellort von Automaten; gehört genau einem Mandanten, ein Automat hängt an genau einem Standort. Wird **nie** über Mandanten geteilt (gleiches Gebäude, zwei Betreiber = zwei Einträge). | „Lager" (ein Standort ist kein Backstock-Ort) |
| **Lager (`warehouses`)** | Benannter Backstock-Ort, der dem Mandanten gehört (eigene Tabelle), optional einem Standort zuordenbar. | „Standort"; „Zentrallager" als Oberbegriff |
| **Zentrallager** | Das automatisch beim Mandanten-Anlegen erzeugte Default-Lager (`is_default = TRUE`, genau eines je Mandant). Löst das frühere namenlose „`machine_id = NULL`" ab. | „Hauptlager" |
| **Mitgliedschaft (`tenant_users`)** | Zuordnung Login + Mandant + Rolle (Eigentümer/Auffüller/Gast); ein Mandant kann mehrere Mitglieder haben (zwei Eigentümer = zwei Mitgliedschaften). | „Benutzerkonto", „Account" |
| **Notfall-Schlüssel / Break-Glass (`platform_admins`)** *(aktualisiert)* | MandantenÜBERGREIFENDER Support-Zugriff (Plattform-Betreiber), als eigene Tabelle modelliert (keine Rolle *innerhalb* eines Mandanten); standardmäßig **leer = niemand übergreift**, jeder Zugriff protokolliert. Wird in **Stufe 2 (Auth scharf)** als nur-lesende **Support-Sitzung** scharfgeschaltet (siehe Cluster „Auth scharf"). | mit Rolle „Eigentümer/Auffüller/Gast" verwechseln; „Superadmin-Rolle" |
| **Mandanten-treuer Fremdschlüssel (composite FK)** | Zusammengesetzter FK `(tenant_id, parent_id)` statt nur `parent_id`; die DB garantiert, dass ein Kind nur auf einen Eltern **desselben** Mandanten zeigt. | „normaler Fremdschlüssel" als Schutz |
| **`__default__`** | Transienter Platzhalter-Mandant **nur** während der Migration — nie Besitzer echter Daten; Altdaten ziehen auf den realen Mandanten um. | als echten Mandanten/Besitzer verwenden |

Beziehungen: Mandant **hat** 1..n Mitgliedschaften · Mandant **hat** 1..n Standorte, 1..n Lager (mind. 1 Zentrallager),
1..n Automaten · Automat **steht an** genau einem Standort · Lager **kann** einem Standort zugeordnet sein ·
Charge **liegt in** höchstens einem Ort (**Automat ODER Lager**; aktive Charge: genau einem, verbrauchte/ausgesonderte darf ortlos sein).

---

## Mandantenfähigkeit: Auth scharf (Stufe 2) *(neu)*

> Quelle: SPEC `docs/specs/multi-tenant-auth-scharf-stufe-2-v1.md`. Stufe 2 ersetzt die
> hartcodierte Konstante durch dynamische, DB-gestützte Mandanten-Auflösung und schaltet
> damit die schon gebaute RBAC/IDOR-Architektur scharf. Verkabelung, kein neues Feature/UI.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Heimat-Mandant (`homeTenantId`)** | Der Mandant, dem ein Login laut `tenant_users` dauerhaft angehört — der Alltagskontext. | „der Mandant" pauschal (verdeckt die Heimat/effektiv-Trennung) |
| **Effektiver Mandant (`tenantId`)** | Der Mandant, auf dem ein Request **tatsächlich** operiert; standardmäßig = Heimat-Mandant, bei aktiver Support-Sitzung = Ziel-Mandant. | `tenantId` als „immer = Heimat" lesen |
| **Plattform-Admin** | Ein in `platform_admins` eingetragener Login mit der Befugnis, im Supportfall fremde Mandanten zu betreten; **getrennt** von Mandanten-Mitgliedschaft und RBAC-Rolle (Doppelrolle möglich). | „Superadmin-Rolle"; mit Eigentümer-Rolle vermischen |
| **Support-Sitzung (Break-Glass, scharf)** | Die **zur Laufzeit aktivierte** Form des Notfall-Schlüssels: bewusster, per-Request-expliziter, **nicht-klebriger**, **nur-lesender** Cross-Tenant-Zugriff eines Plattform-Admins; Default bleibt immer der eigene Mandant. | „Support-Modus" als dauerhafter Zustand; „Impersonation" mit Schreibrechten |
| **Mandanten-Override (`X-Support-Tenant`)** | Das explizite Header-Signal, das eine Support-Sitzung pro Request aktiviert; nur wirksam bei Plattform-Admin **und** vertrauenswürdigem Identity-Pfad **und** existierendem Ziel-Mandant. Client-kontrolliert ⇒ untrusted by default. | `?tenant_override`-Query-Param; „Tenant-Switch" als Sitzungszustand |
| **Mandanten-Registry (`tenant-directory`)** | Das Deep Module, das Login→Mandant, Plattform-Admin-Status, Mandanten-Existenz und Maschine→Mandant aus der DB in einen In-Memory-Cache lädt und als **einzige** Auflösungsquelle dient (`resolveViewer` bleibt synchron). | „der Cache" pauschal; Auflösung verstreut in Endpunkten |
| **Maschinen-Mandant (`machineTenant`)** | Auflösung `machine → tenant_id`; liefert bei unbekannter Maschine **`null`** (nie einen Default), zwingend gekoppelt an `objectAccessAllowed` (`null` ⇒ deny). | unbekannte Maschine ⇒ Eigentümer/`t_faltrix` |
| **Capability-Stripping** | Durchsetzung von read-only: bei aktiver Support-Sitzung werden die Fähigkeiten des Viewers auf die **Lese-Teilmenge** (`*.lesen`) reduziert, sodass bestehende `requireCapability`-Guards Schreibzugriffe automatisch mit `403` abweisen. | read-only nur über HTTP-Methode prüfen |
| **fail-closed** | Jeder **technische** Fehler der Mandanten-Auflösung (DB/Cache) ⇒ deny/`503`, **nie** ein Default-Mandant. Strikte Trennung: „nicht gefunden/fremd" ⇒ `404`, „technisch fehlgeschlagen" ⇒ `503`. | `catch ⇒ Default-Mandant`; `404` und `503` vermischen |

Beziehungen: Login **hat** genau einen Heimat-Mandanten (über Mitgliedschaft) · Plattform-Admin **kann** je Request eine Support-Sitzung auf einen fremden Mandanten öffnen ·
Support-Sitzung **setzt** den effektiven Mandanten ≠ Heimat-Mandant **und** erzwingt read-only · Mandanten-Registry **ist** die einzige Quelle für Heimat-Mandant, Plattform-Admin-Status und Maschinen-Mandant.

---

## Anbieter-Integration: `provider` & Vending Data Integration Layer *(neu)*

> Nayax ist der **erste**, nicht der einzige Daten-Eingang. Stufe 0 nimmt nur die `provider`-Dimension mit;
> die volle anbieter-agnostische Schicht ist eine eigene spätere SPEC.

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Anbieter (`provider`)** | Quelle der eingespeisten Vending-Daten (heute nur `'nayax'`, Default); Dimension auf `sales_transactions` und `nayax_devices`. | „Nayax" als Synonym für „Anbieter" |
| **Vending Data Integration Layer (VDIL)** | Zielbild einer anbieter-agnostischen Schicht, in die Nayax als erster Adapter mündet (volle Schicht = spätere SPEC). | — (Synonym „PPAL" nur informell) |
| **Geräte-Claiming** | Ein physisches Gerät gehört **genau einem** Mandanten — systemweite Eindeutigkeit `nayax_devices UNIQUE(provider, nayax_machine_id)`. | „Geräte-Zuordnung" (zu schwach) |
| **Externe Transaktions-ID (`external_transaction_id`)** | Anbieter-agnostischer Idempotenz-Schlüssel eines Verkaufs (verallgemeinert `nayax_transaction_id`), eindeutig je `(tenant_id, provider, external_transaction_id)`. | „Nayax-Transaktions-ID" als Code-Feld |

Beziehungen: Anbieter **speist** Verkäufe und Geräte ein · Gerät **gehört** genau einem Mandanten (Claiming) ·
Verkauf **ist eindeutig** je (Mandant, Anbieter, externe Transaktions-ID).

---

## Beispiel-Dialog (Branchen-Anker) *(neu)*

> **Dev:** „Der Kaugummi-Slot verkauft 12×/Woche, der Cola-Slot nur 4×. Ist Kaugummi der Renner?"
> **Domain Expert:** „Nein — wir messen **Deckungsbeitrag pro Slot/Woche**, nicht Stück. Cola macht
> mehr Marge pro Stück, also kann Cola trotz weniger Verkäufen der Renner sein."
> **Dev:** „Und wenn ein Slot unter der Latte liegt — automatisch Langsam-Dreher?"
> **Domain Expert:** „Nur wenn der EK hinterlegt ist. Ohne EK gibt's `ek_fehlt`, keine geratene Klasse.
> Und ein **Neuling** in der Schonfrist bleibt außen vor."
> **Dev:** „Woher kommt die Latte selbst?"
> **Domain Expert:** „Aus dem **Branchen-Anker** — Umsatz-Norm × Kategorie-Marge — nicht aus unseren
> eigenen schwachen Zahlen. Deshalb darf unser Automat ehrlich überwiegend Langsam-Dreher zeigen."

## Beispiel-Dialog (Mandantenfähigkeit) *(neu)*

> **Dev:** „Deine Firma hat zwei Eigentümer — sind das zwei Mandanten?"
> **Domain Expert:** „Nein. Ein **Mandant ist der Betrieb**, nicht die Person. Zwei Eigentümer sind zwei
> **Mitgliedschaften** im selben Mandanten, beide sehen alles."
> **Dev:** „Eine Charge liegt im Zentrallager — wie speichere ich den Ort?"
> **Domain Expert:** „Über `warehouse_id`, das aufs **Zentrallager** zeigt. Eine Charge ist **entweder** im
> Automaten **oder** im Lager — nie beides."
> **Dev:** „Ein Standort und ein Lager — ist das nicht dasselbe?"
> **Domain Expert:** „Nein. Der **Standort** ist, wo Automaten stehen; das **Lager** ist, wo Backstock liegt.
> Manchmal am selben Ort — dann hängt man das Lager optional an den Standort, muss man aber nicht."
> **Dev:** „Wenn ein Kunde Hilfe braucht, schaue ich einfach in seine Daten?"
> **Domain Expert:** „Nur über den **Notfall-Schlüssel** (`platform_admins`) — standardmäßig aus, jeder Zugriff
> protokolliert. Das ist keine normale Rolle, sondern bewusst der Ausnahmeweg."
> **Dev:** „Zwei Kunden haben denselben Nayax-Automaten in der Liste — erlaubt?"
> **Domain Expert:** „Nein, **Geräte-Claiming**: ein Gerät gehört genau einem Mandanten, systemweit eindeutig.
> Der zweite läuft in einen Konflikt."

## Beispiel-Dialog (Auth scharf) *(neu)*

> **Dev:** „Ich bin Plattform-Admin — sehe ich dann immer alle Kunden?"
> **Domain Expert:** „Nein. Standardmäßig bist du in deinem **Heimat-Mandanten**. Fremde Daten siehst du nur in
> einer **Support-Sitzung**, die du **pro Request** explizit über den Header `X-Support-Tenant` öffnest — und nur **lesend**."
> **Dev:** „Was, wenn ich den Header weglasse?"
> **Domain Expert:** „Dann bist du sofort wieder in deinem eigenen Mandanten. Die Sitzung **klebt nicht** — es gibt keinen dauerhaften Support-Modus."
> **Dev:** „Und wenn die DB beim Auflösen kurz weg ist — wird der Request dann dem Eigentümer zugeschlagen?"
> **Domain Expert:** „Niemals. **fail-closed**: technischer Fehler ⇒ `503`, kein Default-Mandant. Eine *unbekannte* Maschine ist was anderes — die gibt `null` und damit `404`."
> **Dev:** „Wie wird read-only erzwungen — blocke ich einfach POST?"
> **Domain Expert:** „Primär über **Capability-Stripping**: in der Support-Sitzung bleiben nur die Lese-Fähigkeiten, also liefern die bestehenden Guards bei Schreibzugriff automatisch `403`. Der Methoden-Block ist nur der zweite Riegel."

## Markierte Unklarheiten *(neu)*

- **Slot-Zahl pro Automat** für die Latten-Ableitung (Umsatz-Norm ÷ Slot-Zahl): Quelle aus den
  Stammdaten ist in der Umsetzung (TDD) zu fixieren — Empfehlung: aktive Slots je `machine_id`.
- **Persistenzort der Mandanten-Konfiguration** (Kategorien/Margen/Latten): DB-Tabelle vs. bestehende
  Settings-Datei — Empfehlung: DB-Tabelle mit `tenant_id`, konsistent zum Single-source-of-truth-Ziel.
- **Format der `tenant_id`** (opaker Slug vs. UUID): in der Schema-Migration (TDD) zu fixieren —
  Empfehlung: opake, **stabile** ID (unveränderlich), Anzeigename strikt getrennt.
- **Physische Umbenennung `nayax_transaction_id` → `external_transaction_id`:** in Stufe 1 optional,
  um heutige Schreiber (n8n) nicht sofort zu brechen — Zeitpunkt der Umbenennung festlegen.
- **Antwort auf nicht-berechtigten `X-Support-Tenant`** (Stufe 2): ignorieren-und-auditieren
  (proxy-resilient) vs. striktes `403` — SPEC empfiehlt ignorieren + `denied`-Audit; finale Wahl in der Umsetzung bestätigen.
- **Exakte Lese-Teilmenge für Capability-Stripping** (Stufe 2): welche der sechs Fähigkeiten als „lesen" gelten —
  in der Umsetzung (TDD) fixieren; Empfehlung: genau `betrieb.lesen` + `finanzen.lesen`.

## Secret-Handling & Audit

- **Secret-Handling:** Zugangsdaten (z. B. n8n-API-Key) sind **nur mit `system.verwalten`**
  editierbar, gehen **nie im Klartext** an den Browser (immer maskiert, z. B. `••••gesetzt`),
  erscheinen **nie in Logs/Audit** und werden im Datenmodell **je Mandant** getrennt gehalten.
- **Audit-Trail:** Append-only-Protokoll **aller** privilegierten Aktionen (Workflow-Trigger,
  Nayax-Apply, Settings-/Schwellwert-Änderung, Rollenvergabe) inkl. **abgewiesener** Versuche
  (`403`) und interner-Pfad-Aufrufe. Erweitert das bisherige Gast-Zugriffs-Log (`auditGuestAccess`),
  das heute nur Gäste erfasst. *Zu vermeiden: „Logging" für diesen sicherheitsrelevanten Trail.*
