/** THE inventory race: N parallel submissions competing for stock that can
 *  satisfy only one. Exactly one must win; losers must roll back cleanly. */
import "./support/local-db-only.js"; // first: refuses a non-local database
import { pool, withTransaction } from "../src/shared/db.js";
import { lockStock, receiveStock } from "../src/modules/inventory/service.js";
import { createDraftInvoice, invoiceLifecycle } from "../src/modules/invoicing/service.js";
import { toPaise } from "../src/shared/money.js";

const q = async <T extends Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await pool.query<T>(sql, p)).rows;

async function main() {
  const [u] = await q<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, role_id)
     VALUES ('race@test.com','Racer','x',(SELECT id FROM roles WHERE name='admin'))
     ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`);
  const userId = u!.id;
  const [c] = await q<{ id: string }>(`INSERT INTO companies (name) VALUES ('Race Co ' || gen_random_uuid()) RETURNING id`);
  const [w] = await q<{ id: string }>(`INSERT INTO warehouses (name) VALUES ('Race-WH-' || gen_random_uuid()) RETURNING id`);
  const [i] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('RACE-' || substr(gen_random_uuid()::text,1,8), 'Last Widget', '8471', 18) RETURNING id`);

  // exactly ONE unit in stock
  await withTransaction(userId, async (tx) => {
    const lines = [{ itemId: i!.id, warehouseId: w!.id, qty: "1.000", ratePaise: toPaise("500.00") }];
    await receiveStock(tx, await lockStock(tx, lines), lines, { type: "purchase_receipt", id: crypto.randomUUID() }, userId);
  });

  // five drafts, each wanting that one unit
  const N = 5;
  const drafts = await Promise.all(Array.from({ length: N }, () =>
    createDraftInvoice({
      customerId: c!.id, warehouseId: w!.id, placeOfSupply: "09",
      lines: [{ itemId: i!.id, description: "Last Widget", hsn: "8471", qty: "1.000", rate: "999.00", gstRate: 18 }],
    }, userId)));

  // fire all submissions truly in parallel
  const results = await Promise.allSettled(drafts.map((d) => invoiceLifecycle.submit(d.id, userId)));
  const wins = results.filter((r) => r.status === "fulfilled");
  const losses = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

  console.log(`parallel submitters: ${N}`);
  console.log(`winners: ${wins.length}  losers: ${losses.length}`);
  console.log(`loser error codes: ${[...new Set(losses.map((l) => (l.reason as { code?: string }).code))].join(", ")}`);

  const [stock] = await q<{ qty_on_hand: string }>(
    `SELECT qty_on_hand::text FROM item_warehouse WHERE item_id=$1 AND warehouse_id=$2`, [i!.id, w!.id]);
  const [gl] = await q<{ ok: boolean }>(`SELECT ok FROM fn_verify_gl() WHERE check_name='gl_sums_to_zero'`);
  const mism = await q(`SELECT * FROM fn_verify_stock_cache()`);

  const stockPass = wins.length === 1
    && losses.every((l) => (l.reason as { code?: string }).code === "INSUFFICIENT_STOCK")
    && stock!.qty_on_hand === "0.000" && gl!.ok && mism.length === 0;

  console.log(`final stock: ${stock!.qty_on_hand} | GL balanced: ${gl!.ok} | cache mismatches: ${mism.length}`);

  // THE same-document race: a double-tapped Submit or Cancel. Before the engine
  // locked the document row, two cancels both saw 'submitted' and both posted
  // a reversal (9 of 10 trials), leaving the customer under-billed. Ten trials:
  // the race reproduced on almost every one, so a regression cannot hide.
  const [svc] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate, is_stock_item)
     VALUES ('RACE-SVC-' || substr(gen_random_uuid()::text,1,8), 'Service', '9987', 18, false) RETURNING id`);
  let doubleSubmits = 0, doubleReversals = 0, badLosers = 0;
  for (let t = 0; t < 10; t++) {
    const d = await createDraftInvoice({
      customerId: c!.id, warehouseId: w!.id, placeOfSupply: "09",
      lines: [{ itemId: svc!.id, description: "Service", hsn: "9987", qty: "1", rate: "1000.00", gstRate: 18 }],
    }, userId);
    const subs = await Promise.allSettled([invoiceLifecycle.submit(d.id, userId), invoiceLifecycle.submit(d.id, userId)]);
    const cans = await Promise.allSettled([invoiceLifecycle.cancel(d.id, userId), invoiceLifecycle.cancel(d.id, userId)]);
    if (subs.filter((r) => r.status === "fulfilled").length !== 1) doubleSubmits++;
    const [rev] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE reverses_id = (SELECT journal_entry_id FROM invoices WHERE id = $1)`, [d.id]);
    if (cans.filter((r) => r.status === "fulfilled").length !== 1 || rev!.n !== "1") doubleReversals++;
    for (const r of [...subs, ...cans]) {
      if (r.status === "rejected" && (r.reason as { code?: string }).code !== "INVALID_STATE") badLosers++;
    }
  }
  const [gl2] = await q<{ ok: boolean }>(`SELECT ok FROM fn_verify_gl() WHERE check_name='gl_sums_to_zero'`);
  console.log(`same-document races: double submits ${doubleSubmits}/10 | double reversals ${doubleReversals}/10 | ` +
    `losers not INVALID_STATE: ${badLosers} | GL balanced: ${gl2!.ok}`);
  const docPass = doubleSubmits === 0 && doubleReversals === 0 && badLosers === 0 && gl2!.ok;

  const pass = stockPass && docPass;
  console.log(pass ? "\nCONCURRENCY TEST: PASS — one sale won the stock; one submit and one cancel per document"
    : "\nCONCURRENCY TEST: FAIL");
  await pool.end();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
