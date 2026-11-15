-- Lookups match through match_rules_json, so these column indexes only slowed writes.
DROP INDEX submissions_barcode;
DROP INDEX submissions_identity;
CREATE TABLE report_ip_budget (
  day TEXT NOT NULL,
  client TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, client)
) WITHOUT ROWID;
