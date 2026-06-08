# Pre-Flight: WF8-GuV-Port (Stufe 6, Slice 1, #161)

> Quelle: **read-only Dumps aus der echten Mini-DB** via `dashboard/tools/preflight-guv-daily.js`
> + Paritätslauf `dashboard/tools/shadow-guv-parity.js` (`current_user=homelab`), Stand 2026-06-08.
> SPEC: `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md` §"Pre-Flight-Pflicht".
>
> Zweck: den WF8-Port (`dashboard/lib/jobs/guv-aggregate.js`) gegen den **realen DB-/
> Laufzeit-Stand** verankern statt gegen Doku-Annahmen. Reproduzieren:
> `cd dashboard && node tools/preflight-guv-daily.js`.

## 1) `pgw_write('guv_daily')` — realer Schreibzweig (aus `pg_get_functiondef`)

```
WHEN 'guv_daily' THEN
  SELECT machine_id INTO v_machine_id FROM automatenlager.machines WHERE machine_key = p_payload->>'machine_key';
  IF v_machine_id IS NULL THEN RAISE EXCEPTION 'machine not found: %', p_payload->>'machine_key'; END IF;
  SELECT product_id INTO v_product_id FROM automatenlager.products WHERE product_key = p_payload->>'product_key';
  IF v_product_id IS NULL THEN RAISE EXCEPTION 'product not found: %', p_payload->>'product_key'; END IF;
  INSERT INTO automatenlager.guv_daily (
    guv_key, posting_date, machine_id, mdb_code, product_id,
    quantity_sold, revenue_gross, revenue_net, cost_of_goods, gross_profit, source
  ) VALUES ( …::DATE, v_machine_id, …::INTEGER, v_product_id, …::INTEGER, …::NUMERIC … )
  ON CONFLICT (guv_key) DO NOTHING;
```

- `pgw_write` setzt **kein** `tenant_id` (mandantenblind, läuft BYPASSRLS); `tenant_id`
  kommt aus dem **BEFORE-INSERT-Trigger** `trg_inherit_tenant_guv_daily` (erbt aus
  `machines` via `machine_id`).
- **Port-Konsequenz:** `lib/jobs/guv-aggregate.js` schreibt **durch die Mandanten-Tür**
  (`db.tx`, GUC gesetzt), löst `machine_key→machine_id`/`product_key→product_id`
  **tenant-scoped** auf und setzt `tenant_id` **explizit** (Trigger respektiert das,
  RLS-`WITH CHECK` verifiziert es). Konflikt-Modus identisch: `ON CONFLICT (guv_key) DO NOTHING`.

## 2) `guv_daily` — reales Schema / Constraints

- Spalten: `guv_id` (PK seq), `guv_key` (NOT NULL), `posting_date` (date, NOT NULL),
  `machine_id` (bigint, NOT NULL), `mdb_code` (integer, NULL), `product_id` (bigint, NOT NULL),
  `quantity_sold` (int), `revenue_gross/revenue_net/cost_of_goods/gross_profit` (numeric),
  `source` (text), `created_at` (timestamptz default now()), `tenant_id` (text, **NOT NULL**).
- Uniques: **`guv_daily_guv_key_key (guv_key)`** (global) UND **`guv_daily_tenant_uk (tenant_id, guv_key)`**.
  Der Port nutzt `ON CONFLICT (guv_key)` (faithful zu `pgw_write`; global eindeutig solange
  ein Mandant). Umstellung auf `(tenant_id, guv_key)` = **Slice 4/#111**.
- FKs mandanten-treu: `(tenant_id, machine_id)→machines`, `(tenant_id, product_id)→products`.
- RLS-Policy `tenant_isolation`: `USING`+`WITH CHECK` = `tenant_id = current_setting('automatenlager.current_tenant')`.

## 3) ⚠️ Faithfulness-Befund: Konfig snake_case vs. camelCase (kleinunternehmer effektiv FALSE)

- `classification_settings.__default__` enthält real **`{"kleinunternehmerAktiv": true}`** (camelCase).
- WF8s „Read - GuV_Konfiguration"-SQL liest aber **`cfg->>'kleinunternehmer_aktiv'`** (snake_case)
  → dieser Schlüssel existiert nicht → `COALESCE(... ,'FALSE')` → **WF8 rechnet IMMER mit
  Kleinunternehmer = FALSE** (Netto-Kostenbasis), `mwst_snack=7`, `mwst_getraenk=19` (Defaults).
- Verifiziert live: WF8-Konfig-SQL liefert `{"kleinunternehmer_aktiv":"FALSE","mwst_snack":"7","mwst_getraenk":"19"}`.
- **Der Port repliziert das exakt** (`parseConfig` liest snake_case). Würde er den camelCase-Wert
  lesen (=true), divergierten die Zahlen von WF8 → Schatten-Match bräche → falsche Kunden-P&L.
- **Separater Befund (NICHT in diesem Port gefixt):** die **Live-Dashboard-Ökonomie**
  (`category-config.js`/`economics.js`) liest `kleinunternehmerAktiv` (camelCase = true) und nutzt
  damit die **Brutto**-Kostenbasis für „heutige" provisorische Posten — während die Nacht-GuV
  (`guv_daily`) **Netto** bucht. Diese Live/Nacht-Divergenz ist eine bewusste, gesonderte
  Finanz-Entscheidung (eigenes Issue) — kein stiller Fix im Port.

## 4) Algorithmische Parität (drift-immunes Cutover-Gate)

`tools/shadow-guv-parity.js` führt WF8s **wörtlichen** Node-Code (aus der Workflow-JSON) und
den Port auf **denselben aktuellen Read-Inputs** aus und vergleicht Zeile für Zeile:

```
WF8-Referenzzeilen=224  Port-Zeilen=224
PARITÄT (identische Inputs):  matched=224  mismatched=0  onlyWF8=0  onlyPort=0
✅ BYTE-IDENTISCH zu WF8 auf jedem Key.
```

**Warum nicht „Recompute vs. gespeichert":** WF8s `cost_of_goods` hängt am FIFO-Chargen-
Schnappschuss (`status` aktiv→leer bewegt sich täglich). Heute neu berechnete Vergangenheitstage
weichen daher legitim von den DAMALS gespeicherten ab (Drift) — WF8 selbst überschreibt sie nie
(`ON CONFLICT DO NOTHING`). Die rigorose, drift-IMMUNE Äquivalenz ist die **Parität auf
identischen Inputs** (oben). Das ist das PFLICHT-Gate **vor** `WF8 deaktivieren`.

> `tools/preflight-guv-daily.js` und `tools/shadow-guv-parity.js` sind read-only und liegen
> bewusst außerhalb `lib/` (kein Mandanten-Datenpfad, nicht im Web-/Worker-Lauf).
