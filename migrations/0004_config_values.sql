-- T0-07 (C-14): effective-dated configuration, admin-editable, seeded from
-- 02 §8.
--
-- Insert-only. Changing a value appends a row with the date it takes effect;
-- the value in force on a date is the row with the latest effective_from on
-- or before it, and among rows for the same date the one entered last (so a
-- mistaken entry is corrected by entering it again, and both stay on record,
-- C-03). Keys and value shapes are defined in src/core/config.ts, which
-- validates every write and every read.

CREATE TABLE config_values (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id    integer NOT NULL DEFAULT 1 REFERENCES business(id),
  key            text NOT NULL CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  value          jsonb NOT NULL,
  effective_from date NOT NULL,
  note           text,
  created_by     uuid DEFAULT fn_current_actor() REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_config_values_lookup
  ON config_values (business_id, key, effective_from DESC, id DESC);

CREATE TRIGGER trg_config_values_immutable
  BEFORE UPDATE OR DELETE ON config_values
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();

-- Seeds take effect from 1 April 2025, the start of the earliest financial
-- year v2 handles (supplier bills of FY 2025-26 can still be entered for ITC
-- until 30 November 2026, C-21). Every value below was already in force then.
-- Not seeded, because only the CA or the admin can decide them:
-- gst.installation_treatment (C-19), it.asset_capitalisation_threshold_paise
-- (C-37), digest.time_local (P-06). Reading one before it is set fails with
-- CONFIG_UNSET. gst.state_code is not here: it is part of the business's
-- identity and stays in company_settings.state_code.
INSERT INTO config_values (key, value, effective_from, note) VALUES
  ('gst.filing_profile',                  '"qrmp"',                   '2025-04-01', 'C-24. Assumed QRMP; confirm on the portal'),
  ('gst.hsn_digits_b2b',                  '4',                        '2025-04-01', 'C-15. Aggregate turnover up to Rs 5 crore'),
  ('gst.b2c_address_threshold_paise',     '5000000',                  '2025-04-01', 'C-07. Rs 50,000'),
  ('gst.eway.threshold_paise',            '5000000',                  '2025-04-01', 'C-30. Rs 50,000'),
  ('gst.eway.document_age_days',          '180',                      '2025-04-01', 'C-30. In force since 1 Jan 2025'),
  ('gst.einvoice.aato_threshold_paise',   '50000000000',              '2025-04-01', 'C-31. Rs 5 crore; not applicable to KAE today'),
  ('gst.itc.unpaid_reversal_days',        '180',                      '2025-04-01', 'C-21'),
  ('gst.itc.annual_claim_deadline',       '{"month": 11, "day": 30}', '2025-04-01', 'C-21. 30 November after the FY ends, or the annual return date if earlier. VERIFY'),
  ('gst.ims.draft_2b_day',                '14',                       '2025-04-01', 'C-27'),
  ('gst.rounding',                        '"round_total_to_rupee"',   '2025-04-01', 'C-18. Confirm the CA''s preferred presentation'),
  ('it.cash_payment_limit_paise',         '1000000',                  '2025-04-01', 'C-36. Rs 10,000 to one person in a day'),
  ('it.cash_receipt_limit_paise',         '20000000',                 '2025-04-01', 'C-36. Rs 2,00,000 from one person'),
  ('records.retention_months',            '72',                       '2025-04-01', 'C-06. Statutory minimum'),
  ('digest.max_items',                    '3',                        '2025-04-01', 'P-06');
