CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  brand TEXT NOT NULL,
  brand_key TEXT NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  market TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  reply TEXT NOT NULL,
  replied_on TEXT NOT NULL,
  claim TEXT NOT NULL CHECK (claim IN ('vegan', 'not_vegan', 'inconclusive')),
  scope TEXT NOT NULL CHECK (scope IN ('whole_product', 'ingredients', 'processing')),
  source_url TEXT NOT NULL DEFAULT '',
  evidence_key TEXT NOT NULL DEFAULT '',
  evidence_type TEXT NOT NULL DEFAULT '',
  evidence_public INTEGER NOT NULL DEFAULT 0 CHECK (evidence_public IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  original_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX submissions_barcode ON submissions(status, barcode, market, replied_on DESC, id);
CREATE INDEX submissions_identity ON submissions(status, name_key, brand_key, market, replied_on DESC, id);
CREATE INDEX submissions_queue ON submissions(status, created_at, id);
CREATE INDEX submissions_export ON submissions(status, id);

CREATE TABLE submission_budget (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count BETWEEN 0 AND 100)
);
