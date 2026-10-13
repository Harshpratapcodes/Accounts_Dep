import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

/**
 * Additive migrations on top of schema.sql (D-170).
 *
 * `migrations/NNNN_name.sql` files apply in name order, each in its own
 * transaction together with its row in `schema_migrations`. A file that was
 * applied and has since changed stops the run: an applied migration is
 * history, so a fix is a new file. At the end of a phase the files are folded
 * into schema.sql (see migrations/README.md).
 *
 * Runs at server boot and as `npm run migrate`. Safe to start twice at once:
 * each migration takes a transaction-scoped advisory lock and re-checks
 * whether it was applied, so a second runner waits and then skips it.
 */

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../migrations");
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 7_270_001; // arbitrary, constant: "bizsuite migrations"

export interface MigrationResult { applied: string[]; skipped: string[] }

/** Line endings are normalised so a Windows checkout hashes like CI's. */
function checksum(sql: string): string {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export async function runMigrations(dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       text PRIMARY KEY,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`);

  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => FILE_PATTERN.test(f)).sort() : [];
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const name of files) {
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    const sum = checksum(sql);
    const client = await pool.connect();
    let outcome: "applied" | "skipped" | "edited";
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
      const { rows: [done] } = await client.query<{ checksum: string }>(
        `SELECT checksum FROM schema_migrations WHERE name = $1`, [name]);
      if (done) {
        await client.query("ROLLBACK");
        outcome = done.checksum === sum ? "skipped" : "edited";
      } else {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, [name, sum]);
        await client.query("COMMIT");
        outcome = "applied";
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
    if (outcome === "edited") {
      throw new Error(`Migration ${name} was applied and has since been edited. ` +
        `Applied migrations are history: put the change in a new file.`);
    }
    result[outcome].push(name);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(({ applied, skipped }) => {
      for (const n of applied) console.log(`  applied ${n}`);
      console.log(`migrations: ${applied.length} applied, ${skipped.length} already in place`);
      return pool.end();
    })
    .catch(async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    });
}
