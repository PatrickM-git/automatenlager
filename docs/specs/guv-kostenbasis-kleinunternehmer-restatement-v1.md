# SPEC — GuV-Kostenbasis Kleinunternehmer vereinheitlichen + historisches `guv_daily`-Restatement (v1)

> Status: geplant · Kontext: Stufe 6 (n8n-Ablösung), Befund aus dem WF8-GuV-Port ([#161](https://github.com/PatrickM-git/automatenlager/issues/161), PR #171)
> Diese SPEC basiert auf einer Verifikation der Kern-Annahmen gegen den **echten Code** (`file:line`-Belege), nicht auf Doku-Annahmen.
> Finanzkritisch: ändert berichtete Kunden-P&L; die Zahlen sind Grundlage der **Steuererklärung** des Betreibers.

## Problem Statement

Das Besteuerungsmodell („Kleinunternehmer §19 UStG" vs. „regelbesteuert") entscheidet, ob der Wareneinsatz **brutto** (gezahlte MwSt ist echte, nicht erstattete Kosten) oder **netto** (Vorsteuer wird erstattet) gebucht wird. Der Betreiber (Faltrix) **ist** Kleinunternehmer; in der Konfiguration steht korrekt `kleinunternehmerAktiv = true`.

Trotzdem rechnen heute zwei Stellen **unterschiedlich**, weil sie denselben gespeicherten Wert mit **unterschiedlicher Schlüssel-Schreibweise** lesen:

- Die **Live-Ansicht** („heute", provisorische Posten) liest den Schlüssel in camelCase (`kleinunternehmerAktiv`), sieht `true` und rechnet korrekt **brutto** — schreibt aber **nichts** in die Datenbank (rein flüchtige Anzeige; verifiziert: alle `guv_daily`-Zugriffe in `economics.js` sind lesend).
- Die **Nacht-GuV** (der Job `lib/jobs/guv-aggregate.js`, vormals WF8) liest snake_case (`kleinunternehmer_aktiv`). Dieser Schlüssel existiert im gespeicherten Objekt nicht → `COALESCE(...,'FALSE')` → der Job rechnet **immer netto** und bucht das in `guv_daily`.

Damit divergiert für **denselben Slot/Posten** die Kostenbasis zwischen flüchtiger Live-Anzeige (brutto) und gebuchter Nacht-GuV (netto) — und so auch Deckungsbeitrag/`gross_profit`. Das Modul `guv-ek.js` dokumentiert **eine gemeinsame Basis** ausdrücklich als Ziel; die Schlüssel-Lesung bricht es.

Der Befund reicht weiter als „ab jetzt": **jede** heute in `guv_daily` gebuchte Zeile ist auf der **Netto**-Basis (für einen Kleinunternehmer also zu niedrige Kosten, zu hoher Gewinn). Das betrifft **zwei** Schichten:

1. **`source = 'wf8_guv_aggregator'`** (ab ~11.05.2026): netto wegen des beschriebenen Schlüssel-Bugs.
2. **`source = 'historic_backfill'`** (Okt 2025 – 10.05.2026): ein einmaliges Nachtrags-Skript hat diese Vor-WF8-Zeit aus den Nayax-Verkäufen aggregiert — ebenfalls **netto** (Kostenbasis = Menge × Netto-EK, `kleinunternehmer_aktiv` sogar fest auf `'FALSE'`).

Weil die Zahlen Grundlage der Steuererklärung sind, müssen **beide** Schichten auf der korrekten (Brutto-)Basis stehen — nicht nur die laufende. Eine naive „nach Quelle alles brutto rechnen"-Korrektur ist gefährlich (Doppel-Anwendung, Vermischung von „auf welcher Basis die Zeile *ist*" mit „welche Basis sie haben *soll*").

## Solution

Eine **einzige Wahrheit** für die Kostenbasis, an **allen drei** Stellen identisch (Live-Anzeige, Nacht-GuV go-forward, historisches Restatement):

- **Schlüssel vereinheitlichen:** Der Nacht-Job liest künftig den kanonischen camelCase-Schlüssel (snake_case nur noch als Legacy-Fallback; bei Konflikt gewinnt camelCase). Damit honoriert die Nacht-GuV das gespeicherte `kleinunternehmerAktiv = true` und bucht — wie die Live-Ansicht — **brutto**.
- **MwSt-Quelle vereinheitlichen:** Der Brutto-Aufschlag nutzt überall den **Kategorie-Satz** aus der editierbaren Einstellungen-Konfiguration (Snack 7 %, Getränk 19 %, sonst `defaultMwstPct` 19 %) — exakt die Quelle, die die Live-Ansicht bereits verwendet. Dadurch verschieben sich die Live-Zahlen **nicht**, und Nacht-GuV wie Restatement liegen auf derselben Basis.
- **Historie beleg-treu nachziehen (Restatement):** Bereits gebuchte Netto-Zeilen werden **in-place** auf brutto gehoben, ohne FIFO neu zu rechnen — die ursprüngliche Mengen-/Kostenzuordnung bleibt erhalten, korrigiert wird **nur** die Steuerbasis. Das Restatement macht jede betroffene Zeile **genau** zu dem, was der korrigierte Nacht-Job für dieselben Eingaben gebucht hätte (Historie == Zukunft).

Sicherheit steht im Mittelpunkt, weil berichtete P&L verändert wird:

- Ein **Klassifizierungs-Schritt vor dem Restatement** stempelt jede Zeile mit ihrer tatsächlichen Basis (`cost_basis`). Das Restatement läuft **ausschließlich** auf eindeutig als `netto` markierte Zeilen — nie pauschal nach Quelle. Mehrfaches Ausführen ist dadurch **echt** idempotent (nicht nur scheinbar).
- Ein **Preflight-Trockenlauf** zeigt die finanzielle Wirkung (Summe alter/neuer Wareneinsatz, simulierte Gewinn-Differenz, Top-Abweichungen, Anomalie-Zähler) **bevor** irgendetwas geschrieben wird.
- Ein **Audit-Logbuch mit Run-ID** hält je Zeile Alt-/Neu-Werte fest → vollständig nachvollziehbar und **reversibel**, auch bei Teilläufen.

Aus Nutzersicht: Die Dashboard-P&L (und die daraus abgeleiteten Steuerzahlen) zeigt für einen Kleinunternehmer endlich durchgängig die **echten Kosten** — heute, gestern und für die gesamte gebuchte Historie konsistent.

## User Stories

1. As a Betreiber (Kleinunternehmer), I want, dass meine gebuchte Nacht-GuV den **Brutto-Wareneinsatz** ansetzt, so that mein berichteter Gewinn die tatsächlich gezahlte, nicht erstattete MwSt enthält und steuerlich korrekt ist.
2. As a Betreiber, I want, dass „heute" (Live) und „gestern" (gebucht) **dieselbe** Kostenbasis nutzen, so that der Verlauf keinen unerklärlichen Sprung an der Tag-Grenze macht.
3. As a Betreiber, I want, dass **alle** historischen GuV-Zeilen (auch die Vor-WF8-Zeit ab Okt 2025) auf der korrekten Basis stehen, so that ich meine Steuererklärung vollständig und richtig auf diese Zahlen stützen kann.
4. As an Entwickler, I want **eine** gemeinsame Funktion, die das Besteuerungsmodell aus der rohen Konfig liest (camelCase kanonisch, snake_case Legacy-Fallback, camelCase gewinnt bei Konflikt), so that Live-Pfad und Nacht-Job nie wieder auseinanderlaufen.
5. As an Entwickler, I want den Brutto-Aufschlag überall aus der **Kategorie-MwSt** der Einstellungen-Config ableiten, so that Live, Nacht-Job und Restatement nachweislich dieselbe Basis verwenden und die Live-Zahlen unverändert bleiben.
6. As an Operator, I want jede `guv_daily`-Zeile mit ihrer tatsächlichen Kostenbasis (`cost_basis`) markiert, so that ich „auf welcher Basis die Zeile *ist*" von „welche Basis sie haben *soll*" sauber trenne und ein Restatement nie doppelt anwende.
7. As an Operator, I want, dass das Restatement **nur** Zeilen mit `cost_basis = 'netto'` anfasst, so that bereits korrekte oder unklare Zeilen unberührt bleiben (echte Idempotenz, kein „scheinbar idempotent").
8. As an Operator, I want **vor** dem Schreiben einen Preflight-Trockenlauf mit simulierter Summen- und Gewinn-Differenz sowie den größten Einzel-Abweichungen, so that ich die finanzielle Wirkung sehe und freigebe, bevor berichtete Zahlen sich ändern.
9. As an Auditor, I want je restateter Zeile ein Logbuch mit Run-ID, Alt-/Neu-Werten, MwSt-Satz und Faktor, so that jede Änderung an berichteter P&L nachvollziehbar und exakt umkehrbar ist — auch bei einem Teil-Lauf.
10. As an Operator, I want ein dokumentiertes Rollback-Runbook, so that ich ein Restatement (oder einen Teil-Run) kontrolliert zurücknehmen kann, ohne aus Datenbestand zu raten.
11. As a regelbesteuerter Mandant (zukünftig), I want, dass meine Zeilen netto bleiben und **nie** restated werden, so that die Brutto-Korrektur ausschließlich Kleinunternehmer-Daten betrifft.
12. As a Qualitätssicherer, I want die Korrektur **live** gegen eine echte Postgres-DB durch die Mandanten-Tür getestet (acme/globex), so that Isolation, Idempotenz und Brutto-Buchung nachgewiesen sind und nicht nur behauptet.
13. As an Entwickler, I want, dass das Restatement jede Zeile **genau** so macht, wie der korrigierte Nacht-Job sie buchen würde (inkl. `revenue_net = revenue_gross` bei Kleinunternehmer), so that Historie und Zukunft byte-genau konsistent sind.

## Implementation Decisions

### Schlüssel-Vereinheitlichung (eine Wahrheit fürs Besteuerungsmodell)

- **Eine gemeinsame Lesefunktion** für das Besteuerungsmodell aus der rohen Konfig (`classification_settings`-JSONB). Regel: **camelCase `kleinunternehmerAktiv` zuerst**; fehlt er, **snake_case `kleinunternehmer_aktiv` als Legacy-Fallback**; sind **beide** vorhanden, **gewinnt camelCase**. Akzeptiert Boolean und die Strings `'true'/'false'` (case-insensitiv), konsistent zu `sanitizeOverride` in `category-config.js`.
- Diese Funktion ersetzt im Nacht-Job (`lib/jobs/guv-aggregate.js`, `parseConfig`) die reine snake_case-Lesung. Sie lebt an **einer** Stelle (Vorschlag: `lib/guv-ek.js`, das bereits „eine gemeinsame Basis" als Vertrag dokumentiert) und wird von Nacht-Job und Config-Schicht gemeinsam genutzt.
- Die heutige **faithful-Replikation** des WF8-Bugs entfällt: WF8 ist deaktiviert, der Port ist alleiniger Produzent, der Schatten-Paritäts-Harness ist kein Gate mehr.

### MwSt-Quelle (Kategorie-Satz als kanonische Basis)

- Der **Brutto-Aufschlag** auf den Netto-EK nutzt **überall** den Kategorie-MwSt-Satz aus der effektiven Einstellungen-Config (`resolveCategory(...).mwstPct`: Snack 7 %, Getränk 19 %, unbekannt → `defaultMwstPct` 19 %). Das ist exakt die Quelle des Live-Pfads ([economics.js](dashboard/lib/economics.js)) → **Live-Zahlen verschieben sich nicht**.
- Der Nacht-Job leitet seinen Wareneinsatz künftig aus **dieser** Quelle ab (statt primär aus `products.vat_rate_pct`). Damit verwenden Live, Nacht-Job und Restatement **denselben** Satz pro Produkt; eine Rest-Divergenz zwischen Produkt-Satz und Kategorie-Satz kann nicht entstehen.
- **Warum Kategorie statt pro-Produkt-`vat_rate_pct`:** Das Zielmodell ist kategorie-getrieben — beim Onboarding wählt der Betreiber künftig nur noch die **Kategorie** (Dropdown mit zentral gepflegten, **per-Mandant** konfigurierbaren MwSt-Sätzen), kein Freitext. Damit ist die Kategorie die natürliche, zukunftssichere Quelle; der heute pro Produkt eingetragene `vat_rate_pct` ist ein Legacy-Freitext, der den Kategorie-Satz **spiegeln** soll.
- **Reconciliation statt blindem Vertrauen:** Der Preflight vergleicht je Produkt `vat_rate_pct` gegen den Kategorie-Satz (erwartet **identisch**). Abweichungen werden gelistet = Legacy-Freitext-Fehler zum Nachpflegen — **nicht** ein zweiter, konkurrierender Wahrheits-Satz. Stimmen alle überein (Normalfall), ist die Quellen-Wahl ohnehin wirkungsgleich.
- `costBasisMultiplier(mwst, { kleinunternehmer })` aus `guv-ek.js` (KU mit gültiger MwSt → `1 + mwst/100`, sonst `1`) bleibt die **eine** Multiplikator-Funktion für Live, Nacht-Job und Restatement.

### `cost_basis`-Marker & Klassifizierung (Idempotenz über den NULL-Marker)

- **Neue Spalte `cost_basis`** auf `automatenlager.guv_daily`: Werte `'netto'` / `'brutto'`, **nullable, kein Default**. Bewusst kein Default → jede Zeile muss **explizit** klassifiziert werden; ein stilles Auffüllen wird vermieden.
- **Klassifiziert wird über den NULL-Marker, nicht über `source`.** Begründung (verifiziert): Sobald der Code-Fix live ist, trägt eine **neue** Brutto-Zeile dieselbe `source` (`wf8_guv_aggregator`) wie eine **alte** Netto-Zeile — `source` allein kann sie nicht unterscheiden. Der NULL-Marker trennt sauber „vor dem Fix" (= `NULL`, zu klassifizieren) von „nach dem Fix" (= vom Job gestempelt).
- Ablauf: (a) Spalte anlegen → alle Bestandszeilen sind `NULL`; (b) der korrigierte Nacht-Job **stempelt jede neue Zeile** mit der Basis, die er tatsächlich benutzt hat; (c) eine Klassifizierungs-Migration setzt die verbliebenen `NULL`-Zeilen auf `'netto'` — **nachdem** der Preflight bewiesen hat, dass sie netto sind. Echtes Unklares bleibt `NULL` und wird **gemeldet, nicht restated**.
- **Zwei-Achsen-Modell (zentral):** `cost_basis` ist ein **Faktum** (auf welcher Basis die Zeile *ist*). Die Restatement-Entscheidung ist **getrennt** (soll der Mandant brutto sein → Kleinunternehmer?). Ein regelbesteuerter Mandant: Zeile bleibt `'netto'` **und wird nie restated** — nicht „auf netto gesetzt und dann übersprungen", sondern korrekt netto und außen vor.

### Restatement: Formel, Umfang & Mandanten-Tor

- **Umfang über `cost_basis`, nicht über `source`:** Restated wird, was **`cost_basis = 'netto'` UND** dessen Mandant effektiv Kleinunternehmer ist. `source` (`wf8_guv_aggregator`, `historic_backfill`) dient der **Validierung** im Preflight, nicht der Auswahl. Beide Schichten werden so erfasst, ohne dass die Quelle die Entscheidung trifft.
- **Mandanten-Tor:** Das Restatement ist auf das **effektive** Kleinunternehmer-Flag gegated. Heute wird die Config global aus `classification_settings.__default__` gelesen (`= true` → alle Faltrix-Zeilen); echte per-Mandant-Config bleibt **Stufe 6**. Die Logik ist strukturell per-Mandant-bereit (entscheidet je Mandant), heute global wirksam.
- **Beleg-treue In-place-Formel** (pro Zeile, kein FIFO-Neulauf; `revenue_gross` bleibt unverändert):
  - `new_cost_of_goods = old_cost_of_goods × (1 + Kategorie_MwSt/100)`
  - `new_gross_profit  = revenue_gross − new_cost_of_goods`
  - `new_revenue_net   = revenue_gross` (Kleinunternehmer erhebt keine USt auf den Umsatz — koppelt an dasselbe Flag wie der Nacht-Job; macht Historie == go-forward)
  - `cost_basis = 'brutto'`
- Die Kategorie-MwSt je Zeile kommt aus `guv_daily.product_id → products.category → Kategorie-Satz`; ohne auflösbare Kategorie greift `defaultMwstPct` (19 %). Solche Zeilen werden im Preflight **separat gezählt**, damit der Default-Faktor sichtbar ist und nicht still angewendet wird.

### Audit & Rollback

- **Logbuch-Tabelle `audit.guv_restatement_log`** (im bestehenden `audit`-Schema, Infra-Territorium, analog `audit.workflow_runs`). Felder je restateter Zeile: `restatement_run_id`, `tenant_id`, `guv_key`, `source`, `old_cost_of_goods`, `new_cost_of_goods`, `old_revenue_net`, `new_revenue_net`, `old_gross_profit`, `new_gross_profit`, `vat_rate`, `factor`, `executed_at`, `executed_by`, `rollback_at`, `rollback_by`. Die `run_id` bündelt einen Lauf → **robuster Teil-Rollback**.
- **Rollback** = aus dem Logbuch die Alt-Werte je `guv_key` zurückschreiben, `cost_basis` zurück auf `'netto'`, `rollback_at/by` stempeln. Dokumentiert als **Runbook** (Vorbild `docs/security/rls-stufe-5-rollback.md`).

### Reihenfolge & Rollout (deploybar, je Schritt rückwegsfähig)

1. **Migration `0028`** — DDL: Spalte `guv_daily.cost_basis` (nullable, kein Default) + Tabelle `audit.guv_restatement_log`. Idempotent, **vor** Code.
2. **Migration `0029`** — Klassifizierung: verbliebene `NULL`-Zeilen → `'netto'` (idempotent; bricht/meldet bei Brutto-implizierenden Anomalien statt blind zu setzen).
3. **Code-Deploy** — vereinheitlichte Schlüssel-Lesung + Kategorie-MwSt-Quelle; Nacht-Job **stempelt** `cost_basis` je neuer Zeile (brutto bei KU, sonst netto). **Live-Pfad bleibt unverändert** (er honoriert camelCase bereits und schreibt nicht).
4. **Preflight-Trockenlauf** auf dem Mini (s. u.) → Freigabe der finanziellen Wirkung.
5. **Migration/Run `0030`** — Restatement: `cost_basis='netto'` ∧ KU → Brutto-Werte + `revenue_net=revenue_gross`, Logbuch je Zeile mit `run_id`, Stempel `'brutto'`. Idempotent (nur `netto`).
6. **Live-Smoke** auf dem Mini + Rollback-Runbook griffbereit. Mini-Deploy: DDL vor Code, Container-Restart (Mechanismus: Memory `mini-deploy-mechanismus`).

### Preflight-Erweiterung (`dashboard/tools/preflight-guv-daily.js`)

Der bestehende read-only Preflight wird um einen **finanziellen Trockenlauf** ergänzt — ausgegeben **vor** jedem Schreiben:
- Zeilen je `source`; Zeilen je `cost_basis`; Anzahl `NULL` in `cost_basis`.
- Anzahl **KU-Zeilen mit `netto`** (= Restatement-Kandidaten); Anzahl **Nicht-KU-Zeilen mit `brutto`** (Anomalie, erwartet 0).
- Σ alter Wareneinsatz (COGS); **simulierte** Σ neuer COGS; **simulierte** Differenz im Gross Profit.
- **Top-20** größte Einzel-Differenzen (je `guv_key`).
- Zähler `historic_backfill`-Zeilen **ohne auflösbare Kategorie** (Default-Faktor 19 % sichtbar).
- **Reconciliation** je Produkt: `products.vat_rate_pct` vs. Kategorie-Satz — erwartet identisch; Abweichungen werden gelistet (Legacy-Freitext zum Nachpflegen, kein zweiter Wahrheits-Satz).

## Testing Decisions

Gute Tests prüfen **externes Verhalten**, nicht Implementierungsdetails: die berechneten/gebuchten Beträge, die Idempotenz, die Mandanten-Isolation — nicht die internen Schritte. Vorbild sind die bestehenden Suiten `dashboard/tests/dashboard-jobs-guv-aggregate.test.js` (reine Rechen-Parität + Live-acme/globex durch die Tür unter RLS) und `dashboard/tests/besteuerungsmodell-ek-kostenbasis.test.js` (Vertrag von `guv-ek.js`/`category-config.js`).

**Schlüssel-Lesung & Brutto-Rechnung (rein, ohne DB):**
- KU + Snack: Netto-EK × 1,07.
- KU + Getränk: Netto-EK × 1,19.
- KU + unbekannte Kategorie: Fallback 19 %.
- `snake_case` wirkt **nur** als Legacy-Fallback (wenn camelCase fehlt).
- Bei **beiden** Schlüsseln gewinnt **camelCase** (Konflikt-Test — eindeutig).
- Regelbesteuert: Wareneinsatz bleibt netto (unverändert).

**Nacht-Job go-forward:**
- Neue Zeile bei KU: `cost_basis = 'brutto'`, `revenue_net = revenue_gross`, Brutto-Kostenbasis.
- Neue Zeile bei Regelbesteuerung: `cost_basis = 'netto'`, netto-Kosten.
- Die heute das **Bug-Verhalten** fixierenden Asserts (`dashboard-jobs-guv-aggregate.test.js`, u. a. die „camelCase wird faithful ignoriert"- und Konfig-Fälle) werden auf das **neue** Brutto-Verhalten umgestellt.

**Restatement (live gegen echte DB, durch die Tür, acme/globex unter RLS):**
- Netto-Zeile eines KU-Mandanten wird brutto: `cost_of_goods`, `gross_profit`, `revenue_net` exakt wie der korrigierte Nacht-Job; `cost_basis = 'brutto'`; Logbuch-Zeile mit `run_id` + Alt/Neu.
- **Idempotenz:** zweiter Lauf ändert **nichts** (nur `cost_basis='netto'` wird angefasst), keine zweite Logbuch-Zeile mit Wirkung.
- Regelbesteuerter Mandant: Zeile bleibt netto, **kein** Logbuch-Eintrag, kein Cross-Tenant-Effekt (Isolation).
- Rollback: stellt Alt-Werte exakt wieder her, `cost_basis` zurück auf `'netto'`.

**Konsistenz-Anker (stärkster Regressions-Schutz):**
- `Live == Nacht` auf **identischem** Input (brutto == brutto) — der korrigierte Nacht-Job und der Live-Pfad liefern für denselben Posten dieselben Beträge. Tritt an die Stelle des alten Schatten-Paritäts-Harness, nur jetzt für die **korrekte** Basis.

**Unberührt / Altlasten:**
- Der `unit_cost = netto`-Guard (Issue #51, `wf8-ek-semantics-guard.test.js`) bleibt gültig und unverändert (er betrifft die EK-Interpretation, nicht das Besteuerungsmodell).
- `dashboard/tools/shadow-guv-parity.js` ist nach WF8-Aus obsolet → Archiv-Hinweis (kein Test der Suite).

## Out of Scope

- **Sichtbarkeit der Vor-WF8-Zeit (2025) im GuV-Panel + Vollständigkeits-Audit.** Das GuV-Panel blendet `historic_backfill` heute komplett aus; das Nachtrags-Skript hat zudem Verkäufe **ohne EK/Mapping übersprungen** (= fehlender Umsatz, steuerlich gewichtig). Das ist ein **eigenes Issue** (Daten-Sichtbarkeit + Daten-Audit), getrennt vom Besteuerungsmodell-Bug. Wichtig: Dieses Restatement deckt die `historic_backfill`-Zeilen **bereits jetzt** mit ab — sie liegen danach korrekt brutto vor, der zweite Strang muss sie nur noch **sichtbar** schalten (kein zweiter Restatement-Lauf nötig).
- **Quelle von `revenue_net` (Nayax-`net_amount` vs. abgeleitet).** Der Live-Pfad nutzt den realen Nayax-`net_amount`, der Nacht-Job leitet `revenue_net` aus `revenue_gross` ab. Diese **Quellen-Differenz** betrifft nur den Netto-Deckungsbeitrag (`db_net`), nicht die für einen Kleinunternehmer maßgeblichen Brutto-Größen, und wird hier **nicht** vereinheitlicht (eigener Befund). Diese SPEC stellt nur die KU-Kopplung `revenue_net = revenue_gross` her.
- **Echte per-Mandant-Konfiguration** (`classification_settings` per Mandant statt global `__default__`) — bleibt **Stufe 6**.
- **Admin-konfigurierbare MwSt-Sätze + kategorie-getriebenes Onboarding.** Zielbild: MwSt-Sätze zentral und **per Mandant** pflegbar (auch Nicht-DE mit anderen Sätzen); Produkt-Onboarding wählt die **Kategorie** per Dropdown (kein Freitext-MwSt mehr → `vat_rate_pct` spiegelt nur noch den Kategorie-Satz). Knüpft an per-Mandant-Config (**Stufe 6**) + Mandanten-Admin-UI (**Stufe 8**, ROADMAP A4); eigenes Issue. Diese SPEC legt mit „Kategorie als kanonische Quelle" bereits das Fundament dafür.
- **`(tenant_id, guv_key)`-Uniques / globale Unique abbauen** — bleibt Slice 4 / [#111](https://github.com/PatrickM-git/automatenlager/issues/111).
- **FIFO-Neuberechnung der Historie** — bewusst nicht (Snapshot-Drift); das Restatement korrigiert nur die Steuerbasis auf den gebuchten Werten.

## Further Notes

- **Warum jetzt sicher umsetzbar:** WF8 ist deaktiviert, der Port (`lib/jobs/guv-aggregate.js`) ist alleiniger Produzent von `guv_daily`; es gibt **kein** Schatten-Paritäts-Gate mehr, das ein Abweichen von WF8s Bug-Verhalten blockiert.
- **Warum kein Doppel-Brutto-Risiko (code-verifiziert):** Einziger produktiver Schreiber von `guv_daily` ist der Nacht-Job ([guv-aggregate.js:328](dashboard/lib/jobs/guv-aggregate.js#L328)); der Live-Pfad schreibt nie. Es existieren daher **keine** persistierten Brutto-Zeilen — jede Bestandszeile ist netto. Der NULL-Marker + Preflight-Beweis machen die Klassifizierung dennoch defensiv und zukunftssicher (weitere Quellen/Mandanten).
- **Leitsatz:** *Quelle hilft klassifizieren, `cost_basis` entscheidet das Restatement.* Der gefährlichste Fehler wäre ein pauschales Restatement nach Quelle — strukturell ausgeschlossen.
- **Finanzielle Wirkungsrichtung:** Brutto-Kosten > Netto-Kosten → gebuchter `gross_profit` **sinkt** (konservativer/korrekter für einen Kleinunternehmer). Die Wirkung ist im Preflight quantifiziert, bevor sie geschrieben wird.
- **Folge-Issues (angelegt):** [#172](https://github.com/PatrickM-git/automatenlager/issues/172) „historic_backfill (Steuerjahr 2025) sichtbar + Vollständigkeits-Audit"; [#173](https://github.com/PatrickM-git/automatenlager/issues/173) „Admin-konfigurierbare MwSt-Sätze (per Mandant) + kategorie-getriebenes Onboarding-Dropdown" (Stufe 6/8).
