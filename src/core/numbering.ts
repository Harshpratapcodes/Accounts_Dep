import type { Tx } from "../shared/db.js";

/** Document types the numbering engine knows (rows of `number_series`). */
export type SeriesCode = "QTN" | "SO" | "INV" | "CRN" | "PAY" | "JV" | "PRC" | "ADJ";

/** Gapless, race-free document number from the series for `code` in the
 *  financial year containing `docDate` (C-08): INV dated 2027-04-01 gets
 *  INV-2027-NNNNN. Must be called inside the submitting transaction — the
 *  row lock serializes concurrent submitters, and a rollback returns the number. */
export async function nextDocNumber(tx: Tx, code: SeriesCode, docDate: string): Promise<string> {
  const { rows } = await tx.query<{ next_doc_number: string }>(
    "SELECT next_doc_number($1::text, $2::date)",
    [code, docDate],
  );
  return rows[0]!.next_doc_number;
}
