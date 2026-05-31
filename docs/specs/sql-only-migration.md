# SPEC: SQL-only-Migration — Google Sheets als Zwischenschicht ausklinken

Status: Entwurf · Erstellt 2026-05-31 · Umsetzung frühestens ab 08.06.2026
Bezug: Issue #10 (WF4 429), Issue #1 (Bestand-Drift), reference_nayax_fill_level

## Meine Empfehlung (kurz)

**Ja — die Migration ist sinnvoll, und die heutigen Befunde stützen das deutlich.**
Aber: **schrittweise, additiv, mit PG bereits als Single Source of Truth (SSoT) und
Google Sheets als read-only Fallback-Backup** — kein harter Schnitt. Begründung unten.

## Warum jetzt (Evidenz aus dieser Session)

1. **Google Sheets ist bereits jetzt der Fehlerpunkt.** WF4 schreibt seit 27.05. nicht
   mehr nach PG, Ursache ist ein **HTTP 429 (Quota/Rate-Limit) auf einem Sheets-Read**
   (Issue #10). Das ist kein Einzelfall, sondern eine strukturelle Schwäche: je mehr
   Workflows/Automaten, desto mehr Sheet-Calls, desto näher an der Quota.
2. **Doppelte Wahrheit erzeugt Drift.** Bestand lebt heute in Sheet UND PG; der Sync
   dazwischen (Sheet→PG via WF4) ist genau die Stelle, die bricht. Zwei Quellen, die
   auseinanderlaufen können = die Drift, die wir gerade messen (273 vs. 218).
3. **Nayax liefert die Wahrheit jetzt direkt** (`machineProducts`, On-Hand =
   PAR−MissingStockByMDB, live verifiziert). Damit kann PG direkt re-verankert werden —
   das Sheet als Zwischenstation für Bestand ist redundant geworden.
4. **Das Dashboard liest ohnehin schon aus PG** (`lib/assortment-slots.js`). Die
   Anzeige hängt also gar nicht am Sheet — nur die Schreibkette tut es noch.

## Warum NICHT „alles hart abschalten"

- Google Sheets ist heute zusätzlich **Audit-/Log-Layer und manuelle Notfall-Ansicht**.
  Wert behalten als **read-only Spiegel/Backup**, nicht ersatzlos kappen.
- WF1/WF2 (Rechnungen, Produktstammdaten, Aliase) nutzen das Sheet anders als die
  Bestandskette. Migration **pro Datendomäne** trennen, nicht „das Sheet" als Ganzes.
- Risiko bei Big-Bang ist hoch (Produktivsystem, ein Automat live, bald mehr).

## Zielbild

```
Nayax machineProducts ─► (Re-Anchor) ─► PG slot_assignments  ◄─ Dashboard (liest+schreibt)
Dashboard-Aktionen (Auffüllen/Slot) ──────────► PG (über idempotente pgw_write-Pfade)
PG ──(nightly export, optional)──► Google Sheet  [READ-ONLY Spiegel / Backup]
```

PG = SSoT für Bestand & Slots. Sheet = Spiegel. Nayax = externe Realität zum Abgleich.

## Domänen & Reihenfolge (vom risikoärmsten zuerst)

1. **Bestand / Slots (`slot_assignments.current_machine_qty`)** — höchster Nutzen,
   geringstes Risiko (Dashboard liest schon aus PG).
   - WF4-Sheets-Read → PG-Read ersetzen (löst zugleich Issue #10).
   - Schreibpfade (WF7 Nachfüllen, WF9 Pickliste, Slot-Editor) auf PG-first umstellen;
     Sheet-Write entweder weglassen oder als nachgelagerter Spiegel.
2. **Verkäufe / GuV** — laufen großteils schon über PG (`sales_transactions`,
   `guv_daily`, WF-PGW). Nur Sheet-Reste prüfen/abklemmen.
3. **Stammdaten / Rechnungen (WF1/WF2)** — zuletzt, eigene Bewertung
   (Sheet hat dort UI-/Freigabe-Funktion).

## Schritte (je Domäne, test-first)

1. **Schema-Check & Lücken schließen** — `lib/db-schema.js`-Contract erweitern; heutiger
   Nebenbefund: `machine_capacity`/`target_stock` in PG unvollständig (viele 0/NULL) →
   vor Cutover backfillen.
2. **Backfill** — PG aus Sheet einmalig vollständig befüllen (idempotent, Backup vorher).
3. **Read-Umstellung** — alle Reads der Domäne auf PG; Sheet-Reads entfernen.
4. **Write-Umstellung** — alle Writes PG-first über bestehende `pgw_write`-Entities;
   Sheet-Write zu optionalem, fehlertolerantem Spiegel degradieren (Sheet-Fehler darf
   den PG-Write nie blockieren).
5. **Drift-Guard** — täglicher Abgleich PG ↔ Nayax (aus reference_nayax_fill_level,
   Phase 1) als Dauer-Sicherung; zusätzlich optional PG ↔ Sheet-Spiegel.
6. **Cutover** — Sheet für diese Domäne auf read-only; Doku/CLAUDE.md aktualisieren.
7. **Tests grün** — alle bestehenden Dashboard-Tests bleiben grün; neue Tests für die
   PG-Pfade.

## Multi-Automat / Mandantenfähigkeit

`machine_id` durchgängig parametrisch (ist es in PG schon). Migration nicht auf 457107528
hartcodieren; WF7-Fallback `'457107528'` bei der Gelegenheit entfernen.

## Nicht-Ziele

- Keine Abschaltung von WF1/WF2-Sheet-Funktionen in dieser Phase.
- Kein Big-Bang. Keine produktive Nayax/Moma-Änderung.
- v2/Legacy bleibt unangetastet (additiv).

## Offene Fragen / Risiken

- Wird der Sheet-Spiegel überhaupt noch gebraucht, oder reicht ein PG-Dump als Backup?
- Latenz/Quota bei mehreren Automaten — PG entschärft das, aber Nayax-Calls takten.
- Wer „gewinnt" bei Konflikt PG vs. Nayax: Nayax ist Realität für Bestand → Nayax
  re-verankert PG; Dashboard-Aktionen schreiben sofort PG und werden vom nächsten
  Nayax-Abgleich bestätigt/korrigiert.

## Empfohlener erster Umsetzungsschritt (ab 08.06.)

Domäne 1, Schritt 3+4: WF4 von Sheets-Read auf PG-Read umstellen — behebt Issue #10
strukturell und macht PG zur SSoT für Bestand. Klein, hoher Nutzen, gut testbar.
