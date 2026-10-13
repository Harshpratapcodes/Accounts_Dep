-- T0-08 prerequisite (C-08): the business date is the date in India.
--
-- Document dates default to CURRENT_DATE, and the FY a number comes from is
-- read off the document date. Render and Neon run in UTC, so between 00:00
-- and 05:30 IST CURRENT_DATE was yesterday: a document raised at 00:30 on
-- 1 April would be dated 31 March and numbered in the old financial year.
-- Setting the database's TimeZone makes CURRENT_DATE, the column defaults,
-- the ageing views and the period "is current" check all agree with the
-- calendar the GST rules use. withTransaction also sets it per transaction,
-- so a database restored without this setting still posts on IST dates.
--
-- ALTER DATABASE ... SET applies to new sessions; pooled connections pick it
-- up as they are recycled.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET TimeZone = %L', current_database(), 'Asia/Kolkata');
END $$;
