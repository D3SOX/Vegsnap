CREATE TABLE content_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'community')),
  content_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX reports_created ON content_reports(created_at, id);
CREATE TABLE report_budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
