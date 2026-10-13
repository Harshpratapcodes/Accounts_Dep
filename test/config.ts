/**
 * Effective-dated configuration (C-14, T0-07).
 *
 * The seeded 02 §8 values are in force and valid; a value is read by date;
 * a change appends (never edits) and a re-entry for the same date corrects;
 * a setting nobody has decided fails loudly instead of defaulting; writes
 * are validated per key and allowed to admin only (owner reads).
 *
 * Writes in this suite take effect in 2099 so they never change the values
 * other suites see today.
 */
import "./support/local-db-only.js"; // first: refuses a non-local database
import type { AddressInfo } from "node:net";
import { app } from "../src/server.js";
import { createUser } from "../src/core/auth.js";
import { CONFIG_KEYS, getConfig, getConfigOptional, isConfigKey, listConfig, setConfig } from "../src/core/config.js";
import { pool, withTransaction } from "../src/shared/db.js";
import { AppError, fromPgError } from "../src/shared/errors.js";

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
async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "none"; }
  catch (e) { return e instanceof AppError ? e.code : fromPgError(e).code; }
}

/** 02 §8 keys deliberately left unset: the CA or the admin decides them. */
const UNSEEDED = ["gst.installation_treatment", "it.asset_capitalisation_threshold_paise", "digest.time_local"];

async function main() {
  const stamp = Date.now();
  const { id: adminId } = await createUser({
    email: `cfg_admin_${stamp}@test.com`, fullName: "Cfg Admin", password: "Pw!", roleName: "admin" });
  await createUser({ email: `cfg_owner_${stamp}@test.com`, fullName: "Cfg Owner", password: "Pw!", roleName: "owner" });

  console.log("== SEEDED VALUES (02 §8) ==");
  const seeded = await listConfig("2025-04-01");
  check("every registry key is listed", seeded.length === Object.keys(CONFIG_KEYS).length);
  const missing = seeded.filter((e) => e.value === null && !UNSEEDED.includes(e.key)).map((e) => e.key);
  check("every key except the undecided three is in force from 2025-04-01", missing.length === 0, missing.join(","));
  const decided = seeded.filter((e) => UNSEEDED.includes(e.key) && e.value !== null).map((e) => e.key);
  check("the undecided three are not seeded", decided.length === 0, decided.join(","));
  const { rows: dbKeys } = await pool.query<{ key: string }>(`SELECT DISTINCT key FROM config_values`);
  const orphans = dbKeys.map((r) => r.key).filter((k) => !isConfigKey(k));
  check("no stored key is missing from the registry", orphans.length === 0, orphans.join(","));
  check("e-way bill threshold is Rs 50,000 (C-30)", await getConfig("gst.eway.threshold_paise") === 5_000_000);
  check("cash receipt limit is Rs 2,00,000 (C-36)", await getConfig("it.cash_receipt_limit_paise") === 20_000_000);
  check("filing profile defaults to qrmp (C-24)", await getConfig("gst.filing_profile") === "qrmp");
  const deadline = await getConfig("gst.itc.annual_claim_deadline");
  check("ITC claim deadline is 30 November (C-21)", deadline.month === 11 && deadline.day === 30);

  console.log("== UNSET AND BEFORE-SEED READS FAIL LOUDLY ==");
  check("before 2025-04-01 a key has no value", await getConfigOptional("gst.eway.threshold_paise", "2025-03-31") === null);
  check("getConfig before any value -> CONFIG_UNSET",
    await errorCode(() => getConfig("gst.eway.threshold_paise", "2025-03-31")) === "CONFIG_UNSET");
  check("installation treatment (C-19) is undecided -> CONFIG_UNSET",
    await errorCode(() => getConfig("gst.installation_treatment", "2025-04-01")) === "CONFIG_UNSET");

  console.log("== EFFECTIVE DATING ==");
  await setConfig("gst.eway.threshold_paise", 10_000_000, "2099-01-01", "test: raised threshold", adminId);
  check("the old value holds the day before", await getConfig("gst.eway.threshold_paise", "2098-12-31") === 5_000_000);
  check("the new value holds from its date", await getConfig("gst.eway.threshold_paise", "2099-01-01") === 10_000_000);
  check("and after it", await getConfig("gst.eway.threshold_paise", "2100-06-30") === 10_000_000);

  console.log("== CORRECTION APPENDS; THE LATEST ENTRY FOR A DATE WINS ==");
  await setConfig("digest.max_items", 7, "2099-02-01", "test: typo", adminId);
  const fixed = await setConfig("digest.max_items", 5, "2099-02-01", "test: corrected", adminId);
  check("re-entering a date corrects it", await getConfig("digest.max_items", "2099-02-01") === 5);
  const { rows: [hist] } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM config_values WHERE key = 'digest.max_items' AND effective_from = '2099-02-01'`);
  check("both entries stay on record (C-03)", Number(hist!.n) >= 2, hist!.n);
  check("the actor is recorded", fixed.createdBy === adminId, String(fixed.createdBy));

  console.log("== INSERT-ONLY ==");
  const upd = await errorCode(() => withTransaction(adminId, (tx) =>
    tx.query(`UPDATE config_values SET value = '1' WHERE key = 'digest.max_items'`)));
  check("UPDATE config_values -> IMMUTABLE", upd === "IMMUTABLE", upd);
  const del = await errorCode(() => withTransaction(adminId, (tx) =>
    tx.query(`DELETE FROM config_values WHERE key = 'digest.max_items'`)));
  check("DELETE config_values -> IMMUTABLE", del === "IMMUTABLE", del);

  console.log("== WRITES ARE VALIDATED PER KEY ==");
  check("unknown key -> UNKNOWN_CONFIG_KEY",
    await errorCode(() => setConfig("gst.made_up", 1, "2099-01-01", undefined, adminId)) === "UNKNOWN_CONFIG_KEY");
  check("wrong type -> VALIDATION",
    await errorCode(() => setConfig("gst.eway.threshold_paise", "50000", "2099-01-01", undefined, adminId)) === "VALIDATION");
  check("fractional paise -> VALIDATION",
    await errorCode(() => setConfig("it.cash_payment_limit_paise", 100.5, "2099-01-01", undefined, adminId)) === "VALIDATION");
  check("value outside the enum -> VALIDATION",
    await errorCode(() => setConfig("gst.installation_treatment", "bundled", "2099-01-01", undefined, adminId)) === "VALIDATION");
  check("retention below the 72-month statutory minimum -> VALIDATION (C-06)",
    await errorCode(() => setConfig("records.retention_months", 60, "2099-01-01", undefined, adminId)) === "VALIDATION");
  check("digest time must be HH:MM",
    await errorCode(() => setConfig("digest.time_local", "9am", "2099-01-01", undefined, adminId)) === "VALIDATION");
  check("impossible date -> INVALID_DATE",
    await errorCode(() => setConfig("digest.max_items", 3, "2099-02-30", undefined, adminId)) === "INVALID_DATE");

  console.log("== HTTP: OWNER READS, ADMIN WRITES ==");
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const login = async (email: string) => sidFrom((await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Pw!" }),
  })).headers.get("set-cookie"))!;
  const post = (cookie: string, key: string, body: unknown) => fetch(`${base}/api/config/${key}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });

  try {
    const admin = await login(`cfg_admin_${stamp}@test.com`);
    const owner = await login(`cfg_owner_${stamp}@test.com`);

    const list = await fetch(`${base}/api/config?asOf=2099-01-01`, { headers: { cookie: owner } });
    check("owner GET /api/config -> 200", list.status === 200, String(list.status));
    const body = await list.json() as { asOf: string; entries: { key: string; value: unknown; basis: string }[] };
    check("list honours asOf", body.asOf === "2099-01-01"
      && body.entries.find((e) => e.key === "gst.eway.threshold_paise")?.value === 10_000_000);
    check("each entry names the requirement it implements",
      body.entries.every((e) => /^[CP]-\d+$/.test(e.basis)));
    const badAsOf = await fetch(`${base}/api/config?asOf=2026-13-01`, { headers: { cookie: owner } });
    check("GET with an impossible asOf -> 422", badAsOf.status === 422, String(badAsOf.status));

    const ownerWrite = await post(owner, "digest.max_items", { value: 2, effectiveFrom: "2099-03-01" });
    check("owner POST /api/config/:key -> 403 (admin-editable only)", ownerWrite.status === 403, String(ownerWrite.status));

    const adminWrite = await post(admin, "digest.time_local", { value: "08:30", effectiveFrom: "2099-03-01", note: "test" });
    check("admin POST -> 201", adminWrite.status === 201, String(adminWrite.status));
    check("the written value reads back", await getConfig("digest.time_local", "2099-03-01") === "08:30");

    const badValue = await post(admin, "digest.max_items", { value: 0, effectiveFrom: "2099-03-01" });
    check("admin POST with an out-of-range value -> 422", badValue.status === 422, String(badValue.status));
    const noValue = await post(admin, "digest.max_items", { effectiveFrom: "2099-03-01" });
    check("admin POST without a value -> 422", noValue.status === 422, String(noValue.status));
    const extra = await post(admin, "digest.max_items", { value: 3, effectiveFrom: "2099-03-01", effectiveTo: "2100-01-01" });
    check("admin POST with an unknown field -> 422", extra.status === 422, String(extra.status));
    const unknownKey = await post(admin, "gst.made_up", { value: 1, effectiveFrom: "2099-03-01" });
    check("admin POST to an unknown key -> 404", unknownKey.status === 404, String(unknownKey.status));

    const history = await fetch(`${base}/api/config/digest.max_items/history`, { headers: { cookie: owner } });
    const rows = await history.json() as { effectiveFrom: string; value: unknown }[];
    check("history lists every entry, newest effective date first",
      history.status === 200 && rows.length >= 3 && rows[0]!.effectiveFrom >= rows[rows.length - 1]!.effectiveFrom);

    const anon = await fetch(`${base}/api/config`);
    check("unauthenticated GET -> 401", anon.status === 401, String(anon.status));
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
