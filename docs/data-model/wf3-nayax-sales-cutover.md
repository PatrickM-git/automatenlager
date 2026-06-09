# Stufe 6 Slice 3 (#163) — Schattenbetrieb & Cutover-Kriterien: WF3 / WF1+WF2 / WF4

> Deckt die drei datenkritischen Ports ab: WF3 (Nayax-Verkäufe), WF1/WF2 (Rechnungseingang),
> WF4 (Slot-Write). WF3 + WF1/WF2 laufen im **Schattenbetrieb** (compute+compare) bis zur
> bewiesenen Deckungsgleichheit; WF4 ist ein **direkter Wechsel** (idempotente Upserts, starke Tests).

---

## WF3 Nayax-Verkäufe — Schattenbetrieb & Cutover-Kriterium

> SPEC: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md` (§Rollout Slice 3, §Testing).
> Pre-Flight-Grundlage: `docs/data-model/pgw-write-und-workflow-runs-preflight.md`.
> Code: `dashboard/lib/jobs/nayax-sales.js`, registriert in `dashboard/worker.js`.

## Was portiert wurde

`lib/jobs/nayax-sales.js` ersetzt die n8n-WF3 („Nayax Lynx FIFO Lagerbestand"):
Verkäufe holen → FIFO-Abbuchung über `stock_batches` (nach MHD) → `sales_transactions`
→ `stock_movements` → Watermark (`workflow_state`) → Auto-Korrektur-Warnungen — **per
Mandant durch die Mandanten-Tür** (`db.tx`, RLS-GUC, explizites `tenant_id`), kein BYPASS.

**Verifizierte `pgw_write()`-Semantik (Pre-Flight-Dump, nicht Doku-Annahme):**

| Event | Zieltabelle | Konflikt | Besonderheit |
|---|---|---|---|
| `sale` | `sales_transactions` | `ON CONFLICT (nayax_transaction_id) DO NOTHING` | FK `machine_key`/`product_key`/`product_slot_key` → IDs aufgelöst |
| `stock_movement` | `stock_movements` | `ON CONFLICT (movement_key) DO NOTHING` | **AFTER-INSERT-Trigger `apply_stock_movement` pflegt `remaining_qty` + Status `leer`** |

**Kritisch:** `stock_batches.remaining_qty` wird vom Port **nicht** manuell geupdatet —
das erledigt der Trigger `apply_stock_movement` (`remaining_qty += quantity_delta_total`,
Status→`leer` bei ≤0). Ein zusätzliches UPDATE wäre ein Doppel-Dekrement. Verifiziert
durch den Live-Test (`b_acme` 30 → 29 ausschließlich über den Movement-Insert).

## Schattenbetrieb (Default, kein Schreiben)

Der Worker-Job `wf3-nayax-fifo` läuft täglich 01:00 (wie n8n) und ist **standardmäßig im
Schattenmodus** (`runNayaxSalesShadow`): er holt die Verkäufe, **rechnet** die beabsichtigten
Writes und **vergleicht** sie strukturell gegen den n8n-Ist-Stand in PG — er **schreibt nichts**
(strukturell unmöglich: der Schatten-Pfad ruft `db.tx` nie auf; per Unit-Test abgesichert).

Verglichen wird (Schlüssel → verglichene Felder):
- `sales_transactions` nach `nayax_transaction_id` (Feld `quantity`)
- `stock_movements` nach `movement_key` (Feld `quantity_delta_total`)

Der Lauf landet in `audit.workflow_runs` (`workflow_key='wf3-nayax-fifo'`); das Ergebnis
enthält `equal` sowie je Diff `onlyIntended`/`onlyActual`/`mismatched`.

## Cutover-Kriterium — wann gilt Deckungsgleichheit als bewiesen

Der Cutover (Schreibmodus per `WF3_CUTOVER=1`, danach n8n-WF3 deaktivieren) ist **erst**
zulässig, wenn **alle** folgenden Punkte erfüllt sind:

1. **Mindestens 7 aufeinanderfolgende Schattenläufe** (≈ 1 Woche täglich) mit
   `equal === true` für **beide** Diffs (`salesDiff` UND `movementsDiff`) — d. h.
   `onlyIntended = onlyActual = mismatched = 0`.
2. Die 7 Läufe decken **mindestens einen Tag mit echten Verkäufen je relevantem
   Produkttyp** ab (nicht nur leere Tage) — der Vergleich ist sonst vakuös.
3. **Keine** `onlyIntended`-Einträge (der Port würde etwas schreiben, das n8n nicht schrieb)
   und **keine** `onlyActual`-Einträge (der Port übersähe einen n8n-Write) über das Fenster.
4. Stichprobe: ein manuell ausgelöster Schattenlauf nach einem realen Verkaufstag zeigt die
   neue Transaktion sowohl in `intended` als auch in `actual` mit identischer `quantity`.

Sind 1–4 erfüllt: `WF3_CUTOVER=1` setzen → erster Schreiblauf beobachten (`audit.workflow_runs`
`mode='cutover'`, `salesWritten`/`movementsWritten` plausibel) → n8n-WF3 deaktivieren.

## Rückweg

Jederzeit bis Slice 4: `WF3_CUTOVER` entfernen (zurück in den Schatten) **und** n8n-WF3
reaktivieren. Es gibt keinen Doppel-Schreib-Schaden, weil beide Schreiber idempotent sind
(`ON CONFLICT DO NOTHING` auf `nayax_transaction_id` bzw. `movement_key`).

## Bekannte Altlasten (bewusst, Slice 4 / #111)

- **Watermark global gekeyt:** `workflow_state` hat PK `(workflow_key)` statt `(tenant_id,
  workflow_key)`. Der Port schreibt die Watermark mandantensicher (`ON CONFLICT (workflow_key)
  DO UPDATE … WHERE tenant_id = $1`) → ein Fremd-Mandant überschreibt Faltrix' Zeile **nicht**
  (stiller No-Op). Voll MT-fähig erst nach #111 (Slice 4).
- **Movement-Idempotenz pro Tag:** `movement_key = wf3_sale_<batch>_wf3_<YYYY-MM-DD>` — pro Tag
  und Charge genau ein Movement (verhaltensgetreu zur täglich-01:00-WF3). Mehrfachläufe am
  selben Tag buchen denselben Schlüssel **nicht** erneut ab (`ON CONFLICT DO NOTHING`).
- **Warnungen/Slot-Mengen:** in der Alt-WF3 nur nach Google Sheets (tot). Der Port schreibt
  die Auto-Korrektur-Warnungen jetzt in `warnings` (deterministischer `warning_key`); die
  Slot-`current_machine_qty`-Abbuchung bleibt außerhalb des PG-Schreibpfads (kein n8n-PG-Vorbild).
- **Warnungs-Taxonomie:** `warnings.warning_type` hat einen CHECK; Sheets-Ära-Typen werden über
  `lib/warning-types.js` gemappt (`MHD_WARNING`→`MHD_NEAR`) oder übersprungen (z. B. `MHD_MISSING`,
  `AUTO_REFILL_SLOT` — keine PG-Taxonomie). Sonst bräche der INSERT (Befund Slice 2).

---

## WF1/WF2 Rechnungseingang — Schattenbetrieb & Cutover-Kriterium

Code: `lib/jobs/invoice-intake.js`; WF2-Freigabe-Endpunkt `POST /api/v2/invoice-proposal/approve`
(admin-only, durch die Tür); WF1-Worker `wf1-invoice-intake` (Drive-Polling, **DEFAULT Schatten**).

**PG-Schreibpfade (verifiziert, pgw_write):** `invoice`→`suppliers`(ON CONFLICT supplier_key)+`invoices`
(ON CONFLICT invoice_key); `invoice_item`→`invoice_items`(ON CONFLICT invoice_id,line_number);
`product`→`products`(ON CONFLICT product_key); `product_alias`→`product_aliases`(ON CONFLICT alias,source);
`stock_batch`→`stock_batches`(ON CONFLICT batch_key) **inkl. invoice_item-Verlinkung** (erste unverlinkte
Zeile → `product_id` setzen, faithful zu pgw).

**Schatten:** `runInvoiceIntakeShadow` rechnet die beabsichtigten `invoice_item`-Writes (Schlüssel
`invoice_key#line_number`, Feld `quantity`) und vergleicht gegen den Ist-Stand — schreibt nicht.

**Cutover-Kriterium WF1:** wie WF3 — ≥7 deckungsgleiche Schattenläufe über reale Rechnungs-PDFs
(nicht-vakuös: mind. eine mehrzeilige Rechnung), keine `onlyIntended`/`onlyActual`, dann `WF1_CUTOVER=1`.
**WF2-Freigabe** ist von Anfang an in-process (Mensch-im-Loop, kein Schatten nötig — der Mensch
entscheidet bewusst); der Endpunkt ist idempotent (alle Upserts `ON CONFLICT DO NOTHING`).

## WF4 Slot-Write — direkter Wechsel (kein Schatten)

Code: `lib/jobs/wf4-slot-write.js`. WF4 ist die **Autorität** für aktive Slot-Zuordnungen; der
Schreibpfad ist idempotent und stark getestet → **direkter Wechsel** (kein Schattenbetrieb, SPEC).

**PG-Schreibpfad:** `slot_assignment`→`slot_assignments` INSERT … ON CONFLICT (product_slot_key)
DO UPDATE (nur `valid_to`/`active`/`notes`; `current_machine_qty` nur beim INSERT eines NEUEN
Schlüssels). Jede Änderung = **close(alt)** + **open(neuer Schlüssel)**. Warnungen über dieselbe
Taxonomie (`lib/warning-types.js`).

**Wichtig (NOT NULL + ON CONFLICT):** `valid_from` ist NOT NULL und wird beim „speculative insert"
VOR der Konflikt-Auflösung geprüft → Close-Events defaulten `valid_from` auf `nowIso` (auf UPDATE
ohnehin ignoriert), sonst 23502 statt Konflikt-Update.

**Cutover WF4:** direkter Wechsel — Dashboard-Trigger (`slot-change`/`slot-assign-inline`) von
`fetch(n8n)` auf `applySlotAssignmentEvents` umlegen, n8n-WF4 deaktivieren. Rückweg: Trigger zurück.
