# SPEC: Dashboard v3 — Mobile-first Multi-Page Cockpit (Faltrix)

**Status:** Entwurf, umsetzungsreif
**Bereich:** Lokales Node-Dashboard (`dashboard/`) des Faltrix-Verkaufsautomaten-Inventarsystems
**Repo / Branch:** github.com/PatrickM-git/automatenlager, `main` (Live-Klon: `mein-erstes-Projekt`)
**Vorgänger:** v2 „Betreiber-Cockpit" (SPA, Hash-Router) unter Route `/v2`; Legacy „Automatenlager Leitstand" unter `/`

---

## Problem Statement

Das aktuelle Betreiber-Cockpit (v2) ist eine Single-Page-App mit Hash-Router und wurde primär am Desktop entworfen. Im Alltag wird das Dashboard aber häufig mobil genutzt — beim Befüllen vor dem Automaten, unterwegs, im Lager. Daraus ergeben sich konkrete Schmerzpunkte für die Betreiberin/den Betreiber:

- **Unübersichtliche Startseite.** Die Heute-/Übersicht zeigt eine lange Liste aller Slots (in der Praxis Dutzende Einträge), statt sofort zu sagen, was *jetzt* zu tun ist. Man muss scrollen und selbst priorisieren.
- **Mobil schwer bedienbar.** Breite Tabellen mit vielen Spalten sind am Handy mühsam (horizontales Scrollen, winzige Trefferflächen). Es gibt keine für kleine Bildschirme gedachte Navigation.
- **GuV nur monatsweise.** Die Wirtschaftlichkeit lässt sich praktisch nur für einen einzelnen Monat ansehen. Quartals-, Jahres- oder freie Zeitraum-Auswertungen, die für Steuer, Trend und Saisonvergleich nötig sind, fehlen.
- **Keine grafische Slot-Pflege.** Die Zuordnung von Produkten zu Slots erfolgt über Formulare/Tabellen. Es gibt kein visuelles Abbild des Automaten mit seinen Etagen, in dem man Produkte einfach platziert.
- **Keine Drehzahl-Sicht.** Es ist nicht auf einen Blick erkennbar, welche Produkte Renner und welche Ladenhüter sind. Slow-Mover binden Kapital und MHD-Risiko, ohne dass das System darauf hinweist.
- **Wenig Filter/Visualisierung.** Tabellen lassen sich kaum filtern, und es fehlen kompakte Diagramme, die Zahlen sofort lesbar machen.

Wichtig: v2 funktioniert und ist im Einsatz. Es darf durch die Lösung nicht gefährdet werden.

## Solution

Ein **neues, additives Frontend „v3"** unter eigener Route, mobile-first konzipiert, als **echtes Multi-Page-Erlebnis** (jeder Screen eine eigene Ansicht/Route mit eigenem Datenladevorgang — kein Anchor-Scrolling auf einer Endlosseite). Die Shell zeigt am Handy eine **Bottom-Navigation**, am Desktop eine **Seitenleiste**. Inhalte werden bevorzugt als **Karten** dargestellt statt als breite Endlos-Tabellen.

v3 wird **streng additiv** ergänzt: Eine neue Route liefert eine neue Einstiegsseite aus neuen, eigenständigen Frontend-Dateien aus. Das bestehende v2 und der Legacy-Einstieg bleiben unverändert als Fallback bestehen. Alle Daten kommen aus den **bereits vorhandenen `/api/v2/*`-Endpunkten**; das Backend wird nur dort erweitert, wo neue Features es erfordern, und ausschließlich **rückwärtskompatibel** (bestehende Aufrufe verhalten sich unverändert). Damit ist das Risiko für den Bestand minimal.

Sieben Seiten bilden die fachlichen Bereiche ab:

1. **Heute / Cockpit** — KPI-Karten, Ampel (kritisch/Warnung/OK), die *drei wichtigsten* Handlungsbedarfe statt der kompletten Liste.
2. **GuV & KPI** — Zeitraum-Auswahl (Monat/Quartal/Jahr/eigener Zeitraum), Umsatz-/GuV-/Marge-Diagramme, filterbare Top-N-Tabelle.
3. **Bestand & MHD** — Bestände, Mindesthaltbarkeit, Warnungen.
4. **Sortiment & Slots** — Sortimentsübersicht plus grafischer **Drag-&-Drop Slot-Editor** mit Etagen-Layout.
5. **Monitoring** — Betriebs-/Zustandsüberwachung.
6. **Produkt-Onboarding** — Neuprodukte aufnehmen und in Slots bringen.
7. **Automaten** — Automaten- und Standortprofile.

Querschnittlich erhalten die Seiten eine **leichtgewichtige, wiederverwendbare SVG-Diagramm-Komponente** und ein **einheitliches Filter-Konzept**: Jede Datentabelle bekommt Filter und ein adaptierbares Diagramm. Neue Kernfähigkeiten: der grafische Slot-Editor, die erweiterte GuV-Zeitraumlogik und eine **Umschlag-/Slow-Mover-Klassifikation** mit sichtbaren Badges.

---

## User Stories

### Shell, Navigation, Querschnitt

1. Als Betreiberin möchte ich v3 über eine eigene, stabile Route aufrufen, sodass ich die neue Oberfläche nutzen kann, ohne dass das bewährte v2 verschwindet oder sich ändert.
2. Als mobile Nutzerin möchte ich am Handy eine Bottom-Navigation mit den Hauptbereichen sehen, sodass ich mit dem Daumen schnell zwischen Seiten wechseln kann.
3. Als Desktop-Nutzerin möchte ich am großen Bildschirm eine Seitenleiste statt einer Bottom-Bar sehen, sodass die Navigation den Inhaltsbereich nicht verkleinert.
4. Als Nutzerin möchte ich, dass jeder Bereich eine eigene Ansicht/Route ist und seine Daten beim Öffnen lädt, sodass ich gezielt eine Seite teilen, neu laden oder per Zurück-Geste navigieren kann.
5. Als Nutzerin möchte ich, dass eine geöffnete Seite ihren Lade-, Leer- und Fehlerzustand klar anzeigt, sodass ich erkenne, ob Daten kommen, keine vorhanden sind oder etwas schiefging.
6. Als Nutzerin möchte ich Inhalte bevorzugt als Karten sehen, sodass ich am Handy nicht horizontal durch breite Tabellen scrollen muss.
7. Als Nutzerin möchte ich, dass jede Datentabelle Filter besitzt, sodass ich große Datenmengen schnell auf das Relevante eingrenzen kann.
8. Als Nutzerin möchte ich neben Tabellen ein kompaktes, an die Daten anpassbares Diagramm sehen, sodass ich Trends und Verhältnisse sofort erfasse, ohne Zahlen im Kopf zu vergleichen.

### Seite 1 — Heute / Cockpit

9. Als Betreiberin möchte ich beim Öffnen sofort die wichtigsten KPI-Karten sehen, sodass ich den Gesamtzustand auf einen Blick erfasse.
10. Als Betreiberin möchte ich eine Ampel (kritisch/Warnung/OK) sehen, sodass ich ohne Lesen erkenne, wie dringend die Lage ist.
11. Als Betreiberin möchte ich statt der kompletten Slot-Liste nur die drei wichtigsten Handlungsbedarfe sehen, sodass ich sofort weiß, was zuerst zu tun ist.
12. Als Betreiberin möchte ich von einem Handlungsbedarf direkt in die passende Detailseite springen, sodass ich ohne Umwege handeln kann.

### Seite 2 — GuV & KPI

13. Als Betreiberin möchte ich den Auswertungszeitraum als Monat, Quartal, Jahr oder freien Zeitraum wählen, sodass ich kurzfristige und langfristige Entwicklungen analysieren kann.
14. Als Betreiberin möchte ich Umsatz, Deckungsbeitrag/GuV und Marge als Diagramme über den gewählten Zeitraum sehen, sodass ich Entwicklungen und Ausreißer schnell erkenne.
15. Als Betreiberin möchte ich eine filterbare Top-N-Tabelle der wirtschaftlich relevantesten Slots/Produkte sehen, sodass ich die größten Hebel identifiziere.
16. Als bestehende Nutzerin möchte ich, dass die bisherige Monatsauswertung unverändert weiterfunktioniert, sodass meine gewohnten Auswertungen erhalten bleiben.

### Seite 3 — Bestand & MHD

17. Als Betreiberin möchte ich Bestände und Mindesthaltbarkeitsdaten übersichtlich in Karten sehen, sodass ich kritische Chargen schnell erkenne.
18. Als Betreiberin möchte ich Bestands-/MHD-Einträge filtern (z. B. nach Dringlichkeit, Automat, Produkt), sodass ich gezielt auf das reagiere, was bald abläuft oder knapp wird.

### Seite 4 — Sortiment & Slots (inkl. Slot-Editor)

19. Als Betreiberin möchte ich das Sortiment je Automat als Übersicht sehen, sodass ich erkenne, welche Slots belegt oder frei sind.
20. Als Betreiberin möchte ich den Automaten grafisch nach Etagen aufgebaut sehen (oberste Etage oben), sodass das Bild dem realen Gerät entspricht.
21. Als Betreiberin möchte ich Produkte als kleine ziehbare Kacheln aus einer Palette wählen, sodass ich ohne Tippen von Codes arbeiten kann.
22. Als Betreiberin möchte ich eine Produktkachel per Drag-&-Drop auf einen Slot ziehen, sodass die Zuordnung über den bestehenden Vorgang ausgelöst wird.
23. Als Betreiberin möchte ich vor dem Bestätigen eine Vorschau der Slot-Zuordnung sehen, sodass ich Fehlplatzierungen vor dem Speichern erkenne.
24. Als Betreiberin möchte ich die Produkt-Palette aus der vorhandenen Produkt-/Refill-Suche befüllen und durchsuchen, sodass ich passende Produkte schnell finde.
25. Als Betreiberin möchte ich, dass die per Editor gesetzte Position erhalten bleibt, sodass das Etagen-Layout beim erneuten Öffnen wieder korrekt aussieht.
26. Als Betreiberin möchte ich am Handy eine sinnvolle Alternative zum reinen Ziehen haben (z. B. Antippen von Quelle und Ziel), sodass der Editor auch ohne Maus bedienbar ist.

### Seite 5 — Monitoring

27. Als Betreiberin möchte ich den Betriebs-/Zustandsstatus übersichtlich sehen, sodass ich Auffälligkeiten früh bemerke.
28. Als Betreiberin möchte ich Monitoring-Einträge filtern und kompakt visualisiert sehen, sodass ich Muster über Automaten hinweg erkenne.

### Seite 6 — Produkt-Onboarding

29. Als Betreiberin möchte ich ein neues Produkt erfassen und den Onboarding-Vorgang starten, sodass es ins System aufgenommen wird.
30. Als Betreiberin möchte ich im Onboarding eine geführte Reihenfolge mit klaren Schritten und Rückmeldungen haben, sodass ich kein Pflichtfeld übersehe.
31. Als Betreiberin möchte ich ein frisch angelegtes Produkt direkt einem Slot zuordnen können, sodass der Weg von Aufnahme zu Verkaufsbereitschaft kurz ist.

### Seite 7 — Automaten

32. Als Betreiberin möchte ich Automaten- und Standortprofile übersichtlich sehen, sodass ich Stammdaten und Zuordnungen im Blick habe.
33. Als Betreiberin möchte ich von einem Automaten in seine Slot-Ansicht springen, sodass ich vom Geräteprofil schnell zur Bestückung komme.

### Umschlag / Slow-Mover-Klassifikation (querschnittlich)

34. Als Betreiberin möchte ich pro Slot/Automat sehen, wie schnell ein Produkt dreht, sodass ich Renner und Ladenhüter unterscheide.
35. Als Betreiberin möchte ich eine klare Klassifikation (Renner / Normal / Langsam-Dreher / Ladenhüter) als Badge sehen, sodass ich ohne Zahlen sofort handeln kann.
36. Als Betreiberin möchte ich, dass ein Produkt ohne Verkauf seit mindestens 30 Tagen eindeutig als Ladenhüter markiert ist, sodass ich totes Kapital und MHD-Risiko gezielt auflöse.
37. Als Betreiberin möchte ich nach Drehzahl-Klasse filtern, sodass ich z. B. gezielt alle Ladenhüter eines Automaten bearbeite.

### Verlässlichkeit / Hygiene

38. Als Betreiberin möchte ich, dass deutsche Umlaute und Sonderzeichen in v3 überall korrekt dargestellt werden, sodass keine kaputten Zeichen entstehen.
39. Als Entwicklerin möchte ich, dass die bestehenden Tests grün bleiben, sodass v3 nachweislich nichts am Bestand bricht.

---

## Implementation Decisions

### Leitprinzipien

- **Additiv, null Risiko für Bestand.** v3 ist eine *zusätzliche* Oberfläche neben v2. Bestehende Routen, Dateien und Endpunkte bleiben unverändert. Backend-Änderungen sind ausschließlich additiv und rückwärtskompatibel.
- **Bestehende Deep-Module-Architektur fortführen.** Fachlogik bleibt in den vorhandenen Deep Modules je Bereich; HTTP-Handler bleiben dünn. Neue Logik wird in bestehende Module additiv ergänzt oder, falls fachlich eigenständig, als neues Deep Module nach demselben Muster angelegt.
- **PostgreSQL ist primär.** Wie in v2 gibt es für die neuen v3-Daten **keinen** Sheet-/Legacy-Fallback. Antworten folgen dem etablierten v2-Fehler-/Antwort-Umschlag (u. a. `ok`, Bereichs- und Quellenkennung, Fehlercode, Erzeugungszeitpunkt).

### Routing & neue Frontend-Auslieferung

- Eine **neue Route für v3** wird nach demselben Muster wie die bestehende v2-Sonderroute ergänzt: Der Static-Serve-Pfad mappt den v3-Einstiegspfad auf die neue v3-Einstiegsdatei, und v3-Unterpfade (Deep Links auf einzelne Seiten) werden auf dieselbe Einstiegsdatei gemappt — analog zur bereits vorhandenen Behandlung der v2-Unterpfade. Die bestehende v2-Sonderroute und der Legacy-Einstieg (`/`) bleiben Zeichen für Zeichen unverändert.
- v3 erhält **eigene, neue statische Dateien** (Einstiegs-Markup, Skript, Stylesheet), gern modular aufgeteilt. Sie liegen neben den v2-Dateien im selben statischen Ausgabeverzeichnis und werden über den bestehenden Static-Serve-Mechanismus (inkl. MIME-Erkennung über Dateiendung und Path-Traversal-Schutz) ausgeliefert. Es ist **kein** neuer Server-Mechanismus nötig.
- Die bestehende MIME-Zuordnung deckt HTML/CSS/JS (jeweils mit `charset=utf-8`) sowie SVG/PNG/Fonts ab. Werden für v3 zusätzliche Dateitypen verwendet, ist die MIME-Zuordnung additiv zu ergänzen.

### Frontend-Architektur v3

- **Echtes Multi-Page innerhalb der SPA-Shell.** Jeder der sieben Bereiche ist eine eigene Ansicht/Route. Beim Wechsel wird die zugehörige Seite gerendert und lädt ihre Daten gezielt (kein gemeinsames Laden aller Bereiche, kein Anchor-Scrolling). Tiefe Verlinkung pro Seite muss möglich sein.
- **Responsive Shell.** Eine gemeinsame Shell stellt unterhalb eines Breakpoints eine Bottom-Navigation und oberhalb eine Seitenleiste bereit. Der Inhaltsbereich ist identisch; nur das Navigations-Chrome wechselt.
- **Karten-orientierte Darstellung.** Listen/Datenmengen werden bevorzugt als Karten gerendert; tabellarische Darstellungen sind erlaubt, müssen aber mobil sinnvoll umbrechen/scrollen und mit Filtern kombiniert sein.
- **Zustände als Standard.** Jede Seite implementiert Lade-, Leer- und Fehlerzustand einheitlich.

### Wiederverwendbare SVG-Diagramm-Komponente

- Eine **leichtgewichtige, framework-freie** Diagramm-Komponente wird gebaut (reines SVG, keine schwere Charting-Bibliothek). Sie ist datengetrieben und auf mehreren Seiten wiederverwendbar (mindestens Zeitreihen für GuV/Umsatz/Marge sowie Verteilungs-/Vergleichsdarstellungen für Tabellen).
- Die Komponente arbeitet mit dem **gemeinsamen Filter-Konzept** zusammen: Eine gefilterte Tabelle und ihr Diagramm zeigen denselben Datenausschnitt.

### Backend-Erweiterungen (alle rückwärtskompatibel)

1. **GuV-Zeitraum (Economics).**
   Das Economics-Deep-Module und der zugehörige Endpunkt werden so erweitert, dass neben dem bisherigen **Einzelmonat** auch **Quartal**, **Jahr** und **eigener Zeitraum** ausgewertet werden können. Das Modul kennt bereits ein Zeitraum-Konzept mit Von/Bis-Grenzen sowie eine Vorgabe auf den aktuellen Monat, wenn keine gültigen Grenzen übergeben werden; die Erweiterung baut additiv darauf auf. Neue, optionale Eingaben (Zeitraum-Modus bzw. Von/Bis) erweitern das Verhalten; fehlen sie, verhält sich der Endpunkt exakt wie bisher (Einzelmonat). Die bestehende Modul-Signatur wird nur additiv um optionale Optionen ergänzt, sodass vorhandene Aufrufe und Tests unverändert gültig bleiben. Die Ausgabe ergänzt zeitraumbezogene Reihen/Aggregate, ohne bestehende Felder zu entfernen oder umzubenennen.

2. **Slot-Position persistieren (für Etagen-Editor).**
   Damit der grafische Editor das Etagen-Layout zuverlässig rekonstruieren kann, wird die **Position eines Slots** rückwärtskompatibel persistierbar gemacht. Die Position leitet sich aus dem bestehenden Slot-Code-Schema ab (erste MDB-Ziffer = Etage, oberste Etage zuerst; folgende Ziffern = Position in der Etage). Sofern keine explizit gespeicherte Position vorliegt, wird sie aus dem Slot-Code abgeleitet, sodass Bestandsdaten ohne Migration korrekt dargestellt werden. Die Slot-Zuordnung selbst läuft weiterhin über den **bestehenden Slot-Assign-Vorgang** (Vorschau/Bestätigung) inklusive des etablierten idempotenten Zuordnungsschlüssels; der Editor ist nur eine grafische Hülle darüber und führt keinen eigenen Schreibpfad ein.

3. **Umschlag-/Slow-Mover-Klassifikation.**
   Eine Drehzahl-Berechnung wird im Backend ergänzt — als additive Funktion in einem passenden bestehenden Deep Module oder als neues Deep Module nach demselben Muster. Sie liefert pro Slot/Automat eine Kennzahl und eine Klasse, die das Frontend als Badge anzeigt. Festlegungen:
   - **Granularität:** Drehzahl pro **Slot/Automat** (nicht global pro Produkt).
   - **Verfahren:** **quartilbasiert**. Die obersten Slots nach Drehzahl sind **Renner** (oberstes Quartil), die untersten **Langsam-Dreher** (unterstes Quartil), dazwischen **Normal**.
   - **Sonderklasse Ladenhüter:** **0 Verkäufe seit ≥ 30 Tagen** → eindeutig **Ladenhüter**, unabhängig von der Quartilseinordnung.
   - Klassifikationslogik liegt im Backend; das Frontend interpretiert nur die gelieferte Klasse.

### Datenquellen & Endpunkte

- v3 nutzt die **vorhandenen `/api/v2/*`-Endpunkte** je Bereich (Übersicht, Bestand/MHD, Economics, Sortiment/Slots, Monitoring, Onboarding inkl. Start, Slot-Assign-Vorschau/Bestätigung, Slot-Change-Vorschau/Bestätigung, Maschinenprofile, Standorte, Korrekturfälle, Korrektur-Aktion-Vorschlag/Bestätigung, Refill-Suche/Details/Auslösen, Report-Export).
- Die Produkt-Palette des Slot-Editors speist sich aus der **vorhandenen Produkt-/Refill-Suche**.
- Wo neue Felder/Reihen benötigt werden (Zeitraum-Aggregate, Slot-Position, Drehzahl-Klasse), werden bestehende Antworten **additiv** erweitert oder über additive Parameter angereichert.

### Begriffs-Festschreibung (Ubiquitous Language)

- Die Definitionen für **Renner / Normal / Langsam-Dreher / Ladenhüter** sowie für die quartilbasierte Drehzahl pro Slot/Automat werden im Domänen-Glossar (`docs/UBIQUITOUS_LANGUAGE.md`) verbindlich festgeschrieben. Das Glossar existiert derzeit nicht; es ist im Rahmen dieser Phase **anzulegen** und mit diesen Begriffen zu füllen, damit Backend, Frontend und Doku denselben Wortschatz verwenden. Bereits gelebte Begriffe (z. B. das MDB-Slot-Code-Schema, Etagen-Konvention oberste Reihe zuerst, Deckungsbeitrag/Marge) werden mit aufgenommen.

### UTF-8-Hygiene

- Befund der Encoding-Prüfung: Die heutigen Live-Frontend-Dateien (v2-Markup/Skript/Style sowie Legacy) sind durchgängig **valides UTF-8 ohne BOM** mit Windows-Zeilenenden (CRLF); deutsche Umlaute stehen als echte UTF-8-Zeichen direkt im Quelltext, und die Auslieferung setzt für HTML/CSS/JS bereits `charset=utf-8`. Es liegt also **keine** bestehende Encoding-Korruption vor, die zu reparieren wäre.
- v3 folgt demselben bewährten Muster: Die v3-Quelldateien werden **als UTF-8 ohne BOM** angelegt und gehalten, mit echten Umlauten im Quelltext. Zur Absicherung über Editoren, Git-Checkouts und Deploys hinweg werden **präventiv** projektweite `.editorconfig`- und `.gitattributes`-Regeln ergänzt, die UTF-8 und konsistente Zeilenenden für die Quelldateien festschreiben. Diese Maßnahme ist Vorsorge (nicht Reparatur) und betrifft nur Konfiguration, keinen Bestandscode.

### Visual Direction

Stil: **„Warm-Paper Operational Clarity"** — ruhig, warm, betrieblich klar, mit Fokus auf schnelle Erfassbarkeit am Handy.

- **Farbflächen:** warmer Papier-Hintergrund (#F6F3EC), weiße Karten (#FFFFFF), Text-Ink #17181C.
- **Akzent:** Brand-Violett, hell und logo-treu. Der exakte Token-Wert ist noch festzulegen (Richtwert ~#6D3A9C); er wird als zentraler Design-Token definiert und überall referenziert, damit eine spätere Feinjustierung an einer Stelle genügt.
- **Statusfarben (Ampel):** OK #15803D, Warnung #B45309, kritisch #B91C1C. Diese Farben tragen die Cockpit-Ampel, Status-Badges und die Drehzahl-/MHD-Hervorhebungen.
- **Typografie:** Display „Bricolage Grotesque", Fließtext „Hanken Grotesk".
- **Ziffern:** tabellarische Ziffern **ohne Strich durch die Null** (`font-variant-numeric: tabular-nums;` und `font-feature-settings: "tnum" 1, "zero" 0;`), damit Kennzahlen sauber untereinander stehen und Nullen nicht durchgestrichen erscheinen.
- **System-Bausteine:** einheitliches Karten- und Spacing-System; KPI-Karten; Ampel-Status; kompakte SVG-Diagramme; Etagen-Slot-Kacheln (Automat als Stapel von Etagen, oberste Etage oben, ziehbare Produktkacheln). Die Komponenten sind so gestaltet, dass sie auf kleinen Bildschirmen mit Daumen bedienbar sind (ausreichend große Trefferflächen) und auf großen Bildschirmen ruhig wirken.
- Eine Referenz-Style-Tile existiert lokal unter `C:/tmp/design/` und dient ausschließlich als **Inspiration**; sie wird nicht eingebunden oder kopiert.

---

## Testing Decisions

Grundsatz wie im bestehenden Projekt: **Tests prüfen externes Verhalten, nicht Implementierungsdetails.** Sie liegen unter `dashboard/tests/` und laufen mit `node --test`. Alle bestehenden Tests müssen grün bleiben — das ist der Hauptnachweis dafür, dass v3 additiv und rückwärtskompatibel ist.

Was gute Tests hier ausmacht:

- **Deep-Module-Tests pro neuer/erweiterter Fachlogik**, analog zu den vorhandenen Modul-Tests: reine Funktionen mit klar definiertem Input/Output, ohne DB- oder HTTP-Abhängigkeit (so wie die bestehenden `buildEconomicsData`- bzw. Slot-Assign-Tests).
  - *Economics-Zeitraum:* Gleiche Eingaben mit nur Einzelmonat liefern weiterhin exakt das bisherige Ergebnis (Rückwärtskompatibilität als expliziter Testfall, inkl. der bestehenden Vorgabe auf den aktuellen Monat). Zusätzliche Fälle für Quartal, Jahr und eigenen Zeitraum prüfen die korrekte Aggregation über die jeweiligen Zeitspannen sowie Grenzfälle (leerer Zeitraum, Zeitraum ohne Daten, Zeitraumgrenzen).
  - *Drehzahl-/Slow-Mover-Klassifikation:* quartilbasierte Einordnung (Renner/Normal/Langsam-Dreher) anhand kontrollierter Eingaben; Ladenhüter-Regel (0 Verkäufe seit ≥ 30 Tagen) inklusive Grenzfall genau bei 30 Tagen; Verhalten bei zu wenigen Datenpunkten für sinnvolle Quartile; Granularität pro Slot/Automat.
  - *Slot-Position-Ableitung:* aus dem MDB-Slot-Code abgeleitete Etage/Position (oberste Etage zuerst); explizit gespeicherte Position hat Vorrang vor der Ableitung; Bestandsdaten ohne gespeicherte Position werden korrekt eingeordnet.
- **HTTP-/Routing-Tests** in der Art der bestehenden In-Process-Server-Tests (Server starten, Statuscodes und Antwort-Umschlag prüfen):
  - Der v3-Einstiegspfad und v3-Deep-Links liefern die v3-Einstiegsseite aus; die v2- und Legacy-Routen verhalten sich unverändert.
  - Die erweiterten Endpunkte antworten bei **fehlenden neuen Parametern** unverändert (Bestandsverhalten) und bei gesetzten neuen Parametern mit der additiv ergänzten Antwortform; die etablierten Fehlerverträge bleiben gültig (z. B. Datenquelle nicht erreichbar/​unkonfiguriert, Schreibzugriff für Gäste verboten, fehlende Pflichtfelder, unbekannte Pfade → jeweils erwarteter Statuscode und Fehlercode im Umschlag).
  - Der Slot-Editor löst keinen neuen Schreibpfad aus: Tests stellen sicher, dass die Zuordnung über den bestehenden Slot-Assign-Vorschau-/Bestätigungs-Vorgang läuft und kein zusätzlicher Roh-Schreib-Endpunkt existiert.
- **Was nicht getestet wird:** interne Render-/DOM-Details der SPA, exakte Pixel/Styles, konkrete Funktions- oder Variablennamen. Stattdessen wird auf Vertrags- und Verhaltensebene getestet (Eingabe → erwartete fachliche Ausgabe, Endpunkt → erwartete Form/Status). Wo das Projekt heute Frontend-Vorhandensein über statische Datei-Checks absichert, kann v3 demselben Muster folgen.
- Jedes neue oder erweiterte Deep Module erhält eine korrespondierende `*.test.js`-Datei nach dem vorhandenen Namens- und Aufbaumuster.

---

## Out of Scope

- **Umbau/Ablösung von v2 oder Legacy-`/`.** v3 ersetzt nichts; beide bleiben als Fallback unverändert.
- **Nicht rückwärtskompatible Backend-Änderungen.** Keine Umbenennung/Entfernung bestehender Felder, Parameter oder Endpunkte.
- **Sheet-/Legacy-Datenfallbacks für v3-Daten.** PostgreSQL bleibt alleinige Quelle.
- **Schwergewichtige Frontend-Frameworks oder Charting-Bibliotheken.** Die Diagramm-Komponente bleibt leichtgewichtiges, selbstgebautes SVG.
- **Klon-Hygiene (separat zu behandeln).** Es existieren mehrere lokale Klone desselben Repos. `mein-erstes-Projekt` ist der Live-Stand; weitere Klone unter `Documents/automatenlager` und unter `Documents/Codex/...` sind **veraltet**. Diese sind außerhalb von v3 aufzuräumen/zusammenzuführen und dürfen im Rahmen von v3 nicht angefasst werden. (Risiko: versehentliches Arbeiten im falschen Klon → verlorene oder widersprüchliche Änderungen.)
- **Deploy-Drift auf dem HP Mini (separat zu klären).** Das auf dem Mini ausgelieferte v2-Skript weicht in der Größe vom committeten Stand im Repo ab. Vor bzw. unabhängig von v3 ist zu prüfen, ob auf dem Mini un-committete Änderungen liegen, die zurück ins Repo gehören. (Risiko: Quelle der Wahrheit unklar; v3-Arbeit könnte auf einem nicht im Repo gespiegelten Stand aufsetzen.) Nicht Teil dieses v3-Auftrags.

---

## Further Notes

- **Begriffs-Glossar zuerst nutzbar machen.** Da `docs/UBIQUITOUS_LANGUAGE.md` noch nicht existiert, sollte es früh in der Umsetzung angelegt werden, damit die Drehzahl-/Slow-Mover-Begriffe und das Etagen-/Slot-Schema von Anfang an einheitlich verwendet werden.
- **Mobile Bedienbarkeit des Slot-Editors.** Drag-&-Drop ist die Leitinteraktion; für Touch-Geräte ohne präzises Ziehen ist eine gleichwertige Tap-Quelle-dann-Tap-Ziel-Bedienung vorzusehen, damit der Editor am Handy nutzbar bleibt.
- **Token-Disziplin für den Brand-Akzent.** Der noch festzulegende exakte Violett-Wert sollte als einziger zentraler Token gepflegt werden, damit die spätere logo-treue Feinjustierung an einer Stelle geschieht.
- **Logo (niedrige Priorität).** Das echte Faltrix-Logo (sauber freigestelltes, transparentes PNG) soll im v3-Header anstelle des aktuellen Platzhalters eingebaut werden — eine kleine optische Verbesserung, niedrige Priorität.
