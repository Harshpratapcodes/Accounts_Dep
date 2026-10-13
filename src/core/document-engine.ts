import type { Tx } from "../shared/db.js";
import { withTransaction } from "../shared/db.js";
import { AppError, fromPgError } from "../shared/errors.js";
import { nextDocNumber, type SeriesCode } from "./numbering.js";

/**
 * Generic document lifecycle: DRAFT -> SUBMITTED -> CANCELLED.
 *
 * Each document type plugs in hooks; the engine owns the transaction,
 * actor context, numbering, status transition and timestamps. The database
 * triggers (immutability, balance, stock guards) are the second line of
 * defense — this engine is the first.
 *
 * Every table the engine drives has doc_date, status, doc_no and the
 * submitted_/cancelled_ stamp columns. The number comes from the series of
 * the financial year containing doc_date (C-08).
 */
export interface DocumentType<TDoc> {
  table: string;          // e.g. 'invoices'
  series: (doc: TDoc) => SeriesCode; // e.g. () => 'INV'
  load: (tx: Tx, id: string) => Promise<TDoc & { id: string; status: string }>;
  /** Business effects of submission (post journals, move stock). Runs inside
   *  the same transaction, AFTER the doc number is issued. Must return the
   *  extra columns to set on the document row (e.g. journal_entry_id). */
  onSubmit: (tx: Tx, doc: TDoc & { id: string }, docNo: string, userId: string)
    => Promise<Record<string, unknown>>;
  /** Reversal effects of cancellation (reversing journals, opposite stock). */
  onCancel: (tx: Tx, doc: TDoc & { id: string }, userId: string) => Promise<void>;
}

export function makeLifecycle<TDoc>(def: DocumentType<TDoc>) {
  /** Lock the document row before reading it. Without this, two cancels of
   *  one invoice both saw 'submitted' and both posted a reversal, and a draft
   *  edit committing mid-submit left the journal built from stale totals.
   *  Draft edits lock the same row, so they now finish first or wait. Each
   *  lifecycle locks only its own row, then stock rows in order: no cycles. */
  async function lockRow(tx: Tx, docId: string): Promise<{ doc_date: string } | undefined> {
    const { rows: [row] } = await tx.query<{ doc_date: string }>(
      `SELECT doc_date::text FROM ${def.table} WHERE id = $1 FOR UPDATE`, [docId]);
    return row;
  }

  return {
    async submit(docId: string, userId: string) {
      try {
        return await withTransaction(userId, async (tx) => {
          const locked = await lockRow(tx, docId);
          const doc = await def.load(tx, docId);   // NOT_FOUND when !locked
          if (doc.status !== "draft") {
            throw new AppError("INVALID_STATE", `${def.table} ${docId} is ${doc.status}, expected draft`, 409);
          }
          const docNo = await nextDocNumber(tx, def.series(doc), locked!.doc_date);
          const extra = await def.onSubmit(tx, doc, docNo, userId);

          const extraKeys = Object.keys(extra);
          const setClauses = extraKeys.map((k, i) => `${k} = $${i + 4}`);
          await tx.query(
            `UPDATE ${def.table}
                SET status = 'submitted', doc_no = $2,
                    submitted_by = $3, submitted_at = now()
                    ${setClauses.length ? ", " + setClauses.join(", ") : ""}
              WHERE id = $1`,
            [docId, docNo, userId, ...extraKeys.map((k) => extra[k])],
          );
          return { id: docId, docNo };
        });
      } catch (err) {
        throw fromPgError(err);
      }
    },

    async cancel(docId: string, userId: string) {
      try {
        return await withTransaction(userId, async (tx) => {
          await lockRow(tx, docId);
          const doc = await def.load(tx, docId);
          if (doc.status !== "submitted") {
            throw new AppError("INVALID_STATE", `${def.table} ${docId} is ${doc.status}, expected submitted`, 409);
          }
          await def.onCancel(tx, doc, userId);
          await tx.query(
            `UPDATE ${def.table}
                SET status = 'cancelled', cancelled_by = $2, cancelled_at = now()
              WHERE id = $1`,
            [docId, userId],
          );
          return { id: docId };
        });
      } catch (err) {
        throw fromPgError(err);
      }
    },
  };
}
