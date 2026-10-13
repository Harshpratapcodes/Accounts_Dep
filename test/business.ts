/**
 * Business anchor and the owner role (C-39, D-140, D-171; T0-06).
 *
 * Every business table carries business_id (default 1, FK to business), and
 * this suite fails when a new table is added without it, so every v2 table
 * starts with the column. The owner role has the full books (read, draft,
 * submit, cancel on every business module) but only reads `core`.
 */
import "./support/local-db-only.js"; // first: refuses a non-local database
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { hasPermission, type Module } from "../src/core/rbac.js";
import { pool } from "../src/shared/db.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
function sidFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie);
  return m ? `sid=${m[1]}` : null;
}
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query<T>(sql, params)).rows;

/** Platform tables: identity, access and the migration ledger. Everything else is business data. */
const PLATFORM = new Set(["roles", "role_permissions", "users", "sessions", "schema_migrations", "business"]);
const BUSINESS_MODULES: Module[] = ["crm", "sales", "invoicing", "accounting", "inventory"];

async function main() {
  const stamp = Date.now();

  console.log("== BUSINESS ANCHOR ==");
  const [biz] = await q<{ id: number }>(`SELECT id FROM business WHERE id = 1`);
  check("business 1 exists", biz?.id === 1);

  console.log("== EVERY BUSINESS TABLE CARRIES business_id (C-39) ==");
  const tables = (await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.table_name);
  const cols = await q<{ table_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
    `SELECT table_name, is_nullable, column_default, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'business_id'`);
  const byTable = new Map(cols.map((c) => [c.table_name, c]));
  const fks = new Set((await q<{ table_name: string }>(
    `SELECT tc.table_name FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'business' AND ccu.column_name = 'id'`))
    .map((r) => r.table_name));

  const businessTables = tables.filter((t) => !PLATFORM.has(t));
  check("there are business tables to check", businessTables.length >= 30, String(businessTables.length));
  const without = businessTables.filter((t) => !byTable.has(t));
  check("no business table is missing business_id", without.length === 0, without.join(", "));
  const loose = businessTables.filter((t) => {
    const c = byTable.get(t);
    return c && (c.is_nullable !== "NO" || c.column_default !== "1" || c.data_type !== "integer");
  });
  check("business_id is integer NOT NULL DEFAULT 1 everywhere", loose.length === 0, loose.join(", "));
  const unlinked = businessTables.filter((t) => byTable.has(t) && !fks.has(t));
  check("business_id references business(id) everywhere", unlinked.length === 0, unlinked.join(", "));
  const platformWith = [...PLATFORM].filter((t) => byTable.has(t));
  check("platform tables do not carry it", platformWith.length === 0, platformWith.join(", "));

  const strays = await q<{ n: string }>(
    `SELECT (SELECT count(*) FROM invoices WHERE business_id <> 1)
          + (SELECT count(*) FROM journal_entries WHERE business_id <> 1)
          + (SELECT count(*) FROM companies WHERE business_id <> 1) AS n`);
  check("existing rows belong to business 1", strays[0]!.n === "0", strays[0]!.n);

  console.log("== OWNER ROLE (D-140) ==");
  const [owner] = await q<{ id: string }>(`SELECT id FROM roles WHERE name = 'owner'`);
  check("owner role exists", !!owner);
  for (const m of BUSINESS_MODULES) {
    const all = await hasPermission(owner!.id, m, "read") && await hasPermission(owner!.id, m, "write")
      && await hasPermission(owner!.id, m, "submit") && await hasPermission(owner!.id, m, "cancel");
    check(`owner has read/write/submit/cancel on ${m}`, all);
  }
  check("owner reads core", await hasPermission(owner!.id, "core", "read"));
  check("owner cannot write core (platform settings stay with admin)",
    !(await hasPermission(owner!.id, "core", "write")));
  const [admin] = await q<{ id: string }>(`SELECT id FROM roles WHERE name = 'admin'`);
  check("admin still writes core", await hasPermission(admin!.id, "core", "write"));

  console.log("== OWNER OVER HTTP: QUOTE, SUBMIT, CANCEL ==");
  await q(`INSERT INTO company_settings (id, legal_name, gstin, state_code)
           VALUES (1,'Harsh Trading Co','09ABCDE1234F1Z5','09')
           ON CONFLICT (id) DO UPDATE SET state_code='09', gstin=EXCLUDED.gstin`);
  const [customer] = await q<{ id: string }>(
    `INSERT INTO companies (name, gst_treatment, state_code, is_customer)
     VALUES ('Owner Customer ' || substr(gen_random_uuid()::text,1,8), 'unregistered', '09', true) RETURNING id`);
  const [item] = await q<{ id: string }>(
    `INSERT INTO items (sku, name, hsn_sac_code, gst_rate)
     VALUES ('OW-' || substr(gen_random_uuid()::text,1,8), 'Stabiliser', '8504', 18) RETURNING id`);
  await createUser({ email: `own_${stamp}@test.com`, fullName: "Owner", password: "Pw!", roleName: "owner" });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `own_${stamp}@test.com`, password: "Pw!" }),
    });
    const cookie = sidFrom(login.headers.get("set-cookie"))!;
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json() as { user: { roleName: string } };
    check("owner logs in as role 'owner'", me.user.roleName === "owner", me.user.roleName);

    const j = (body?: unknown) => ({
      headers: { cookie, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const created = await fetch(`${base}/api/sales/quotations`, { method: "POST", ...j({
      customerId: customer!.id, placeOfSupply: "09",
      lines: [{ itemId: item!.id, description: "Stabiliser", hsn: "8504", qty: "1", rate: "1000.00", gstRate: 18 }],
    }) });
    check("owner creates a draft quotation -> 201", created.status === 201, String(created.status));
    const { id } = await created.json() as { id: string };
    const submitted = await fetch(`${base}/api/sales/quotations/${id}/submit`, { method: "POST", ...j() });
    check("owner submits it -> 200", submitted.status === 200, String(submitted.status));
    const cancelled = await fetch(`${base}/api/sales/quotations/${id}/cancel`, { method: "POST", ...j() });
    check("owner cancels it (the undo path, P-14) -> 200", cancelled.status === 200, String(cancelled.status));
    const [row] = await q<{ business_id: number; status: string }>(
      `SELECT business_id, status FROM quotations WHERE id = $1`, [id]);
    check("the new document belongs to business 1", row?.business_id === 1 && row.status === "cancelled");
  } finally {
    server.close();
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
