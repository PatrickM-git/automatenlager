# Marketing, Vertrieb & Preismodell — v1

> Stand 2026-06-11. Grundlage: zwei Web-Recherchen (Wettbewerbs-Pricing + Pain-Points
> von Automatenbetreibern, DACH + US-Proxy) mit Quellen. Lebendes Dokument; wird vor
> Phase C in eine SPEC überführt. Verankerung: `docs/ROADMAP.md` Phase C.

## 1. Marktlage (Recherche-Synthese)

| Anbieter | Modell | Preis-Anker | Schwäche für unseren Zielkunden |
|---|---|---|---|
| VendSoft (US) | SaaS-Staffeln | $19/Mt (5 Automaten) · $49 (30) · $199 (120), +$1,50/Automat | Null DACH-Compliance (kein DATEV, keine 7/19 %-Logik), schwaches Reporting |
| Cantaloupe Seed (US) | Bundle/Abo | Reader-Bundle ab $18,95/Gerät/Mt (36-Mt-Vertrag); Software „auf Anfrage" | teuer, Vertragsbindung, Gerätezwang, Support-Beschwerden (BBB „D-") |
| Nayax (Core/MoMa) | Geräte-Abo | DE ≈ 14 €/Gerät/Mt inkl. Payment; Management-Aufpreis nur ~$2 | Telemetrie-zentriert; keine deutsche Finanzbuchhaltung/GuV |
| Televend (HR) | HW + Abo | DACH-Händler: 12 €/Automat/Mt + 489–1.000 € HW + 250 € Registrierung | Hardware-gebunden, Enterprise-Fokus |
| Vendon (LV) | HW + Abo | auf Anfrage (vBox Pflicht) | proprietäre Hardware, intransparent |
| 4Vending/Vendidata (DE) | Kauflizenz on-prem | 8.900 € einmalig + 12 %/Jahr Wartung (~25–30 €/Automat/Mt über 5 J.) | für 1–50-Automaten-Betreiber unerreichbar; Windows/on-prem |

**Strukturelle Marktlücke:** Den deutschen Betreiber mit 1–50 Automaten bedient niemand
mit *Cloud + DACH-Compliance + fairem Preis*. US-Tools sind billig, können aber kein
deutsches Steuerrecht; DACH-Tools sind Enterprise/on-prem. Die reine Software-Schicht ist
brutal günstig bepreist ($1–3/Automat) — **Differenzierung läuft über Finanzen/Compliance
(GuV, GoBD, DATEV, Kleinunternehmer, Pfand, MHD), nicht über Telemetrie-Commodity.**
Genau das ist unser vorhandener Stack.

## 2. Positionierung (Arbeitshypothese)

> **„Das deutsche Betriebssystem für Automatenbetreiber ab dem 3. Automaten —
> steuerfest (GoBD/DATEV), MHD-sicher (FIFO), ohne Hardware-Zwang, unter 50 €/Monat."**

Kernbotschaften je Schmerz: (a) „Bist du kassensturzfähig je Automat?" (BFH-Pflicht,
software-lösbar), (b) „Wie viel Geld läuft dir per MHD ab?", (c) „Buchst du 7 % und 19 %
produktgenau?", (d) „Weißt du, welcher Standort sich lohnt?".

## 3. Preismodell (Vorschlag)

Hybrid aus Basispreis + Automaten-Staffel (Benchmark: über VendSoft wegen
Compliance-Mehrwert, deutlich unter den 10–15 €/Automat der HW-Bundles):

| Plan | Preis (zzgl. USt) | Inklusive | Gedacht für |
|---|---|---|---|
| **Start** | **0 €** (dauerhaft) | bis 2 Automaten, 1 Nutzer, GuV-Basis, MHD-Warnung, manuelle Erfassung | Einsteiger/Hobby → Akquise-Funnel |
| **Betreiber** | **39 €/Mt** | bis 10 Automaten, dann +3 €/Automat; Nayax-Anbindung, FIFO/MHD, GuV inkl. Kleinunternehmer-Logik, KI-Rechnungseingang (50 Belege/Mt), Pickliste, DATEV-Export | Kernzielgruppe 3–25 Automaten |
| **Flotte** | **129 €/Mt** | bis 40 Automaten, dann +2,50 €/Automat; Multi-User + Rollen, Provisionsabrechnung Standortgeber, Schwund-Radar, Par-Level/Prognosen, API, Prio-Support | 25–150 Automaten |
| Enterprise | auf Anfrage | White-Label, SSO, SLA | Franchises/Großbetreiber, später |

- Jahreszahlung = 2 Monate geschenkt (Branchenstandard). 14 Tage Trial ohne Kreditkarte
  (VendSoft-Benchmark). Beta-/Gründungskunden: lebenslanger Rabatt gegen Testimonial.
- Preis-Rechenprobe Kernkunde (10 Automaten, Betreiber-Plan): 39 €/Mt ≈ 3,90 €/Automat —
  klar unter Televend/Nayax-Bundles, klar über VendSoft, gerechtfertigt durch
  GuV/Steuer/OCR, die dort fehlen.
- Abrechnung: Stripe Subscriptions; Alternative Paddle/Lemon Squeezy als
  Merchant-of-Record (nimmt EU-USt-Komplexität ab) — Entscheidung in C1.

## 4. Feature-Gating — Entscheidung

**Jetzt nur verankern, später durchsetzen.** Konkret:

1. **Sofort billig (bei nächster passender Migration):** `tenants.plan TEXT NOT NULL
   DEFAULT 'beta'` + ein Entitlement-Hook an der bestehenden Capability-Schicht
   (`lib/auth.js` kennt Rollen-Capabilities; Entitlements je Mandant sind die zweite,
   orthogonale Achse). Kein UI, keine Durchsetzung — nur die Stelle, an der später
   geprüft wird.
2. **Durchsetzung erst mit C1 (Stripe):** Plan-Wechsel-Flows, Limits (Automaten-Anzahl,
   OCR-Kontingent), Upgrade-Hinweise im UI.
3. **Gate-Kandidaten (branchenüblich + eigene USPs):** Multi-User/Rollen, API/BI-Export,
   Prognosen/Par-Level, Provisionsabrechnung, Schwund-Radar, OCR-Belege-Kontingent,
   Automaten-Anzahl. **Nie gaten:** Datenexport (DSGVO/Lock-in-Fairness), Basis-GuV.

Begründung: früh verankert kostet es Minuten; nachträglich durch alle Endpunkte gezogen
kostet es Wochen. Aber Durchsetzung vor Billing wäre totes Gewicht.

## 5. Pain-Point-Features mit USP-Potenzial (aus Recherche, auf den Stack gemappt)

| # | Feature | Löst Pain | Aufsetzpunkt im Code | Wettbewerb |
|---|---|---|---|---|
| 1 | **GoBD-Leerungsprotokoll** („Betriebsprüfungs-Modus"): geführter Workflow je Bargeld-Leerung (Zählprotokoll, Zählwerkstand, Foto, Soll-Ist vs. Telemetrie), unveränderlich + DATEV | BFH: jeder Automat = eigene Kasse; sonst Schätzung + Zuschläge | `audit.*`-Schema existiert | im Kleinsegment **niemand** |
| 2 | **Soll-Ist-Schwund-Radar**: Nayax-Verkäufe vs. FIFO-Entnahmen vs. Leerungsbeträge je Route/Fahrer | Diebstahl/Unterschlagung (2–4 % Umsatz) | sales + stock_movements vorhanden | auf Capterra explizit gewünscht, ungelöst |
| 3 | **MHD-Geld-Ampel**: „Charge läuft in 14 T ab, Abverkaufswahrscheinlichkeit 40 % → umlagern/Preis senken" — in € | MHD-Schwund | Branchen-Anker liefert Drehzahl, FIFO die Chargen | einzigartig (kein Tool hat FIFO+MHD) |
| 4 | **Kleinunternehmer-Grenzwächter**: Live-Hochrechnung gegen 25k/100k (harte Grenze seit 2025) mit Margen-Szenario | Steuer-Schock unterjährig | Kleinunternehmer-GuV existiert | **niemand** |
| 5 | **Provisionsabrechnung Standortgeber**: Vertragsmodell je Standort (%-Umsatz/Fix/Misch) → monatliches Nachweis-PDF | manuelle, fehleranfällige Abrechnung | locations + guv_daily | nur 4Vending-Enterprise |
| 6 | **Standort-P&L-Scorecard**: Vollkosten (Energie 560–1.250 €/J, Provision, Fahrzeit) je Standort → „ausbauen/verhandeln/kündigen" | „Lohnt sich der Standort?" (wörtliche Forum-Frage) | economics/guv je Maschine vorhanden | schwach besetzt |
| 7 | **Pickliste 2.0 / Prekitting**: Kommissionier-Vorschlag je Tour aus Verkaufs-Drehzahl (Par-Level) | Blindflug-Befüllung (Pain #1), ~15 Min/Automat | Pickliste + Drehzahl vorhanden | im DACH-Kleinsegment konkurrenzlos |

Compliance-Fakten für Marketing (geprüft): **Warenautomaten sind von der TSE-Pflicht
ausgenommen** (§ 1 KassenSichV), aber **GoBD + Kassensturzfähigkeit je Automat gelten**
(BFH) — erklärungsbedürftig, also content-tauglich. USt produktgenau 7/19 %.
Kleinunternehmer-Grenze 25.000/100.000 € seit 2025 mit unterjährigem Sofort-Wechsel.

## 6. Funnels (skalierbar)

> **Umsetzungsreife Ausarbeitung — konkrete Artikel, E-Mail-Texte, Reel-Skripte,
> Ad-Motive, Partner-Pitches, KPIs und Zeitplan: `docs/business/funnel-playbook-v1.md`.**

1. **SEO-/Content-Funnel** (Kanal mit dem besten Fit, weil erklärungsbedürftige
   Compliance): Ratgeber-Artikel exakt auf die recherchierten Fragen
   („Kassensturzfähigkeit Automaten", „7 oder 19 % am Snackautomat",
   „Kleinunternehmer-Grenze 2025 Automaten", „Pfand DPG Automatengeschäft",
   „Lohnt sich der Standort?") → Lead-Magnet (GoBD-Checkliste, GuV-Excel-Vorlage)
   → E-Mail-Strecke → Trial.
2. **Free-Tool-Funnel:** kostenlose Mini-Rechner als eigene Landingpages —
   Standort-Rentabilitätsrechner, Kleinunternehmer-Grenzrechner, MHD-Verlustrechner.
   Jedes Tool ist ein abgespeckter Blick auf ein bestehendes Feature → Signup-CTA.
3. **Händler-/Affiliate-Funnel:** Automatenhändler & Nayax-Distributoren (vendy1,
   Hohenloher, Bornhoff, snackautomatenkaufen.de) empfehlen die Software beim
   Automatenkauf — Affiliate-Provision 20–30 % im ersten Jahr. Skaliert ohne eigenes
   Vertriebsteam und trifft Kunden exakt im Kaufmoment.
4. **Steuerberater-Funnel:** DATEV-Export + GoBD-Leerungsprotokoll machen das Tool zum
   Werkzeug, das Steuerberater ihren Automaten-Mandanten *empfehlen* (Multiplikator;
   ein Berater = viele Betreiber).
5. **Community-/Fan-Funnel:** vendingforum.de, Facebook-Gruppen, YouTube/TikTok-Creator
   im „Automaten-Business"-Trend (Kooperationen/Sponsoring); Free-Plan + Referral
   (1 Monat frei für beide Seiten) macht zufriedene Kleinbetreiber zu Fans, die in
   Gruppen organisch empfehlen — der Free-Plan ist das skalierbare Fan-Programm.

## 7. Kaltakquise (konkreter Ablauf)

- **Listenaufbau:** Google-Maps-Recherche („Snackautomat", „24h-Automat",
  „Automatenshop" je Stadt) + Instagram/TikTok-Hashtags (#automatenbusiness) +
  BDV-Umfeld + Aussteller-/Besucherlisten von Vending-Messen. Ziel: 300–500
  qualifizierte Betreiber-Kontakte.
- **Erstkontakt E-Mail (persönlich, kein Massen-Blast):** Problem-Hook statt Produkt —
  „Wussten Sie, dass das Finanzamt je Automat ein Zählprotokoll bei jeder Leerung
  erwartet? Wir haben das automatisiert." 3-Stufen-Sequenz (Hook → Fallstudie → Angebot).
- **Hook-Angebot:** kostenloser **„Automaten-Finanz-Check"** — wir importieren 3 Monate
  Nayax-Daten (Onboarding-Wizard macht das billig) und liefern GuV je Automat +
  Schwund-Auffälligkeiten + MHD-Risiko als PDF. Hoher wahrgenommener Wert, geringe
  Grenzkosten, direkter Produktbeweis.
- **Telefon-Nachfass** nur auf E-Mail-Öffner/Antworter; Insta-DM bei jungen Betreibern.
- **Messen/IHK:** EU-Vending-Messen (z. B. EVEX) und regionale IHK-Gründertage als
  Lern- und Listenkanal.
- Einordnung: Kaltakquise ist der **Lern-Kanal** (Positionierung schärfen, Einwände
  sammeln) für die ersten 10–30 Kunden — Skalierung kommt aus Funnels 1–4.

## 8. Playbook „schnell viele Kunden nach Phase B" (Reihenfolge)

1. **Beta-Programm** (5–10 Gründungskunden, lebenslanger Rabatt, Logo/Testimonial-Recht)
   — parallel zu Phase B akquirierbar via Kaltakquise/Forum.
2. **Launch-Paket:** Marketing-Site (C2) + 5 SEO-Säulen-Artikel + 2 Free-Tools +
   Self-Signup mit 14-Tage-Trial.
3. **Partner zünden:** 3–5 Händler-Affiliates + 2–3 Steuerberater-Kooperationen.
4. **Creator-Welle:** 2–3 YouTube-Reviews im Automaten-Business-Segment.
5. **Referral aktivieren**, sobald >30 aktive Kunden.
- **North-Star-Metrik: aktiv angebundene Automaten** (nicht Accounts).
  Erwartete CAC-Rangfolge: Partner < Content/SEO < Creator < Kaltakquise.

## 9. Offene Entscheidungen (vor C1/C2 klären)

- Produkt-/Markenname + Domain (aktuell intern „Automatenlager").
- Free-Plan ja/nein endgültig (Akquise-Power vs. Support-Last) — Empfehlung: ja, hart
  limitiert (2 Automaten, 1 Nutzer, Community-Support).
- Stripe direkt vs. Paddle (MoR) — steuerlicher Aufwand vs. Gebühren.
- Beta-Pricing: kostenlos gegen Feedback vs. symbolisch (z. B. 9 €) — Empfehlung:
  symbolisch (zahlende Beta-Kunden geben ehrlicheres Feedback).
