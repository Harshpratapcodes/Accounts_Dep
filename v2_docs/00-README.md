# Bizsuite v2: the accounts department

> Entry point for the v2 documentation set, kept at `/v2_docs/` in the `bizsuite-accounts` repo.
> This repo is a one-time copy of Bizsuite v1 (the staff-operated ERP) at commit `25ae8c6`. v1 carries on unchanged in its own repo (`Harshpratapcodes/Bizsuite`), and fixes do not flow between the two. Here, v1's engine is kept and its app layer is replaced.

## What v2 is

An autonomous accounts department for one small Indian trading business (Kumar Abhiyantriki Enterprises, Lucknow: buys inventory, sells, delivers, installs, services). The owner feeds it documents (supplier bills, expense receipts, bank statements) and plain-language requests ("make a quotation for X"). The system keeps the legally required books, maintains the CRM and installed base, produces outbound documents as PDFs, asks for whatever is missing, and hands the CA a monthly filing package. Nothing is posted to the ledger without the owner's confirmation.

## The documents

| # | File | What it is | Status |
|---|---|---|---|
| 00 | `00-README.md` | This file: map, build sequence, ADR index | written |
| 01 | `01-PRD.md` | Product requirements: users, jobs to be done, autonomy policy, non-goals, metrics | written |
| 02 | `02-compliance-standard.md` | What a GST-registered trader must record, issue and file; numbered requirements (C-xx) that tests trace to | written |
| 03 | `03-system-design.md` | Architecture: modules, agent layer, extraction pipeline, proposal/confirm/post, clarifications, LLM gateway, jobs, storage, PDF, security | written |
| 04 | `04-schema-deltas.md` | DDL for every new and changed table against `schema.sql`, with triggers and invariants | next |
| 05 | `05-extraction-spec.md` | Per document type: fields, zod schema, prompts, validators, confidence rules, entity resolution | next |
| 06 | `06-clarification-spec.md` | Question templates, state machine, digest rules, answer parsing | next |
| 07 | `07-eval-harness.md` | Golden document set, scorers, thresholds, CI gate, real-quotation reproduction test | next |
| 08 | `08-build-plan.md` | Phases with tasks, exit criteria, and the gstack loop per phase | written |
| 09 | `CLAUDE.md` (v2) | Architectural rules and mentor-mode instructions for Claude Code | next |

Reading order for a coding agent: 00, 01, 02, 03, then 04 and 05 before writing any code in a phase, 08 for what to build now.

## How to use these with Claude Code

- The v2 `CLAUDE.md` (09) will point here; today the root `CLAUDE.md` is local-only (`.gitignore` excludes `claude.md`) and holds only the gstack skill routing. Every phase starts with `/office-hours` against `08-build-plan.md` and the relevant spec.
- Requirements are numbered (`C-12`, `P-04`, `D-07`). A test that enforces one names it in its description. A PR that touches one cites it.
- Anything marked `VERIFY` in `02-compliance-standard.md` is a fact we're confident of but have not had a CA confirm. Build to it, keep it configurable, and confirm before the first real filing.
- The v1 documents in this repo (`/system-design.md`, `/docs/implementation-notes.md`, and `/docs/adr/`, which holds only ADR 006) remain valid for the engine. v1's `blueprint.md` was its scope and phase tracker; for v2, `08-build-plan.md` takes that role. ADRs 001 to 005 and 007 to 012 were not imported and remain in the v1 repo. Where v2 contradicts v1, v2 wins; the contradiction is recorded as an ADR below.

## Build sequence (detail in 08)

| Phase | Goal | Delivers |
|---|---|---|
| V2-0 | Foundation | tag the import commit; own Render service and Neon database; `business_id`, config table, financial-year number series, `owner` role; helmet, rate limits, CSRF; documents + object storage; LLM gateway with cost log; proposal/confirm machinery; pg-boss; PWA shell with Inbox and Ask; eval harness skeleton |
| V2-1 | The wedge: quotations | "Make a quotation for…" → proposal → confirm → PDF + CRM upsert; GST rate schedule; customer and item masters imported; Chromium in the image for PDFs; golden set from the owner's existing Refrens quotations |
| V2-2 | Outbound rail | order, invoice, delivery challan, credit/debit note, payment receipt via Ask; e-way bill flag; invoice PDF |
| V2-3 | Inbound capture | supplier bill and expense receipt: extraction pipeline → proposal → confirm → ledger + stock + payables; supplier payments |
| V2-4 | Clarifications and digest | question engine, daily "three things I need", follow-ups, web push; needs an always-on Render plan |
| V2-5 | Banking | statement PDF import, bank book, matching engine, cash/receivables/payables view |
| V2-6 | Monthly close | GSTR-1 JSON, GSTR-2B import + IMS action list, sales/purchase registers, CA package zip |
| V2-7 | CRM and service | installed units (serial numbers), warranty, AMC contracts, service tickets, reminders |
| V2-8 | Hardening and go-live | backups + restore drill, monitoring, security pass, runbook, opening balances, real-month parallel run against the CA |

V2-1 ships before any extraction work because it is the owner's live pain (Refrens cap) and it builds the agent + proposal machinery that V2-3 reuses.

## ADR index for v2 (files to be written under `/docs/adr/`)

| ADR | Decision |
|---|---|
| 013 | Pivot from staff-operated ERP to owner-operated autonomous accounts department; no staff hire assumed, ever |
| 014 | Proposer/validator split: the LLM only ever produces typed proposals; deterministic validators and the existing service layer post; the LLM has no write path to the ledger |
| 015 | Confirm-to-post for every posting in v1; auto-post is a per-document-type flag, off by default, unlockable only after a run of edit-free confirms; outbound documents never auto-post |
| 016 | v2 is a one-time copy of v1 (`25ae8c6`) in its own repo, with its own Render service and Neon database; v1 continues separately and fixes do not flow between them; v2 keeps the engine and replaces the app layer |
| 017 | Effective-dated GST rate schedule keyed by HSN/SAC; `items.gst_rate` becomes a default, not the truth |
| 018 | OpenRouter as the single LLM gateway with model routing by task and an eval gate on every prompt or model change |
| 019 | Postgres-backed job queue (pg-boss) over Redis, to keep the one-container + Neon shape |
| 020 | S3-compatible object storage for documents (Render disk is not the system of record) |
| 021 | PWA with camera first; WhatsApp Business API deferred to v2.x |
| 022 | Compliance outputs are files the CA imports (GSTR-1 JSON, registers, Tally XML later), not a CA login |
| 023 | Clarifications are generated by validators from templates, never free-formed by the LLM; the LLM phrases and parses, it does not decide what to ask |
| 024 | Server-side PDF renders the same print-CSS templates the screen uses, via headless Chromium in the image |
| 025 | Credit and debit notes stay kinds of `invoices` (as the engine already models credit notes), not separate tables |

## Glossary

- **Document**: an uploaded file (photo, PDF) or an outbound file we produced.
- **Proposal**: a typed, validated draft of a business record (quotation, purchase bill, bank match) produced by the agent or the extraction pipeline, awaiting confirmation.
- **Confirmation**: the owner's explicit approval of a proposal; the only thing that triggers a posting.
- **Posting**: a call into the v1 service layer inside a transaction, with triggers enforcing balance, immutability, period locks.
- **Clarification**: a structured question attached to a proposal or document, answered by the owner.
- **Digest**: the once-a-day summary of pending confirmations and clarifications, capped at three items by money at risk, with follow-ups until cleared.
- **Close package**: the monthly bundle handed to the CA.
