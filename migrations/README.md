# Migrations

v2 schema changes, applied on top of `schema.sql` (D-170). The design and
invariants behind each one are in `v2_docs/04-schema-deltas.md`.

## Rules

- One file per change: `NNNN_short_name.sql`, four digits, lowercase. Files
  apply in name order.
- Additive only: new tables, new nullable columns or columns with a constant
  default, new constraints on new columns. Nothing in the imported schema is
  dropped.
- No `BEGIN`/`COMMIT` in the file. The runner wraps each file in one
  transaction together with its `schema_migrations` row.
- Never edit a file once it has been applied anywhere. The runner stores a
  checksum and refuses to start if an applied file changed. A fix is a new file.
- Every new business table carries
  `business_id integer NOT NULL DEFAULT 1 REFERENCES business(id)`.
  `npm run test:business` fails otherwise.

## Running

- Server boot applies pending migrations before it listens. A failed migration
  rolls back and stops the boot, so the platform keeps the previous instance.
- `npm run migrate` applies them by hand (CI runs it after loading `schema.sql`).
- Fresh database: `psql -v ON_ERROR_STOP=1 -f schema.sql`, then `npm run migrate`.

## Folding at the end of a phase

Each phase ends with its migrations folded into `schema.sql` (08 §5):

1. Append the phase's files to `schema.sql`, in order, inside its transaction.
2. Add to `schema.sql` the `schema_migrations` table and an `INSERT` of the
   folded file names with their checksums, so a database built from the new
   `schema.sql` treats them as applied.
3. Delete the folded files.
4. Check: a fresh database from the new `schema.sql`, plus `npm run migrate`,
   passes every suite; and a database built the old way (old `schema.sql` plus
   the files) has the same structure (`pg_dump --schema-only` diff).
