/**
 * Test suites post invoices, journals and users, and the ledger's triggers
 * make posted records permanent. They must never reach the real books. Every
 * suite (and the E2E seed) imports this first: it resolves the database the
 * suite would use, exactly as src/shared/db.ts will (DATABASE_URL, from the
 * environment or .env, wins over PG* vars), and refuses anything not local.
 *
 * A deliberate test database elsewhere (a Neon branch, say) is allowed by
 * naming its host: BIZSUITE_TEST_REMOTE_DB=<that exact hostname>.
 */
import { loadDotEnv } from "../../src/shared/env.js";

loadDotEnv();

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const url = process.env.DATABASE_URL;
const host = url ? new URL(url).hostname : (process.env.PGHOST || "localhost");
const local = LOCAL.has(host) || host.startsWith("/"); // a path is a local socket

if (!local && process.env.BIZSUITE_TEST_REMOTE_DB !== host) {
  console.error(
    `Refusing to run tests against ${host}${url ? " (DATABASE_URL)" : " (PGHOST)"}: ` +
    `tests write permanent ledger records.\n` +
    `Point them at a local database, e.g. DATABASE_URL=postgresql://postgres@localhost:5432/bizsuite_test,\n` +
    `or, for a database that exists only for tests, set BIZSUITE_TEST_REMOTE_DB=${host}.`);
  process.exit(2);
}
