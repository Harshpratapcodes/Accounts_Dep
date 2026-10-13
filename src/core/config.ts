import { z } from "zod";
import { pool, withTransaction } from "../shared/db.js";
import { AppError, fromPgError } from "../shared/errors.js";
import { businessToday, isRealDate } from "../shared/clock.js";

/**
 * Effective-dated configuration (C-14): every threshold and switch the
 * compliance rules depend on, read by the date of the document it applies
 * to. The registry below is the whole set of keys; a value is validated
 * against its key's schema when written and again when read.
 *
 * Storage is insert-only (config_values, migration 0004). The value in force
 * on a date is the row with the latest effective_from on or before it; among
 * rows for one date, the one entered last.
 */

const paise = z.number().int().nonnegative();
const days = z.number().int().positive();

export const CONFIG_KEYS = {
  "gst.filing_profile": { basis: "C-24", schema: z.enum(["monthly", "qrmp"]) },
  "gst.hsn_digits_b2b": { basis: "C-15", schema: z.union([z.literal(4), z.literal(6), z.literal(8)]) },
  "gst.b2c_address_threshold_paise": { basis: "C-07", schema: paise },
  "gst.eway.threshold_paise": { basis: "C-30", schema: paise },
  "gst.eway.document_age_days": { basis: "C-30", schema: days },
  "gst.einvoice.aato_threshold_paise": { basis: "C-31", schema: paise },
  "gst.itc.unpaid_reversal_days": { basis: "C-21", schema: days },
  // Day and month in the year after the financial year ends.
  "gst.itc.annual_claim_deadline": {
    basis: "C-21",
    schema: z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict(),
  },
  "gst.ims.draft_2b_day": { basis: "C-27", schema: z.number().int().min(1).max(28) },
  "gst.installation_treatment": { basis: "C-19", schema: z.enum(["composite", "separate"]) },
  "gst.rounding": { basis: "C-18", schema: z.enum(["round_total_to_rupee", "exact"]) },
  "it.cash_payment_limit_paise": { basis: "C-36", schema: paise },
  "it.cash_receipt_limit_paise": { basis: "C-36", schema: paise },
  "it.asset_capitalisation_threshold_paise": { basis: "C-37", schema: paise },
  // C-06 is a statutory minimum: a shorter retention is not a valid setting.
  "records.retention_months": { basis: "C-06", schema: z.number().int().min(72) },
  "digest.time_local": { basis: "P-06", schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM") },
  "digest.max_items": { basis: "P-06", schema: z.number().int().min(1).max(10) },
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;
export type ConfigValue<K extends ConfigKey> = z.infer<(typeof CONFIG_KEYS)[K]["schema"]>;

export function isConfigKey(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key);
}

interface Row { id: string; key: string; value: unknown; effective_from: string; note: string | null;
  created_by: string | null; created_at: Date }

function parseStored<K extends ConfigKey>(key: K, raw: unknown): ConfigValue<K> {
  const parsed = CONFIG_KEYS[key].schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("CONFIG_INVALID", `Stored value for ${key} does not match its schema`, 500, parsed.error.flatten());
  }
  return parsed.data as ConfigValue<K>;
}

const IN_FORCE = `
  SELECT DISTINCT ON (key) id::text, key, value, effective_from::text, note, created_by, created_at
    FROM config_values
   WHERE effective_from <= $1::date AND key = ANY($2)
   ORDER BY key, effective_from DESC, id DESC`;

/** The value of `key` in force on `asOf` (default: today in India), or null if never set by then. */
export async function getConfigOptional<K extends ConfigKey>(key: K, asOf = businessToday()): Promise<ConfigValue<K> | null> {
  const { rows: [row] } = await pool.query<Row>(IN_FORCE, [asOf, [key]]);
  return row ? parseStored(key, row.value) : null;
}

/** The value of `key` in force on `asOf`. Throws CONFIG_UNSET if it has none:
 *  a rule that depends on an undecided setting must stop, not guess. */
export async function getConfig<K extends ConfigKey>(key: K, asOf = businessToday()): Promise<ConfigValue<K>> {
  const value = await getConfigOptional(key, asOf);
  if (value === null) {
    throw new AppError("CONFIG_UNSET", `${key} has no value in force on ${asOf}; an admin must set it`, 409);
  }
  return value;
}

export interface ConfigEntry {
  key: ConfigKey; basis: string;
  value: unknown | null; effectiveFrom: string | null; note: string | null;
}

/** Every registry key with the value in force on `asOf` (null where unset). */
export async function listConfig(asOf = businessToday()): Promise<ConfigEntry[]> {
  const keys = Object.keys(CONFIG_KEYS) as ConfigKey[];
  const { rows } = await pool.query<Row>(IN_FORCE, [asOf, keys]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return keys.map((key) => {
    const row = byKey.get(key);
    return {
      key, basis: CONFIG_KEYS[key].basis,
      value: row ? parseStored(key, row.value) : null,
      effectiveFrom: row?.effective_from ?? null,
      note: row?.note ?? null,
    };
  });
}

export interface ConfigHistoryRow {
  id: string; value: unknown; effectiveFrom: string; note: string | null;
  createdBy: string | null; createdAt: string;
}

/** Every value ever entered for `key`, newest effective date first. */
export async function configHistory(key: ConfigKey): Promise<ConfigHistoryRow[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id::text, key, value, effective_from::text, note, created_by, created_at
       FROM config_values WHERE key = $1
      ORDER BY effective_from DESC, id DESC`, [key]);
  return rows.map((r) => ({
    id: r.id, value: r.value, effectiveFrom: r.effective_from, note: r.note,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  }));
}

/** Record a value for `key` taking effect on `effectiveFrom`. Appends; never edits. */
export async function setConfig(
  key: string, value: unknown, effectiveFrom: string, note: string | undefined, userId: string,
): Promise<ConfigHistoryRow> {
  if (!isConfigKey(key)) throw new AppError("UNKNOWN_CONFIG_KEY", `No configuration key '${key}'`, 404);
  if (!isRealDate(effectiveFrom)) throw new AppError("INVALID_DATE", `${effectiveFrom} is not a date`, 422);
  const parsed = CONFIG_KEYS[key].schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("VALIDATION", `Invalid value for ${key}`, 422, parsed.error.flatten());
  }
  try {
    return await withTransaction(userId, async (tx) => {
      const { rows: [r] } = await tx.query<Row>(
        `INSERT INTO config_values (key, value, effective_from, note)
         VALUES ($1, $2::jsonb, $3::date, $4)
         RETURNING id::text, key, value, effective_from::text, note, created_by, created_at`,
        [key, JSON.stringify(parsed.data), effectiveFrom, note ?? null]);
      return {
        id: r!.id, value: r!.value, effectiveFrom: r!.effective_from, note: r!.note,
        createdBy: r!.created_by, createdAt: r!.created_at.toISOString(),
      };
    });
  } catch (err) {
    throw fromPgError(err);
  }
}
