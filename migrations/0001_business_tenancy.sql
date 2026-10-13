-- T0-06 (C-39, D-140, D-171): the business anchor, business_id on every
-- business table, and the `owner` role.
--
-- Single tenant today: every row belongs to business 1 through the column
-- default, and no query filters on it yet. The column lands now, before any
-- v2 table exists, so every v2 table is created with it (C-39). The
-- business's profile (legal name, GSTIN, state, address) stays in
-- company_settings; this table is only the key the rows hang off.

CREATE TABLE business (
  id         integer PRIMARY KEY CHECK (id > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO business (id) VALUES (1);

-- Platform tables (roles, role_permissions, users, sessions, and the
-- migration ledger) are not business data and do not get the column.
-- test/business.ts fails if any other table is missing it.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_settings', 'document_sequences', 'audit_log',
    'companies', 'contacts', 'pipeline_stages', 'deals', 'activities',
    'items', 'warehouses', 'item_warehouse', 'stock_ledger_entries',
    'purchase_receipts', 'purchase_receipt_lines',
    'stock_adjustments', 'stock_adjustment_lines',
    'accounts', 'journal_entries', 'journal_lines', 'financial_periods',
    'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines',
    'invoices', 'invoice_lines', 'payment_entries', 'payment_allocations'
  ] LOOP
    -- A constant default adds the column without rewriting rows or firing
    -- row triggers, so the immutability guards on posted documents are not
    -- tripped (OLD and NEW both carry business_id = 1 from here on).
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN business_id integer NOT NULL DEFAULT 1 REFERENCES business(id)', t);
  END LOOP;
END $$;

-- Owner: full access to the books (read, draft, submit, and cancel, which the
-- 24-hour undo needs, P-14). `core` is read-only: platform settings and
-- config_values (C-14) stay admin-editable.
INSERT INTO roles (name, description) VALUES
  ('owner', 'Business owner: full access to the books; platform settings stay with admin');

INSERT INTO role_permissions (role_id, module, can_read, can_write, can_submit, can_cancel)
SELECT r.id, m.module, true, m.module <> 'core', m.module <> 'core', m.module <> 'core'
  FROM roles r
 CROSS JOIN (VALUES ('core'),('crm'),('sales'),('invoicing'),('accounting'),('inventory')) AS m(module)
 WHERE r.name = 'owner';
