# BizSuite — Backend Scaffold (Phase 0 + Phase 1 core)

Reference implementation of the modular-monolith design. Companion docs:
`../README.md` (what/why/architecture), `../blueprint.md` (scope/phases/tracker),
`../system-design.md` (architecture; §11 maps design→built), `../schema.sql`.

## v2 (bizsuite-accounts): what has landed

Plan: `v2_docs/08-build-plan.md`. Schema design: `v2_docs/04-schema-deltas.md`.

- **V2-0 0.B, engine corrections** (T0-06, T0-07, T0-08), as migrations
  `migrations/0001` to `0004`, applied at boot by `src/shared/migrate.ts`:
  - `business` + `business_id` on every business table; the `owner` role
    (full books, reads `core`); SPA role checks via `hasFullBooks()`
  - the business date is IST (`src/shared/clock.ts`, database `TimeZone`,
    per-transaction `set_config`); SPA form defaults use the same date
  - number series per financial year, chosen by document date
    (`nextDocNumber(tx, code, docDate)`); `INV-2027-00001` is FY 2027-28
  - effective-dated config (`src/core/config.ts`, `/api/config`), seeded
    from 02 §8; undecided keys fail with `CONFIG_UNSET`
  - document engine locks the row before submit/cancel (fixes a v1
    double-cancel race that double-reversed the books); invoice posting
    refuses `credit_note` rows until V2-2 builds their path
- **V2-0 T0-09, HTTP hardening** (D-143), `src/core/security.ts`:
  - helmet with an explicit CSP: own origin plus Google Fonts only, no
    framing, no inline script; `Referrer-Policy: same-origin` (helmet's
    `no-referrer` would make browsers send `Origin: null` on our own POSTs);
    HSTS and upgrade-insecure-requests in production only.
    `e2e/csp.spec.ts` walks every screen and fails on any violation.
    T0-10 must add the storage bucket's origin (signed URLs) to `img-src`
    and `connect-src`; T3-01 adds `blob:` for camera previews
  - CSRF without tokens: state-changing `/api` requests are refused (403
    `CROSS_SITE_REQUEST`) when `Sec-Fetch-Site` is anything but
    `same-origin`, or, lacking it, when `Origin` is not our own. A request
    with neither did not come from a browser. On top of SameSite=Lax
  - login limits per client IP: 30 attempts/min (bounds argon2 work), 10
    failures/15 min (successes don't count); 429 `RATE_LIMITED` with
    Retry-After. Ask and upload get theirs when those routes land (T0-15,
    T0-10), from the same `limiter()` factory, keyed per user
  - login runs argon2 for unknown and inactive accounts too, so timing no
    longer reveals which emails exist
  - malformed JSON is 400 `BAD_JSON`, not a logged 500
  - `npm audit fix`: proxy-addr (critical, IP spoofing behind a proxy,
    which per-IP limits depend on), qs, body-parser, express. Left:
    react-router (2 moderate, need v7; neither reachable: no SSR, no
    attacker-controlled navigation) and dev-only vite/vitest/esbuild
    (need majors)
  - deploy check: after the first production login, `SELECT ip FROM
    sessions ORDER BY created_at DESC LIMIT 1` must show the real client
    address. If it shows a Render/Cloudflare address, `trust proxy` is
    wrong and every user shares one rate-limit bucket
- **Tests refuse a non-local database** (`test/support/local-db-only.ts`,
  imported first by every suite and the E2E seed): suites write permanent
  ledger records. Set `DATABASE_URL` to a local database when `.env` points
  elsewhere; a deliberate remote test database is allowed with
  `BIZSUITE_TEST_REMOTE_DB=<its hostname>`

## What's implemented
- **shared/** — `money.ts` (integer-paise arithmetic, zero floats), `db.ts`
  (node-postgres pool + `withTransaction` that sets `app.user_id` for audit
  triggers), `errors.ts` (Postgres trigger errors → typed app errors)
- **core/** — `numbering.ts` (gapless doc numbers), `document-engine.ts`
  (generic DRAFT→SUBMITTED→CANCELLED lifecycle with onSubmit/onCancel hooks),
  `auth.ts` (argon2id passwords + SHA-256-hashed opaque session tokens, 30-day
  TTL), `middleware.ts` (`requireAuth`, session cookie), `rbac.ts`
  (`requirePermission` guard over the seeded 5-role `role_permissions` matrix)
- **modules/accounting** — `postJournal` (draft→lines→posted, app-level balance
  assert + DB deferred trigger), `reverseJournal` (original stays posted;
  original + reversal net to zero); **chart of accounts** (`accounts.service.ts`
  — ERPNext Account model: tree, root_type→report_type, group rollup, balances
  derived from posted lines; create/archive with system-account guards), the
  ledger reports **trial balance** (nets to a balanced grand total) and
  **general ledger** (opening → running → closing per account), **manual
  journal entries** (`journals.service.ts` — balanced account-id postings as
  `manual_journal`/JV-2026; admin-only reversal, original stays posted), and
  **financial periods** (`periods.service.ts` + a `journal_entries` trigger:
  closing a month blocks any posting dated inside it, across every module)
- **modules/inventory** — `lockStock` (ordered FOR UPDATE = the concurrency
  control point), `issueStock`, `receiveStock` (moving-average revaluation);
  `items` master (CRUD service + routes: SKU, HSN/SAC, GST rate, reorder level)
- **modules/crm** — `companies` master (CRUD service + routes: customer/supplier,
  GST treatment, GSTIN validation, billing/shipping addresses)
- **modules/invoicing** — GST math (per-line half-up rounding, CGST/SGST vs
  IGST by place of supply, rupee rounding adjustment), `createDraftInvoice`,
  `updateDraftInvoice` (draft-only full replace — the edit-and-retry rail),
  invoice detail endpoint (header + lines + parties, print-ready), and the
  **reference lifecycle**: submit = lock → number → sales journal →
  stock issues → COGS journal in one transaction; cancel = full reversal
- **modules/sales** — the ERPNext/Odoo standard chain
  **quotation → sales order → invoice** (all non-posting until the invoice):
  - `quotations`: `createDraftQuotation`/`updateDraftQuotation`, a no-op
    submit/cancel `quotationLifecycle` (issues `QTN-2026`, freezes lines, touches
    no ledger or stock); grand total is the exact sum (estimate)
  - `sales_orders`: `createDraftSalesOrder`/`updateDraftSalesOrder`,
    `salesOrderLifecycle` (issues `SO-2026`; cancel blocked once invoiced),
    `createSalesOrderFromQuotation` (quote → draft SO, no re-entry) and
    `createInvoiceFromSalesOrder` (SO → draft invoice via `createDraftInvoice`,
    linked by `invoices.sales_order_id`). Rounds to the rupee; **billing status
    is derived** from the submitted invoices raised against the order
  - reuses the invoicing GST math (`computeGst`)
- **frontend/** — operator SPA (staff-usable bar, Bizesuite design system):
  Odoo-style **home launcher** + per-app workspace shell (topbar app switcher,
  per-app hues); khata, payments, opening balances, invoice register, and the
  **guided invoice flow** — new sale → server-computed review → submit →
  print-CSS tax invoice; drafts resume from the register; INSUFFICIENT_STOCK
  surfaces in plain language with edit-and-retry. Plus the **quotation** and
  **sales order** apps — register → guided builder → server-computed review →
  submit → print-CSS document → convert down the chain (quote → order → invoice)
- **server.ts** — Express app: auth routes, masters routes, and the invoice
  lifecycle, all zod-validated and behind `requireAuth` + `requirePermission`

## Run
`DATABASE_URL` (environment or `.env`) wins over the `PG*` vars below. If
`.env` points at a hosted database, run tests with
`DATABASE_URL=postgresql://postgres@localhost:5432/bizsuite`; the suites refuse
a non-local database otherwise.
```bash
createdb bizsuite && psql -d bizsuite -v ON_ERROR_STOP=1 -f schema.sql
npm install
PGDATABASE=bizsuite npm run migrate              # v2 deltas (also applied at server boot)
PGDATABASE=bizsuite npm run test:integration    # 25 assertions, full quote-to-cash
PGDATABASE=bizsuite npm run test:auth           # login/session/logout over real HTTP
PGDATABASE=bizsuite npm run test:rbac           # role_permissions + route guard
PGDATABASE=bizsuite npm run test:masters        # items & companies CRUD + RBAC
PGDATABASE=bizsuite npm run test:quotations     # quotation lifecycle + convert + RBAC
PGDATABASE=bizsuite npm run test:sales-orders    # sales order lifecycle + billing + RBAC
PGDATABASE=bizsuite npm run test:accounting      # chart of accounts + trial balance + GL
PGDATABASE=bizsuite npm run test:journals        # manual journal post + reversal + RBAC
PGDATABASE=bizsuite npm run test:periods         # period close/reopen + posting lock
PGDATABASE=bizsuite npx tsx test/concurrency.ts # 5 parallel sales, 1 unit, 1 winner; same-doc races
PGDATABASE=bizsuite npm run test:numbering      # FY series, rollover, first-of-year race (C-08)
PGDATABASE=bizsuite npm run test:config         # effective-dated config (C-14)
PGDATABASE=bizsuite npm run test:business       # business_id everywhere, owner role
PGDATABASE=bizsuite npm run test:security       # headers, CSRF, login limits and timing
PGDATABASE=bizsuite npm run dev                 # API on :3000
```

## Test status (last full run: 2026-07-16, Neon cloud Postgres 18.4)
- integration: **25/25** — moving average, GST totals, balanced journals,
  COGS at valuation, sub-ledger, outstanding view, oversell rollback,
  cancellation reversal, GL-zero + stock-cache integrity, audit attribution
- **khata rail: 35/35** — opening balances (idempotent, 422/403/409 guards),
  on-account + allocated payments (staff-role submit end-to-end per D4),
  partial-payment status, cancel-as-reversal nets to zero, invoice list,
  Friday digest incl. empty-week
- concurrency: **PASS** — 5 parallel submitters, exactly 1 success,
  losers fail with `INSUFFICIENT_STOCK`, ledgers consistent after
- auth 14/14 / rbac 18/18 (regression-updated for the D4 grant) / masters 17/17
- **quotations: 27/27** — non-posting GST math (intra CGST+SGST, no rupee
  rounding), draft edit, QTN numbering on submit, immutable-after-submit,
  quote → draft **sales order** conversion (linked, one-time), admin-only cancel
- **sales-orders: 30/30** — non-posting GST (rounded), draft edit, SO numbering,
  immutable-after-submit, SO → draft invoice link, **derived billing status**
  (Not/Fully Billed from submitted invoices), one-time billing, cancel blocked
  once invoiced, admin-only cancel
- **accounting: 17/17** — chart-of-accounts tree, create with inherited root
  type, archive guards (system account 409, non-group parent 422), **trial
  balance balances** (grand debit == grand credit), general ledger for the
  Debtors control account, RBAC
- **journals: 17/17** — balanced manual post (JV numbering), validation guards
  (unbalanced/both-sided line/group account/future date → 422), RBAC (accounts
  posts, readonly 403, reverse admin-only), reversal nets to zero (trial balance
  still balances), one-time + manual-only reversal
- **periods: 12/12** — open/close (admin-only), the posting lock (closed period
  → `PERIOD_CLOSED` on any dated entry), reopen restores, other periods
  unaffected, RBAC
- **Playwright E2E 8/8** (`npm run test:e2e`, real SPA + real DB): khata rail
  (golden payment journey, role gating) + invoice rail (guided invoice → server
  totals → submit → khata; insufficient-stock edit-and-retry; admin-only
  cancel; draft resume from the register)

CI: `.github/workflows/ci.yml` loads `schema.sql`, applies `migrations/`, then
runs typecheck, the fifteen tsx suites, Vitest and Playwright against a
Postgres 16 service on every push/PR.

## Environment
Copy `.env.example` → `.env`. Either set `DATABASE_URL` (cloud/Neon, keep
`sslmode=require` in the URL) or the `PG*` vars (local). `.env` is gitignored;
CI sets real env vars and ignores it.

## Deploy (Render + Neon)
Same one-container shape as Odoo/ERPNext: a single always-on process (Express
API + built SPA) against an external Postgres.

- `Dockerfile` — multi-stage: build the SPA, then a prod-deps-only runtime
  (`node --import tsx src/server.ts`). Runs anywhere (Render/Fly/Koyeb/VPS).
- `render.yaml` — Render Blueprint: one Docker web service in **Virginia**
  (matches the Neon `us-east-1` DB), health check on `/healthz`, deploys on
  every push to `main`. `DATABASE_URL` is entered in the dashboard, never
  committed.

First-time setup: Render dashboard → New → Blueprint → pick this GitHub repo →
it reads `render.yaml` → paste the Neon **pooled** `DATABASE_URL` when
prompted. Free tier sleeps after ~15 min idle (cold start on wake); upgrade to
Starter when the business depends on it.

## Next
v2 work follows `v2_docs/08-build-plan.md`. The v1 roadmap that stood here
(blueprint.md) is superseded.
