# 08: Build Plan

Task IDs `T<phase>-<nn>` (e.g. `T1-04`). A PR names the task IDs it closes; a test names the requirement IDs (`P-`, `C-`, `D-`) it enforces.

The phase order and goals are 00's. This file adds the starting state of the code, the tasks, the inputs each phase waits on, the exit criteria, and the gstack loop. 01 to 03 describe the imported engine as it is; where a task changes it, the task cites the requirement that says how.

Sizes are relative effort (S, M, L, XL), not calendar time. The build is part-time with no fixed date (01 §8).

## 1. Starting point: the engine as imported

This repo is a one-time copy of Bizsuite v1 at `25ae8c6`. v1 carries on separately in `Harshpratapcodes/Bizsuite`.

**Built and tested:** sessions + argon2id auth; five-role RBAC; gapless numbering; the DRAFT → SUBMITTED → CANCELLED document engine; accounting (chart of accounts, manual journals, trial balance, general ledger, financial periods with posting lock, customer opening-balance rail); inventory (items, warehouses, moving-average stock with ordered locking); CRM companies master with CSV importer; quotations and sales orders; invoicing (GST math, invoices, credit notes as an invoice kind, payments, khata); the operator SPA; 11 tsx suites, Vitest frontend tests, 3 Playwright specs; CI on Postgres 16; Dockerfile + `render.yaml`.

**Not built:** pg-boss jobs, server-side PDF (no Chromium in the `node:22-alpine` image), object storage, post-commit event bus, helmet / rate limiting / CSRF, the PWA, supplier payments, the `owner` role, `business_id`, financial-year number series, the GST 2.0 rate set (C-13).

**Deployment:** `render.yaml` describes one Docker web service on Render's free plan, which sleeps when idle; v2 gets its own service and Neon database (D-06, D-170).

### 1.1 TODOS.md carried forward

| TODO | Where it goes |
|---|---|
| 1. Service/AMC design spike | V2-7: the 04 and 06 sections for service, written before T7-01 |
| 2. Per-invoice opening balances for big debtors | Decided in T8-04 |
| 3. Vitest migration of tsx suites | Stays deferred: D-160 keeps new suites in the tsx style |
| 4. `accounts` role CRM write | Closed: v2 has `owner` and `admin` only |
| 5. Pagination past `LIMIT 500` | Checked in T1-03 when the real masters are imported |

## 2. Phase map

| Phase | Size | Depends on | Owner gets |
|---|---|---|---|
| V2-0 Foundation | L | none | An installable app with Inbox and Ask; no business feature yet |
| V2-1 Quotations | M | V2-0 | "Quotation for Sharma…" → confirm → PDF. Refrens retired |
| V2-2 Outbound rail | L | V2-1 | Orders, invoices, challans, notes, receipts from Ask; every sale in the system |
| V2-3 Inbound capture | XL | V2-0, V2-1 | Photograph a supplier bill or receipt, confirm, done |
| V2-4 Clarifications and digest | M | V2-3 | One daily push, at most three items, ranked by money at risk |
| V2-5 Banking | L | V2-2, V2-3 | Statement upload, batch-confirmed matches, a true money view |
| V2-6 Monthly close | L | V2-2, V2-3, V2-5 | CA package by the 5th; IMS action list before the 14th |
| V2-7 CRM and service | M | V2-2, V2-4 | Units by serial, AMC and warranty reminders, billed service calls |
| V2-8 Hardening and go-live | M | all | The CA files from the package; the paper stops |

```
layer 0   V2-0
layer 1   V2-1
layer 2   V2-2                         V2-3
layer 3   V2-5 (needs V2-2, V2-3)      V2-4 (needs V2-3)
layer 4   V2-6 (needs V2-2, V2-3, V2-5)   V2-7 (needs V2-2, V2-4)
layer 5   V2-8 (needs all)
```

Phases on one layer do not depend on each other. 00's order runs them one at a time.

**One recommended change to 00's order.** The IMS slice of V2-6 (T6-01, T6-02) needs only confirmed purchase bills. Every month without it, the 14th passes with no one acting on IMS, and credit can lapse silently: the problem 01 §1 opens with. Run T6-01 and T6-02 straight after V2-3, and the rest of V2-6 in its place. If adopted, record it as an ADR and update 00's table.

## 3. Phases

### V2-0: Foundation (L)

**Owner gets:** the app installs on the phone with Inbox and Ask; nothing posts yet.
**Write first:** 09 (v2 `CLAUDE.md`); 04 §V2-0; 07 layout; ADRs 013 to 016, 018 to 021.

*0.A Repo and environment*

| ID | Task | Traces to |
|---|---|---|
| T0-01 | Tag the import commit `v1-import`; write ADR 016 (one-time copy, own repo, own service and database) | D-170 |
| T0-02 | Point the root README at the v2 docs: its `blueprint.md` link to `v2_docs/08-build-plan.md`; its `claude.md` link names a gitignored local file. Bring ADRs 001 to 005 and 007 to 012 over from the v1 repo or link them | 00 |
| T0-03 | Write the v2 `CLAUDE.md` (doc 09): D-01 to D-07 as rules, requirement-ID citation, the existing skill routing, the rule that Claude prints commit commands and never commits; decide whether it is committed (today `.gitignore` excludes `claude.md`) | 00 |
| T0-04 | New Neon database, new Render service `bizsuite-accounts`, own secrets; confirm Neon's restore window before real data arrives in V2-1 | D-06, D-144, D-170 |
| T0-05 | Route or close each TODOS.md entry per §1.1 | |

*0.B Engine corrections (before new tables pile on)*

| ID | Task | Traces to |
|---|---|---|
| T0-06 | `business` table; `business_id` default 1 on every business table; `owner` role | C-39, D-140, D-171 |
| T0-07 | `config_values`, effective-dated, admin-editable; seed the 02 §8 table | C-14 |
| T0-08 | FY-keyed number series with rollover at 1 April; current series map to FY 2026-27 | C-08 |
| T0-09 | Helmet; rate limits on `/api/auth/*`, Ask, upload; CSRF on state-changing routes | D-143 |

*0.C Machinery*

| ID | Task | Traces to |
|---|---|---|
| T0-10 | `documents` module: storage adapter (local filesystem for dev and CI, S3-compatible for production), SHA-256 dedup, magic-byte type check, size cap, write-once objects, signed URLs | D-30, D-120, D-141, C-06, C-38 |
| T0-11 | `proposals` module: proposals, immutable versions, issues, confirmations with the edited-field diff, the status machine, a posting registry, idempotency; DB triggers for insert-only versions and confirm-names-current-version | D-10 to D-15, D-18, P-13 |
| T0-12 | Validator framework (pure functions over payload + read-only context) with PERIOD_OPEN and DATE_SANITY | D-13, D-40 |
| T0-13 | First proposal type end to end: `party_upsert` into the companies service. Proves the lifecycle without a model | D-02 |
| T0-14 | LLM gateway: OpenRouter client, task→model routing with fallback, zod→JSON schema, `json-repair` + one retry, insert-only `llm_calls`, prompts versioned in the repo, per-call cost ceiling, monthly budget, no-training providers only | D-60 to D-66, P-10, C-38 |
| T0-15 | Agent skeleton: tool registry with kinds `read` and `propose` only, conversation persistence, bounded tool-call loop, server-side recompute hook | D-20, D-21, D-23, D-24, D-142 |
| T0-16 | pg-boss on the same Postgres; idempotent job keys; dead-letter visible to admin | D-110, D-113, ADR 019 |
| T0-17 | PWA shell: manifest, service worker (offline shell), install prompt, Inbox and Ask screens, 360 px one-handed layout, i18n-ready strings | D-130, D-131, D-133, D-134 |
| T0-18 | Eval harness skeleton: golden directory layout, scorer interface, recorded-response replay, CI job on changes under `src/llm/` and `src/extraction/` | D-62, D-162 |
| T0-19 | `/healthz` checks DB, queue, storage; structured logs carry request, proposal, document ids | D-150 |

**Exit criteria**
1. Every v1 suite plus the new proposals, validator, gateway (recorded) and registry suites pass in CI.
2. A `party_upsert` proposal goes draft → ready → confirmed → posted; the company row carries `proposal_id`; the confirmation records the edited fields. (D-03, P-13)
3. A test fails if any tool is registered with a kind other than `read` or `propose`, or if the model names a tool outside the registry. (P-10, D-20)
4. A live gateway call (nightly job, never CI) writes an `llm_calls` row with model, provider, tokens, cost, prompt version. (D-63)
5. The same file uploaded twice yields one `documents` row. (D-30)
6. With a fixed clock, a document dated 2027-04-01 numbers from the FY 2027-28 series. (C-08)
7. The PWA installs on the owner's Android phone from the new production URL.

**Note:** this phase ships nothing the owner uses. If it drags, ship 0.A, 0.B and T0-10 to T0-13 first, and move T0-14 and T0-15 to the start of V2-1.

### V2-1: Quotations, the wedge (M)

**Owner gets:** Ask → confirm → a numbered quotation PDF to forward. Refrens retired.
**Blocked until:** the CA answers question 3 (C-19, installation treatment) if any quotation includes installation; the owner's Refrens quotations are collected (§4).
**Write first:** 04 §V2-1; 06's state machine plus the party and item templates; 07's reproduction test.

| ID | Task | Traces to |
|---|---|---|
| T1-01 | `gst_rate_schedule` and `hsn_codes`; rate resolved by (HSN/SAC, document date); `items.gst_rate` CHECK and contract `gstRate` follow the schedule; the item rate becomes a default | C-13, ADR 017 |
| T1-02 | Items gain `is_serialised` (`hsn_sac_code` already holds SAC codes and `is_stock_item = false` already marks a service); an SAC 9987 installation item; `gst.installation_treatment` honoured when building lines | C-19 |
| T1-03 | Import masters: customers through `scripts/import-customers.ts`; a new items importer through the same contract path; compare counts with the `LIMIT 500` cap | D-172, TODO 5 |
| T1-04 | Validators ARITH_LINE, ARITH_TAX, ARITH_TOTAL, GSTIN_FORMAT (with checksum), GSTIN_STATE, POS_SPLIT, RATE_SCHEDULE, HSN_DIGITS, PARTY_RESOLVED, ITEM_RESOLVED, each with a passing and a failing case | D-40, D-161, C-15, C-16 |
| T1-05 | Tools: read `searchCustomers`, `searchItems`, `getItem`, `getQuotation`, `listQuotations`; propose `proposeQuotation`, `proposePartyUpsert`, `proposeItemUpsert` (sub-proposals confirmed with the parent) | D-20, D-22 |
| T1-06 | Planner prompt v1 with business context (state code, filing profile, today, open proposals); totals always recomputed server-side; dates default to today and never fall in a closed period | D-21, D-24 |
| T1-07 | Issue → typed answer → new version for party and item issues only. The general engine is V2-4 | D-52, P-01 |
| T1-08 | Proposal card in Ask with Confirm; Edit opens the existing quotation builder pre-filled; confirm runs `createDraftQuotation` + `quotationLifecycle.submit` with `proposal_id` | D-14, D-15, D-131, D-132 |
| T1-09 | Chromium in the image; render the existing quotation print CSS on a `pdf` queue; store as a `generated` document linked to the quotation | D-100, ADR 024 |
| T1-10 | On confirm: customer upserted in CRM, follow-up date set; 24-hour undo runs the quotation cancel lifecycle | P-01, P-14, D-16 |
| T1-11 | Instrument time-to-quotation (first message to confirm) | 01 §7 |
| T1-12 | Reproduction test on the Refrens goldens; E2E Ask → quotation → PDF | D-163, D-164 |

**Exit criteria**
1. Proposed totals match every golden Refrens quotation exactly. Any intended difference (rounding, say) is written into 07 with its reason.
2. E2E Ask → proposal → confirm → numbered quotation → PDF passes in CI.
3. An unknown party or item produces exactly one question, not a failure. (P-01)
4. Median measured owner time ≤ 90 s for a known party and known items.
5. For two consecutive weeks, every quotation the owner issues comes from the system.

**Notes:** v1 quotations total the exact sum with no rupee rounding; Refrens may round. The reproduction test is where that shows up: settle it once under C-18, never per quotation. Check Chromium's memory on the Render plan inside T1-09 before building on it.

### V2-2: Outbound rail (L)

**Owner gets:** order, tax invoice, delivery challan, credit and debit notes, receipts, all from Ask; e-way bill flagged.
**Blocked until:** question 5 (interstate sales, unregistered buyers ≥ ₹50,000); the CA's rounding preference (C-18).
**Write first:** 04 §V2-2; ADR 025.

| ID | Task | Traces to |
|---|---|---|
| T2-01 | Debit notes as a second invoice kind beside the existing credit notes (`debit_note` and its `DBN-` series), each referencing the original invoice(s) | C-10, ADR 025 |
| T2-02 | `delivery_challans` + lines with serial numbers; non-sale movement reasons; Original / Duplicate / Triplicate print marks | C-09 |
| T2-03 | Receipt vouchers for advances, adjusted against later invoices; refund vouchers | C-11, C-23 |
| T2-04 | Stock adjustment reasons gift, free sample, lost, written off, beside the existing `theft`, `damage`, `expiry` | C-05 |
| T2-05 | Invoices gain `eway_required`, `eway_bill_no`, `delivery_challan_id`, `proposal_id`; payment entries gain `proposal_id` and the `other` mode | C-30, C-34 |
| T2-06 | Validators STOCK_AVAILABLE (reuses INSUFFICIENT_STOCK), SERIALS, EWAY_REQUIRED, B2C_ADDRESS, CASH_LIMIT | D-40, C-07, C-30, C-36 |
| T2-07 | Tools: read `listOpenInvoices`, `getStock`, `getPartyBalance`; propose `proposeSalesOrder`, `proposeInvoice` (including from a quotation or order), `proposeDeliveryChallan`, `proposeCreditNote`, `proposeDebitNote`, `proposeReceipt` | D-20 |
| T2-08 | PDFs: tax invoice with every Rule 46 particular and the signatory image; challan; notes; receipt | C-07, C-32, D-100 |
| T2-09 | 24-hour undo per type through its reversal; a warning when the counterparty already holds a copy | P-14, D-16 |
| T2-10 | Daily e-way document-age scan | C-30, D-111 |
| T2-11 | E2E quote → order → invoice → payment through Ask without opening a form | D-164 |

**Exit criteria**
1. The full chain runs through Ask in E2E. (J2)
2. A particulars test checks every C-07 field on the invoice PDF for B2B, B2C ≥ ₹50,000, and interstate cases.
3. For every type, the posted record is immutable and undo nets ledger and stock to zero.
4. Challan serials persist per line and can be queried (V2-7 builds on them).
5. The adoption clock starts: every sale is invoiced through the system. (01 §7)

### V2-3: Inbound capture (XL)

**Owner gets:** photograph a supplier bill or receipt; confirm; ledger, stock and payable are posted. No typed line items.
**Blocked until:** 05 is written for `purchase_bill`, `expense_receipt`, `transport_bilty`; the golden set is labelled (§4).
**Write first:** 05; 04 §V2-3; 07's thresholds and golden-set size.

| ID | Task | Traces to |
|---|---|---|
| T3-01 | Capture screen: multi-shot camera, resumable upload queue with progress, survives patchy mobile data | D-131, 01 §8 |
| T3-02 | Pipeline on pg-boss, per-stage state, each stage re-runnable for one document: ingest, convert (`pdfjs-dist` + `@napi-rs/canvas`, EXIF rotation, 2,000 px), quality gate, classify, extract, resolve, validate, propose, audit report | D-30 to D-38 |
| T3-03 | Prompts and zod extraction schemas per type; per-field confidence; page number on every monetary field | D-34 |
| T3-04 | Resolution: GSTIN exact, then `pg_trgm` name similarity; items by SKU, then description against the master and confirmed history; HSN fallback chain; rate by document date | D-35 |
| T3-05 | `purchases` module: `purchase_bills`, lines, `expenses`, `expense_categories` with `itc_blocked`; posting = ledger + stock (existing `receiveStock`) + payable in one transaction; reversal | J3, J4, C-01, C-02 |
| T3-06 | ITC eligibility per line; RCM on bilties with liability posting and payment voucher; asset-capitalisation proposal; 180-day unpaid mark per bill | C-20, C-21, C-22, C-37 |
| T3-07 | Validators DUP_DOC (hash, and supplier + bill number + FY), ITC_BLOCKED, RCM_FLAG, LOW_CONFIDENCE, CASH_LIMIT | D-40 |
| T3-08 | Confirm screen: source image beside the record, confidence markers, issues inline, one primary button | D-132 |
| T3-09 | Golden set and CI gate on recorded responses; nightly live-model run | D-162 |
| T3-10 | Security pass: instructions inside documents, upload limits, signed URL lifetime | D-141, D-142 |
| T3-11 | Supplier payments (a direction on `payment_entries` or a sibling table, per 04) that settle bills and stop the 180-day clock | C-21, C-34 |

**Exit criteria**
1. CI gate: ≥ 98% on amounts, GSTIN, document number, date; ≥ 95% on descriptions and HSN; ≥ 90% on expense category. (01 §7, J4)
2. A duplicate is blocked both by hash and by (supplier, bill number, FY).
3. Confirm posts ledger, stock and payable in one transaction; reversal nets all three to zero.
4. No blocked-ITC category ever yields claimable ITC (test over every Section 17(5) category in the list).
5. Cost per document type is visible from `llm_calls`, and the projected month is within ₹1,500 at the business's volume.
6. The owner uploads one real month of bills and every one reaches confirm.

### V2-4: Clarifications and digest (M)

**Owner gets:** one push a day with at most three items, ranked by money at risk; questions answered in place.
**Blocked until:** the service runs on an always-on paid instance (D-06).
**Write first:** 06 in full.

| ID | Task | Traces to |
|---|---|---|
| T4-01 | `clarifications`, `clarification_answers`, `digests`; a template for every `block` and `needs_input` validator code | D-50, D-51, ADR 023 |
| T4-02 | LLM tasks `phrase_question` and `parse_answer`; answers parsed into the typed answer kinds | D-51 |
| T4-03 | Answer → new version → revalidate → next question or `ready`. Generalises T1-07 | D-52 |
| T4-04 | Money-at-risk score per item kind | P-15 |
| T4-05 | Digest job at `digest.time_local`, capped at `digest.max_items`, never repeating an answered or dismissed question | D-53, D-111 |
| T4-06 | Web push (VAPID) through the service worker; email fallback for admin; daily cap | D-112 |
| T4-07 | Auto-post flag per inbound type with its unlock counter (30 unedited confirms); "posted automatically, tap to review"; outbound types refuse the flag | P-12, D-17, ADR 015 |

**Exit criteria**
1. No question is asked twice for the same fact (test).
2. Each answer type parses its fixtures to the typed value.
3. The digest ranks by money at risk, caps at three, and reaches the owner's phone.
4. A proposal with zero open questions posts in one tap.
5. Enabling auto-post on an outbound type is rejected.

### V2-5: Banking (L)

**Owner gets:** upload the monthly statement, batch-confirm the matches; the money view shows real cash, bank, receivables and payables.
**Blocked until:** question 4 (banks and formats) and the golden statements (§4).
**Write first:** 05 §bank_statement; 04 §V2-5.

| ID | Task | Traces to |
|---|---|---|
| T5-01 | `bank_accounts`, `bank_statement_imports` keyed on (account, period, hash), insert-only `bank_lines`, `bank_matches`; payment entries gain `bank_line_id` | D-80 |
| T5-02 | Statement extraction per page, then merge; running-balance check as a block validator | D-80, D-34 |
| T5-03 | Matching in code first: amount + party token within ± days; UPI reference or cheque number exact; recurring narrations learned from confirmed matches; the model only disambiguates narration → party | D-81 |
| T5-04 | `bank_match_batch` proposal; confirm screen with matched, suggested and unmatched lines; batch confirm posts through the khata and payment services; unmatched lines become clarifications | D-82, J5 |
| T5-05 | Cash book; a physical count is a journal, never an edit | D-83 |
| T5-06 | Money view: receivables ageing (existing `v_receivables_aging`), payables with the 180-day mark, bank and cash, upcoming dues; read tools for "how much does Sharma owe" | J9, D-84 |

**Exit criteria**
1. Zero amount errors on the golden statements.
2. ≥ 80% of lines auto-matched on a typical month.
3. After a month is confirmed, the books' bank balance equals the statement's closing balance.
4. The money view loads in under 2 s on a mid-range Android over mobile data, and a pending proposal never moves its numbers (test).

### V2-6: Monthly close (L)

**Owner gets:** a CA package by the 5th; an IMS action list before the 14th.
**Blocked until:** questions 1 and 2; a GSTR-1 JSON known to import cleanly; a real GSTR-2B JSON; the CA's word on the `VERIFY` points in C-10, C-21, C-25 and D-71's B2C-large threshold.
**Write first:** 04 §V2-6.

| ID | Task | Traces to |
|---|---|---|
| T6-01 | GSTR-2B import from the portal JSON the owner uploads | D-72, C-27 |
| T6-02 | Reconciliation and the IMS action list (accept / reject / pending, with reason and ITC per line); ITC-at-risk and not-ours totals; 2B reminder on the 15th | D-73, D-111 |
| T6-03 | Registers as views: sales, purchase, expense, output tax, ITC, RCM; CSV export | D-70, C-01 |
| T6-04 | GSTR-1 JSON: B2B, B2C large, B2C others, credit/debit notes (registered and unregistered), HSN Table 12 with B2B and B2C tabs, Table 13; the IFF subset for QRMP | D-71, C-15, C-25 |
| T6-05 | Liability per period (output − eligible ITC + RCM), shown before the PMT-06 date | D-74 |
| T6-06 | Close package zip with a cover note (open clarifications, unposted proposals); close job on the 1st | D-75, J7 |
| T6-07 | Filing dates in the digest; admin tick for "CA confirmed filed" | C-24 to C-29 |
| T6-08 | Turnover and cash-share reports for the CA's income-tax work | C-33 to C-35 |

**Exit criteria**
1. A real month's GSTR-1 JSON imports into the offline tool with no errors.
2. Every 2B entry is matched or listed with a reason; fixtures cover each reconciliation outcome.
3. The package is produced by the 5th with ≤ 3 open clarifications.
4. For one real month, 100% of 2B entries are classified before the 14th.

**Note:** see §2 for running T6-01 and T6-02 right after V2-3.

### V2-7: CRM and service (M)

**Owner gets:** any unit found by serial; AMC renewals and warranty expiries in the digest; service calls logged and billed.
**Blocked until:** the owner shows how AMC records are kept today (TODO 1).
**Write first:** 04 §V2-7 and the service section of 06 (the TODO 1 spike).

| ID | Task | Traces to |
|---|---|---|
| T7-01 | `installed_units`, backfilled from V2-2 challan and invoice serials; serial unique per item | D-90 |
| T7-02 | `amc_contracts` with units, period, visits; renewal reminder 30 days before the end date | D-91 |
| T7-03 | `service_tickets`: parts used issue stock; coverage warranty / AMC / billable; a billable ticket proposes an invoice with an SAC 9987 line through V2-2 | D-92, C-19 |
| T7-04 | `proposeServiceTicket`; customer timeline view and its read tool | D-93, D-20 |
| T7-05 | Daily AMC and warranty scan | D-111 |
| T7-06 | Import existing AMC contracts | |

**Exit criteria**
1. A unit's sale, install and tickets are one search away.
2. With a fixed clock, the renewal reminder fires 30 days before an AMC ends.
3. A billable ticket ends as a posted tax invoice, and its parts reduce stock.

### V2-8: Hardening and go-live (M)

**Owner gets:** the CA files from the system; the paper handover stops.

| ID | Task | Traces to |
|---|---|---|
| T8-01 | Restore drill: Neon point-in-time restore plus bucket versioning; re-verify every `documents.sha256` | D-120 |
| T8-02 | Error tracking, uptime monitor on `/healthz`, dead-letter and LLM-budget alerts | D-150, D-63 |
| T8-03 | `/cso` security pass; anything left of D-143 | D-140 to D-145 |
| T8-04 | Opening balances at the cutover date: customers through the existing rail; new paths for suppliers, opening stock and bank, all against account 3300; decide TODO 2 | D-172 |
| T8-05 | Runbook: deploy, restore, key rotation, raising the budget cap, month-end steps | |
| T8-06 | Parallel run: one month where the CA files from the package while still receiving paper; reconcile before the paper stops | D-173 |
| T8-07 | Confirm the 72-month retention setting and that no code path deletes a document | C-06 |

**Exit criteria**
1. The restore drill passes on both database and files.
2. The parallel month reconciles with no unexplained difference.
3. 01 §7's metrics hold for four consecutive weeks.

## 4. Inputs to collect before the phase that needs them

The build waits on these more than on code. Start the early ones now.

| Input | From | Needed by | Start |
|---|---|---|---|
| Question 3: installation billed as composite or separate (C-19) | CA | V2-1 | now |
| Refrens quotation history: the PDFs and the inputs behind them | Owner | V2-1 | now |
| Customer list and item list with HSN codes | Owner | V2-1 | now |
| Rounding presentation (C-18) | CA | V2-2 | now |
| Question 5: interstate sales; unregistered buyers ≥ ₹50,000 | Owner | V2-2 | V2-1 |
| Real supplier bills, expense receipts, transport bilties | Owner | V2-3 | V2-1 |
| Question 4: bank names, statement PDFs (two or more months per bank), cash share | Owner | V2-5 | V2-3 |
| Question 1: QRMP or monthly (visible on the portal) | Owner / CA | V2-6 | V2-3 |
| Question 2: ITR-4 or ITR-3 last year | CA | V2-6 | V2-3 |
| A GSTR-1 JSON that imports cleanly; a real GSTR-2B JSON | CA / portal | V2-6 | V2-3 |
| `VERIFY` points in 02 (C-10, C-17, C-20, C-21, C-23, D-71) | CA | the phase that implements each | as reached |
| Existing AMC records | Owner | V2-7 | V2-5 |
| Opening balances (parties, stock, bank) at the cutover date | CA / owner | V2-8 | V2-6 |

**Dates that do not wait for the build**

| Date | Why it matters |
|---|---|
| 14th of every month | GSTR-2B drafts; IMS inaction becomes deemed acceptance (C-27). Manual on the portal until T6-02 ships |
| 30 November 2026 | Last date for FY 2025-26 ITC and credit notes (C-10, C-21, `VERIFY`). No v2 phase is live by then; the CA handles it as today |
| 1 April 2027 | FY 2027-28 begins; T0-08 must be live |

## 5. Definition of done (every phase)

- The phase's sections of 04, 05, 06, 07 exist before its code.
- Migrations are additive and folded into `schema.sql` at the end of the phase. (D-170)
- Every v1 suite and every earlier phase's suite passes in CI; new suites follow D-160.
- Tests cite requirement IDs; PRs cite task IDs.
- Every changed decision has an ADR.
- `docs/implementation-notes.md` and the status column in 00 are updated.
- The phase's LLM cost is read from `llm_calls` and recorded.
- If the phase has an owner-facing result, it is deployed to `bizsuite-accounts` and the owner is using it.

## 6. The gstack loop per phase

| Step | Skill | When |
|---|---|---|
| Resume | `/context-restore` | Each session |
| Scope | `/office-hours` against this file and the phase's spec | Every phase start (00) |
| Architecture | `/plan-eng-review` on the 04 section and the interfaces | Every phase, before code |
| Screens | `/plan-design-review` | V2-0, V2-1, V2-3, V2-4, V2-5, V2-7 |
| Bugs | `/investigate` | As they come |
| Diff | `/review` | Every PR |
| Flows | `/qa` | Phases with screens |
| Security | `/cso` | V2-0, V2-3, V2-8 |
| Ship | `/ship`, with its commit and push steps replaced by printed `git add` / `git commit` commands the developer runs | Every phase end |
| Docs | `/document-release` | Every phase end |
| Save | `/context-save` | Each session end |

## 7. ADRs by phase

| Phase | ADRs |
|---|---|
| V2-0 | 013, 014, 015, 016, 018, 019, 020, 021 |
| V2-1 | 017, 024 |
| V2-2 | 025 |
| V2-4 | 023 |
| V2-6 | 022; new, if adopted: the IMS slice runs after V2-3 (§2) |
