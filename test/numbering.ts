/**
 * Numbering by financial year (C-08, T0-08) and the business date (IST).
 *
 * One gap-free series per document type per FY, chosen by the document's own
 * date. Exit criterion 6 of V2-0: with a fixed clock, a document dated
 * 2027-04-01 numbers from the FY 2027-28 series. Also covers the
 * first-of-year race (many submitters creating a new FY's series at once),
 * Rule 46's 16-character limit (C-07), and that "today" is the date in India
 * in both the app and the database.
 */
import "./support/local-db-only.js"; // first: refuses a non-local database
import { createUser } from "../src/core/auth.js";
import { nextDocNumber } from "../src/core/numbering.js";
import { pool, withTransaction } from "../src/shared/db.js";
import { businessToday, fyStartYear, setFixedToday } from "../src/shared/clock.js";
import { fromPgError } from "../src/shared/errors.js";
import { createDraftInvoice, invoiceLifecycle } from "../src/modules/invoicing/service.js";
import { createDraftQuotation, quotationLifecycle } from "../src/modules/sales/quotations.service.js";
import { createDraftPayment, paymentLifecycle } from "../src/modules/invoicing/payments.service.js";
import { postManualJournal } from "../src/modules/accounting/journals.service.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query<T>(sql, params)).rows;

/** The trailing counter of a CODE-YYYY-NNNNN number. */
const seq = (docNo: string) => Number(docNo.split("-")[2]);

async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "none"; }
  catch (e) { return fromPgError(e).code; }
}

async function main() {
  const stamp = Date.now();

  // ---- setup: company (UP/09), a customer, a service item (no stock needed) ----
  await q(`INSERT INTO company_settings (id, legal_name, gstin, state_code)
           VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
           ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);
  const [customer] = await q<{ id: string }>(
    `INSERT INTO companies (name, gstin, gst_treatment, state_code, is_customer)
     VALUES ('FY Customer ' || substr(gen_random_uuid()::text,1,8),
             '09AAACA1234A1Z5','registered','09', true) RETURNING id`);
  const [service] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate, is_stock_item)
     VALUES ('FY-' || substr(gen_random_uuid()::text,1,8), 'Installation', '9987', 18, false) RETURNING id`);
  const [wh] = await q<{ id: string }>(
    `INSERT INTO warehouses (name) VALUES ('FY-WH-' || $1) RETURNING id`, [String(stamp)]);
  const { id: adminId } = await createUser({
    email: `fy_admin_${stamp}@test.com`, fullName: "FY Admin", password: "Pw!", roleName: "admin" });
  const [cashAcct] = await q<{ id: string }>(`SELECT id FROM accounts WHERE system_key = 'cash'`);
  const [capital] = await q<{ id: string }>(`SELECT id FROM accounts WHERE system_key = 'capital'`);

  const invoiceDated = (docDate: string) => createDraftInvoice({
    customerId: customer!.id, warehouseId: wh!.id, placeOfSupply: "09", docDate,
    lines: [{ itemId: service!.id, description: "Installation", hsn: "9987", qty: "1", rate: "1000.00", gstRate: 18 }],
  }, adminId);

  try {
    console.log("== FINANCIAL YEAR BOUNDARY (1 April) ==");
    const boundaries: [string, number][] = [
      ["2027-03-31", 2026], ["2027-04-01", 2027], ["2026-01-15", 2025], ["2026-12-31", 2026],
    ];
    for (const [date, fy] of boundaries) {
      const [sql] = await q<{ fy: number }>(`SELECT fn_fy_start_year($1::date) AS fy`, [date]);
      check(`${date} is in FY ${fy}-${String(fy + 1).slice(2)} (SQL)`, sql!.fy === fy, String(sql!.fy));
      check(`${date} is in FY ${fy}-${String(fy + 1).slice(2)} (app)`, fyStartYear(date) === fy, String(fyStartYear(date)));
    }

    console.log("== IMPORTED SERIES MAPPED TO FY 2026-27 ==");
    const imported = await q<{ series: string; series_code: string; fy_start_year: number }>(
      `SELECT series, series_code, fy_start_year FROM document_sequences
        WHERE series IN ('QTN-2026','SO-2026','INV-2026','CRN-2026','PAY-2026','JV-2026','PRC-2026','ADJ-2026')`);
    check("all 8 imported series present", imported.length === 8, String(imported.length));
    check("each keyed to its code and FY 2026-27",
      imported.every((r) => r.fy_start_year === 2026 && r.series === `${r.series_code}-2026`));

    console.log("== FIXED CLOCK: DOCUMENTS DATED 2027-04-01 NUMBER FROM FY 2027-28 (exit criterion 6) ==");
    setFixedToday(null);
    const realToday = businessToday();
    if (realToday < "2027-04-01") {
      const early = await errorCode(() => invoiceDated("2027-04-01"));
      check("on the real clock a 2027-04-01 invoice is future-dated -> INVALID_DATE", early === "INVALID_DATE", early);
    }

    setFixedToday("2027-04-01");
    const inv1 = await invoiceDated("2027-04-01");
    const sub1 = await invoiceLifecycle.submit(inv1.id, adminId);
    check("invoice dated 2027-04-01 -> INV-2027-NNNNN", /^INV-2027-\d{5}$/.test(sub1.docNo), sub1.docNo);
    const [je1] = await q<{ entry_no: string; posting_date: string }>(
      `SELECT je.entry_no, je.posting_date::text FROM invoices i
         JOIN journal_entries je ON je.id = i.journal_entry_id WHERE i.id = $1`, [inv1.id]);
    check("its sales journal -> JV-2027-NNNNN", /^JV-2027-\d{5}$/.test(je1!.entry_no), je1!.entry_no);
    check("journal posted on the invoice date", je1!.posting_date === "2027-04-01", je1!.posting_date);

    // A late entry for the old year, keyed in after rollover, takes the old series.
    const late = await invoiceDated("2027-03-31");
    const lateSub = await invoiceLifecycle.submit(late.id, adminId);
    check("invoice dated 2027-03-31, submitted after rollover -> INV-2026-NNNNN",
      /^INV-2026-\d{5}$/.test(lateSub.docNo), lateSub.docNo);

    const inv2 = await invoiceDated("2027-04-01");
    const sub2 = await invoiceLifecycle.submit(inv2.id, adminId);
    check("next FY 2027-28 invoice is consecutive (the old-year entry took no number from it)",
      /^INV-2027-/.test(sub2.docNo) && seq(sub2.docNo) === seq(sub1.docNo) + 1, `${sub1.docNo} -> ${sub2.docNo}`);

    const qtn = await createDraftQuotation({
      customerId: customer!.id, placeOfSupply: "09", docDate: "2027-04-01",
      lines: [{ itemId: service!.id, description: "Installation", hsn: "9987", qty: "1", rate: "500.00", gstRate: 18 }],
    }, adminId);
    const qtnSub = await quotationLifecycle.submit(qtn.id, adminId);
    check("quotation dated 2027-04-01 -> QTN-2027-NNNNN", /^QTN-2027-\d{5}$/.test(qtnSub.docNo), qtnSub.docNo);

    const pay = await createDraftPayment({
      customerId: customer!.id, amount: "100.00", mode: "upi", depositAccountKey: "bank", docDate: "2027-04-01",
    }, adminId);
    const paySub = await paymentLifecycle.submit(pay.id, adminId);
    check("payment dated 2027-04-01 -> PAY-2027-NNNNN", /^PAY-2027-\d{5}$/.test(paySub.docNo), paySub.docNo);

    const mj = await postManualJournal({
      postingDate: "2027-04-01", narration: "FY rollover test",
      lines: [
        { accountId: cashAcct!.id, debit: "10.00", credit: "0.00" },
        { accountId: capital!.id, debit: "0.00", credit: "10.00" },
      ],
    }, adminId);
    check("manual journal dated 2027-04-01 -> JV-2027-NNNNN", /^JV-2027-\d{5}$/.test(mj.entryNo), mj.entryNo);

    // Cancelling reverses on the business date (the fixed clock does not move
    // the database's CURRENT_DATE, so this checks the reversal's own series).
    await invoiceLifecycle.cancel(inv2.id, adminId);
    const [rev] = await q<{ entry_no: string; posting_date: string }>(
      `SELECT entry_no, posting_date::text FROM journal_entries
        WHERE reverses_id = (SELECT journal_entry_id FROM invoices WHERE id = $1)`, [inv2.id]);
    check("reversal journal numbered from the FY of its own posting date",
      rev!.entry_no.startsWith(`JV-${fyStartYear(rev!.posting_date)}-`), `${rev!.posting_date} ${rev!.entry_no}`);
    setFixedToday(null);

    const [fySeries] = await q<{ series_code: string; fy_start_year: number; prefix: string }>(
      `SELECT series_code, fy_start_year, prefix FROM document_sequences WHERE series = 'INV-2027'`);
    check("FY 2027-28 invoice series was created on first use",
      fySeries?.series_code === "INV" && fySeries.fy_start_year === 2027 && fySeries.prefix === "INV-2027-");

    console.log("== FIRST-OF-YEAR RACE: 8 SUBMITTERS ARRIVE WHILE THE FIRST HOLDS THE NEW FY OPEN ==");
    // A year no other run has used, so the series row does not exist yet.
    // Forced interleaving, not a hopeful Promise.all: the first submitter
    // creates the FY's series row and holds its transaction open; the test
    // waits until Postgres shows the other 8 blocked behind it, then lets it
    // commit. A check-then-insert implementation fails here every time.
    const raceFy = 3000 + (stamp % 5000);
    const raceDate = `${raceFy}-04-01`;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let opened!: () => void;
    const firstOpened = new Promise<void>((r) => { opened = r; });
    const first = withTransaction(adminId, async (tx) => {
      const n = await nextDocNumber(tx, "ADJ", raceDate);
      opened();
      await gate;
      return n;
    });
    await firstOpened;
    const followers = Array.from({ length: 8 }, () =>
      withTransaction(adminId, (tx) => nextDocNumber(tx, "ADJ", raceDate)));
    let blocked = 0;
    for (let i = 0; i < 100 && blocked < 8; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const [w] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      blocked = w!.n;
    }
    check("all 8 followers were blocked behind the first's open transaction", blocked === 8, String(blocked));
    release();
    const results = await Promise.allSettled([first, ...followers]);
    const won = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled").map((r) => r.value);
    check("all 9 got a number", won.length === 9, JSON.stringify(results.filter((r) => r.status === "rejected")));
    const nums = won.map(seq).sort((a, b) => a - b);
    check("numbers are 1..9: no duplicate, no gap", nums.join(",") === "1,2,3,4,5,6,7,8,9", nums.join(","));
    check("all from the new FY's series", won.every((n) => n.startsWith(`ADJ-${raceFy}-`)));
    const [rows] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_sequences WHERE series_code = 'ADJ' AND fy_start_year = $1`, [raceFy]);
    check("exactly one series row for that FY", rows!.n === "1", rows!.n);

    console.log("== ROLLBACK RETURNS THE NUMBER (gapless) ==");
    const before = await withTransaction(adminId, (tx) => nextDocNumber(tx, "ADJ", `${raceFy}-05-01`));
    await withTransaction(adminId, async (tx) => {
      await nextDocNumber(tx, "ADJ", `${raceFy}-05-01`);
      throw new Error("abort");
    }).catch(() => undefined);
    const after = await withTransaction(adminId, (tx) => nextDocNumber(tx, "ADJ", `${raceFy}-05-01`));
    check("a rolled-back allocation leaves no gap", seq(after) === seq(before) + 1, `${before} -> ${after}`);

    console.log("== GUARDS ==");
    const unknown = await errorCode(() => withTransaction(adminId, (tx) =>
      tx.query(`SELECT next_doc_number('XYZ', '2026-10-01'::date)`)));
    check("unknown series code -> UNKNOWN_SERIES", unknown === "UNKNOWN_SERIES", unknown);
    const undated = await errorCode(() => withTransaction(adminId, (tx) =>
      tx.query(`SELECT next_doc_number('INV', NULL::date)`)));
    check("no document date -> UNKNOWN_SERIES (refused, not defaulted)", undated === "UNKNOWN_SERIES", undated);
    const tooLong = await errorCode(() => withTransaction(adminId, (tx) =>
      tx.query(`INSERT INTO number_series (code, description, padding) VALUES ('ABCD', 'too long', 7)`)));
    check("a series whose numbers would exceed 16 chars is refused (C-07)", tooLong === "CONSTRAINT_VIOLATION", tooLong);
    // Credit notes have their own series (C-10) but no posting path yet: the
    // invoice posting would book one backwards. It must be refused, and the
    // CRN number it drew must roll back with it.
    const crnDraft = await invoiceDated(realToday);
    await q(`UPDATE invoices SET kind = 'credit_note', against_invoice_id = $2 WHERE id = $1`, [crnDraft.id, inv1.id]);
    const crnBefore = await q<{ v: string }>(
      `SELECT current_value::text AS v FROM document_sequences WHERE series_code = 'CRN' AND fy_start_year = $1`,
      [fyStartYear(realToday)]);
    const crn = await errorCode(() => invoiceLifecycle.submit(crnDraft.id, adminId));
    check("submitting a credit note through the invoice posting -> NOT_SUPPORTED", crn === "NOT_SUPPORTED", crn);
    const crnAfter = await q<{ v: string }>(
      `SELECT current_value::text AS v FROM document_sequences WHERE series_code = 'CRN' AND fy_start_year = $1`,
      [fyStartYear(realToday)]);
    check("and its CRN number rolled back", (crnBefore[0]?.v ?? "0") === (crnAfter[0]?.v ?? "0"),
      `${crnBefore[0]?.v} -> ${crnAfter[0]?.v}`);
    const [crnRow] = await q<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [crnDraft.id]);
    check("the credit note stays a draft", crnRow?.status === "draft", crnRow?.status);

    const issued = await q<{ doc_no: string }>(
      `SELECT doc_no FROM invoices WHERE doc_no IS NOT NULL
       UNION ALL SELECT doc_no FROM quotations WHERE doc_no IS NOT NULL
       UNION ALL SELECT entry_no FROM journal_entries WHERE entry_no IS NOT NULL`);
    check("every issued number is <= 16 chars of letters, digits, '-' or '/' (C-07)",
      issued.every((r) => r.doc_no.length <= 16 && /^[A-Z0-9/-]+$/.test(r.doc_no)),
      issued.find((r) => r.doc_no.length > 16)?.doc_no ?? "");

    console.log("== BUSINESS DATE IS THE DATE IN INDIA ==");
    const inTx = await withTransaction(null, async (tx) =>
      (await tx.query<{ tz: string; today: string }>(
        `SELECT current_setting('TimeZone') AS tz, CURRENT_DATE::text AS today`)).rows[0]!);
    check("posting transactions run on Asia/Kolkata", inTx.tz === "Asia/Kolkata", inTx.tz);
    check("CURRENT_DATE in a transaction = businessToday()", inTx.today === businessToday(), `${inTx.today} vs ${businessToday()}`);
    const [plain] = await q<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    check("plain reads (views, ageing) also run on Asia/Kolkata", plain!.tz === "Asia/Kolkata", plain!.tz);
  } finally {
    setFixedToday(null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
