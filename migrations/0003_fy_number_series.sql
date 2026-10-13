-- T0-08 (C-08): one gap-free number series per document type per financial
-- year, chosen by the document's own date.
--
-- Format stays CODE-YYYY-NNNNN, where YYYY is now the year the financial
-- year starts: INV-2026-00001 is FY 2026-27, INV-2027-00001 is FY 2027-28.
-- The imported calendar-year series (QTN-2026, INV-2026, ...) become the
-- FY 2026-27 series unchanged, so numbering already issued carries on.
-- A series row for a new FY is created on first use, inside the posting
-- transaction, so there is nothing to run at year end.

-- The document types the numbering engine knows. New types (PB, EXP, DC,
-- DBN, RCP, PMT, ST) are added here by the phase that introduces them.
CREATE TABLE number_series (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z]{2,4}$'),
  description text NOT NULL,
  padding     smallint NOT NULL DEFAULT 5 CHECK (padding BETWEEN 3 AND 8),
  business_id integer NOT NULL DEFAULT 1 REFERENCES business(id),
  -- CODE-YYYY-NNNNN must fit Rule 46's 16-character limit (C-07):
  -- code + '-' + 4 + '-' + padding <= 16.
  CONSTRAINT number_series_fits_rule_46 CHECK (length(code) + padding <= 10)
);

INSERT INTO number_series (code, description) VALUES
  ('QTN', 'Quotation'),
  ('SO',  'Sales order'),
  ('INV', 'Tax invoice'),
  ('CRN', 'Credit note'),
  ('PAY', 'Payment received'),
  ('JV',  'Journal voucher'),
  ('PRC', 'Purchase receipt'),
  ('ADJ', 'Stock adjustment');

ALTER TABLE document_sequences
  ADD COLUMN series_code   text REFERENCES number_series(code),
  ADD COLUMN fy_start_year smallint;

UPDATE document_sequences
   SET series_code   = split_part(series, '-', 1),
       fy_start_year = split_part(series, '-', 2)::smallint;

ALTER TABLE document_sequences
  ALTER COLUMN series_code   SET NOT NULL,
  ALTER COLUMN fy_start_year SET NOT NULL,
  ADD CONSTRAINT document_sequences_one_per_fy UNIQUE (series_code, fy_start_year),
  ADD CONSTRAINT document_sequences_named_by_fy
    CHECK (series = series_code || '-' || fy_start_year AND prefix = series || '-');

-- Indian financial year: 1 April to 31 March, by statute (not configuration).
CREATE FUNCTION fn_fy_start_year(p_date date) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (extract(year FROM p_date)
          - CASE WHEN extract(month FROM p_date) < 4 THEN 1 ELSE 0 END)::smallint
$$;

-- next_doc_number(code, document date): the FY-aware entry point. It creates
-- the FY's series row on first use, then defers to the gapless
-- next_doc_number(series) counter. Two first-of-year submitters are safe: the
-- second INSERT waits on the first's uncommitted row, then does nothing, and
-- both then serialise on the counter row's lock.
CREATE FUNCTION next_doc_number(p_code text, p_doc_date date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_padding smallint;
  v_fy      smallint;
  v_series  text;
BEGIN
  IF p_doc_date IS NULL THEN
    RAISE EXCEPTION 'A document date is required to choose the number series for %', p_code
      USING ERRCODE = 'P0002';
  END IF;

  SELECT padding INTO v_padding FROM number_series WHERE code = p_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown document series: %', p_code
      USING ERRCODE = 'P0002';
  END IF;

  v_fy     := fn_fy_start_year(p_doc_date);
  v_series := p_code || '-' || v_fy;

  INSERT INTO document_sequences (series, prefix, padding, series_code, fy_start_year)
  VALUES (v_series, v_series || '-', v_padding, p_code, v_fy)
  ON CONFLICT (series) DO NOTHING;

  RETURN next_doc_number(v_series);
END $$;
