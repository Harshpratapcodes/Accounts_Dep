/**
 * Create a user from the CLI (no admin UI; D-171).
 *
 *   npx tsx scripts/create-user.ts <email> <full name> <password> <role>
 *
 * v2 uses two roles: owner (the full books; reads platform settings) and
 * admin (also edits platform settings and config). The v1 roles accounts,
 * sales, inventory and readonly stay seeded but unused (D-140).
 */
import { createUser } from "../src/core/auth.js";
import { pool } from "../src/shared/db.js";

const [email, fullName, password, roleName] = process.argv.slice(2);

if (!email || !fullName || !password || !roleName) {
  console.error('Usage: npx tsx scripts/create-user.ts <email> "<full name>" <password> <role>');
  console.error("Roles: owner | admin (v1, unused in v2: accounts | sales | inventory | readonly)");
  process.exit(1);
}

const { id } = await createUser({ email, fullName, password, roleName });
console.log(`Created ${roleName} user ${email} (${id})`);
await pool.end();
