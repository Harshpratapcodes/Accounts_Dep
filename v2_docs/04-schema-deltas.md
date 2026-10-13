# 04: Schema Deltas

Every new and changed table against the imported `schema.sql`, with its triggers and invariants. A phase's section is written before its code (08 §5).

The exact DDL lives in `migrations/NNNN_*.sql`; this file records what each change is for and what it guarantees. Where the two disagree, the migration is what runs and this file is wrong: fix it. Migrations apply on top of `schema.sql` at server boot and in CI, and are folded into `schema.sql` at the end of each phase (`migrations/README.md`, D-170).

## Conventions

- **Additive only** (D-170): new tables; new columns that are nullable or have a constant default; constraints on new columns. Nothing imported is dropped or renamed.
- **`business_id` everywhere** (C-39): every business table has `business_id integer NOT NULL DEFAULT 1 REFERENCES business(id)`. Platform tables (`roles`, `role_permissions`, `users`, `sessions`, `schema_migrations`, `business`) do not. `test/business.ts` fails on any other table without it.
- **Insert-only** tables use the existing `fn_forbid_mutation()` trigger on `UPDATE OR DELETE` (raises `P0001`, mapped to `IMMUTABLE`).
- **Money** follows the engine: `numeric(15,2)` columns, decimal strings in contracts. Configuration amounts are integer paise in JSON (`…_paise` keys).
- **Dates** are business dates: the database's `TimeZone` is `Asia/Kolkata` (migration 0002), so `CURRENT_DATE` is the date in India. Application code asks `businessToday()` (`src/shared/clock.ts`), never `new Date().toISOString()`.

## V2-0: Foundation

### 0.B Engine corrections (built)

#### `business` and `business_id` (T0-06; C-39, D-140, D-171). Migration 0001

| Change | Detail |
|---|---|
| `business` (new) | `id integer PK CHECK (id > 0)`, `created_at`. One row, id 1. The business's profile (legal name, GSTIN, state code, address) stays in `company_settings`; this table is only the key rows hang off |
| `business_id` (28 tables) | Added to every imported business table, including line tables, `audit_log`, `document_sequences` and `company_settings`. A constant default adds the column without rewriting rows or firing row triggers, so posted documents' immutability guards are not tripped |
| `roles` + `role_permissions` | New role `owner`: read, write, submit and cancel on `crm`, `sales`, `invoicing`, `accounting`, `inventory`; read only on `core`. Admin is unchanged |

Invariants: no query filters on `business_id` yet (single tenant). Unique keys stay as imported (`uq_companies_name`, `document_sequences.series`, `number_series.code`); a second business would need them widened to include `business_id`, which is out of scope (01 §6).

`core` now has a meaning: platform settings and configuration. `core.write` is admin-only, and configuration writes require it (T0-07 says admin-editable).

#### Business date in IST (T0-08 prerequisite; C-08). Migration 0002

`ALTER DATABASE … SET TimeZone = 'Asia/Kolkata'`. Render and Neon run in UTC, so before this, `CURRENT_DATE` was yesterday between 00:00 and 05:30 IST. A document raised at 00:30 on 1 April would have been dated 31 March and numbered in the old financial year. The setting fixes the document date defaults, the ageing views and the period "is current" check together. `withTransaction` also sets it per transaction, so a database restored without the setting still posts on IST dates. Needs the database owner's role, which the Neon app role is.

#### Number series by financial year (T0-08; C-07, C-08). Migration 0003

| Object | Detail |
|---|---|
| `number_series` (new) | `code text PK` (2 to 4 capitals), `description`, `padding` (3 to 8), `business_id`. The document types the numbering engine knows: QTN, SO, INV, CRN, PAY, JV, PRC, ADJ. Each new type (PB, EXP, DC, DBN, RCP, PMT, ST) is added by the phase that introduces it. CHECK `length(code) + padding <= 10`, so `CODE-YYYY-NNNNN` never exceeds Rule 46's 16 characters |
| `document_sequences` (changed) | `+ series_code text NOT NULL REFERENCES number_series`, `+ fy_start_year smallint NOT NULL`, UNIQUE `(series_code, fy_start_year)`, CHECK `series = series_code-fy_start_year` and `prefix = series-`. The imported calendar-year rows (`INV-2026`, …) are backfilled as FY 2026-27, so their counters carry on |
| `fn_fy_start_year(date)` (new) | Immutable. The year the Indian financial year containing the date starts (1 April to 31 March, by statute, not configuration) |
| `next_doc_number(code, doc_date)` (new overload) | Refuses a NULL date or an unknown code (`P0002`). Creates the FY's series row on first use (`INSERT … ON CONFLICT DO NOTHING`), then calls the imported gapless `next_doc_number(series)`. A second first-of-year submitter waits on the first's uncommitted row, then both serialise on the counter's row lock |

Number format: `CODE-YYYY-NNNNN`, where YYYY is the year the FY starts. `INV-2026-00001` is FY 2026-27; `INV-2027-00001` is FY 2027-28. This keeps the imported format, so numbers already issued continue unchanged. The FY is read from the **document's date**, not the day it is submitted: an invoice dated 31 March and keyed in on 2 April takes the next FY 2026-27 number. The series for a new year needs no year-end job.

Application side: `nextDocNumber(tx, code, docDate)` (`src/core/numbering.ts`) is the only entry point. The document engine passes the document's `doc_date`; journals pass their `posting_date`; reversals pass the date they post on. The single-argument SQL function stays (additive) but has no application caller.

#### Configuration (T0-07; C-14). Migration 0004

| Column | Detail |
|---|---|
| `config_values` (new) | `id bigint identity`, `business_id`, `key text` (dotted lowercase), `value jsonb`, `effective_from date`, `note`, `created_by uuid DEFAULT fn_current_actor()`, `created_at`. Insert-only (`fn_forbid_mutation`) |

The value in force on a date is the row with the latest `effective_from` on or before it; among rows for one date, the highest `id` (the one entered last). A wrong entry is corrected by entering the date again, and both rows stay on record (C-03).

Keys and their value shapes are defined in `src/core/config.ts` (`CONFIG_KEYS`), not in the database. Every write is checked against the key's zod schema, and so is every read, so a value that no longer matches fails loudly. Seeded from 02 §8, in force from 2025-04-01 (the earliest FY v2 handles). Three keys are deliberately not seeded, because only the CA or the admin can decide them: `gst.installation_treatment` (C-19), `it.asset_capitalisation_threshold_paise` (C-37) and `digest.time_local` (P-06). `getConfig` throws `CONFIG_UNSET` for them until they are set, so a rule that depends on them stops instead of guessing. 02 §8's `gst.state_code` maps to `company_settings.state_code` (one source of truth for the business's identity), and `gst.rates` becomes the rate schedule table in T1-01.

API: `GET /api/config?asOf=` (core.read), `GET /api/config/:key/history` (core.read), `POST /api/config/:key {value, effectiveFrom, note?}` (core.write: admin).

#### Engine change found in review: the document row is locked first

`makeLifecycle` (`src/core/document-engine.ts`) now takes `SELECT … FOR UPDATE` on the document before loading it, in both submit and cancel. Before this, two cancels of the same invoice both read `submitted` and both posted a reversal: reproduced in 9 of 10 trials. The immutability trigger allows `cancelled → cancelled`, so nothing stopped the second one. The ledger still "balanced" (each reversal is balanced), so `fn_verify_gl` could not see it. A draft edit committing mid-submit could also leave the journal built from stale totals. Draft edits already lock the same row, so they now finish first or wait. Covered by the same-document scenario in `test/concurrency.ts`.

Also: `invoiceLifecycle` refuses a `credit_note` row (`NOT_SUPPORTED`). Its posting is an invoice's (Dr Debtors / Cr Sales), and a credit note would be booked backwards. The CRN number it drew rolls back. The credit-note posting path is V2-2's (ADR 025).

### 0.C Machinery (to be written before its code)

`documents`, `document_pages` (T0-10); `proposals`, `proposal_versions`, `proposal_issues`, `confirmations` and their triggers (T0-11); `llm_calls`, `prompts` (T0-14); `conversations`, `messages`, `tool_calls` (T0-15); pg-boss's own schema (T0-16).
