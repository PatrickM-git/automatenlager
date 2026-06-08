# Pre-Flight: `pgw_write()` + `audit.workflow_runs` (Stufe 6, Slice 0, #160)

> Quelle: **read-only Dump aus der echten Mini-DB** via `dashboard/tools/preflight-pgw-write.js`
> (`current_user=homelab`, db `homelab`), Stand 2026-06-08. SPEC:
> `docs/specs/multi-tenant-n8n-abloesung-stufe-6-v1.md` §"Pre-Flight-Pflicht".
>
> Zweck: gegen den **realen DB-/Laufzeit-Stand** portieren statt gegen Doku-Annahmen
> (Lehre aus Stufe 5: die Rollen-Hierarchie wurde erst im Pre-Flight gefunden). Diese
> Datei ist die maßgebliche Referenz für die Ports in Slice 1–3 und für #111/#108 (Slice 4).
> Reproduzieren: `cd dashboard && node tools/preflight-pgw-write.js`.

## 1) `automatenlager.pgw_write()` — Signatur

```
automatenlager.pgw_write(p_event_type text, p_batch_run_id text, p_payload jsonb) RETURNS jsonb
```

WF-PGW ist ein „dummer" Durchreicher auf diese DB-Funktion; WF1/WF4/WF5/WF7/WF8/WF9 +
WF-Monitor schreiben über **Events** dorthin. Die Funktion schreibt zuerst eine
`audit.workflow_runs`-Zeile (`workflow_key='WF-PGW'`, `status='running'`, `RETURNING run_id`),
führt dann je `event_type` ein typisiertes Insert/Upsert aus, und protokolliert Fehler in
einer Fehler-Tabelle (`p_batch_run_id, 'WF-PGW', event_type, payload, SQLERRM, SQLSTATE`).

## 2) event_type → Zieltabelle → Konfliktschlüssel (vollständig, aus dem Dump)

| `event_type` | Zieltabelle(n) | Konflikt / Modus |
|---|---|---|
| `product` | `products` | `ON CONFLICT (product_key) DO NOTHING` |
| `product_alias` | `product_aliases` | `ON CONFLICT (alias, source) DO NOTHING` |
| `slot_assignment` | `slot_assignments` | `ON CONFLICT (product_slot_key) DO UPDATE` (setzt `valid_to`, `active`, `notes`) |
| `invoice` | `suppliers` + `invoices` | `ON CONFLICT (supplier_key) DO NOTHING` / `ON CONFLICT (invoice_key) DO NOTHING` |
| `invoice_item` | `invoice_items` | `ON CONFLICT (invoice_id, line_number) DO NOTHING` |
| `stock_batch` | `stock_batches` (+ `UPDATE invoice_items`) | `ON CONFLICT (batch_key) DO NOTHING` |
| `sale` | `sales_transactions` | `ON CONFLICT (nayax_transaction_id) DO NOTHING` |
| `stock_movement` | `stock_movements` | `ON CONFLICT (movement_key) DO NOTHING` |
| `guv_daily` | `guv_daily` | `ON CONFLICT (guv_key) DO NOTHING` |
| `warning` | `warnings` | `ON CONFLICT (warning_key) DO NOTHING` |
| `proposal_resolved` | `product_change_proposals` | `UPDATE` (kein Insert) |
| _sonst_ | — | `RAISE EXCEPTION 'unknown event_type'` (ERRCODE P0001) |

### ⚠️ Befund: `pgw_write()` ist mandantenblind

- **Keiner** der Inserts setzt `tenant_id`; **alle** Konfliktschlüssel sind **global,
  einspaltig** (`product_key`, `batch_key`, `nayax_transaction_id`, `guv_key`, `warning_key`,
  `movement_key`, …) — NICHT `(tenant_id, key)`. Das ist die in der SPEC (§Problem Statement,
  Punkt 2) beschriebene Mandantenblindheit und der Grund, warum **kein zweiter echter Kunde**
  vor Stufe 6 onboarded wird.
- **Konsequenz für die Ports (Slice 1–3):** Jeder ex-`pgw_write`-Schreibpfad wird als
  **typisiertes `db.tx` durch die Mandanten-Tür** nachgebaut (gleiche Zieltabellen, gleiche
  Upsert-Semantik) — aber **mit gesetztem GUC** (RLS-Backstop) und `tenant_id`. Bis #111
  trägt der Brücken-Trigger (Migration 0014) `tenant_id` aus dem Kontext nach; die globalen
  Uniques werden erst in **Slice 4 (#111)** auf `(tenant_id, key)` umgestellt, **nachdem**
  alle Schreiber durch die Tür gehen (vorher würde es das noch laufende n8n brechen).
- `proposal_resolved` ist ein reines `UPDATE` (WF-Claude-Proposals, Slice 2).

## 3) `audit.workflow_runs` — reales Schema (Pre-Flight)

| Spalte | Typ | NULL | Default |
|---|---|---|---|
| `run_id` | bigint | NO | `nextval('audit.workflow_runs_run_id_seq')` (PK) |
| `workflow_key` | text | NO | — |
| `started_at` | timestamptz | NO | — |
| `finished_at` | timestamptz | YES | — |
| `status` | text | NO | — |
| `records_in` | integer | YES | — |
| `records_out` | integer | YES | — |
| `records_failed` | integer | YES | — |
| `notes` | text | YES | — |

Index: nur `workflow_runs_pkey (run_id)`. Bisher nur `workflow_key='WF-PGW'` vorhanden.

**Lücke für den neuen Schreiber:** weder `error` noch `source` (noch `details`). →
Migration **0027** ergänzt diese drei Spalten **additiv/idempotent** + zwei Lese-Indizes
(`(workflow_key, started_at DESC)`, `(started_at DESC)`). `pgw_write` referenziert die neuen
Spalten nicht → unberührt. `audit.workflow_runs` bleibt **System-Telemetrie ohne `tenant_id`**.

## 4) Externe Trigger/Credentials (Inventar — Detailverifikation je Port)

Aus der SPEC (§"Externe Integrationen"), bei jedem Port (Slice 1–3) gegen die echte
n8n-Konfiguration zu verifizieren, bevor der jeweilige WF abgeschaltet wird:

- **Nayax Lynx** (WF3, WF-Nayax-Devices-Sync, WF-Val) — HTTP, Token → `.env.local`.
- **Claude/Anthropic** (WF1 `claude-sonnet-4-6`; WF9/WF-Claude-Proposals `claude-haiku-4-5`) — Key → `.env.local`.
- **Google Drive** (WF1/WF9 PDF-Polling) — als Drive-Polling-Job portieren (Verhalten unverändert).
- **Gmail-Versand** (WF5, WF-Monitor, WF-Drift-Check, WF-Val, WF-Claude-Proposals) — Mailer-Modul.

Verschlüsselung pro Mandant (Credential-Vault) = **Stufe 7** (bewusst nicht hier).

> Hinweis: `tools/preflight-pgw-write.js` ist **read-only** (nur Katalog/`pg_get_functiondef`/
> `information_schema`) und liegt bewusst außerhalb `lib/` (kein Mandanten-Datenpfad, nicht im
> Web-/Worker-Lauf).
