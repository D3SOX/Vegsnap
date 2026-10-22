ALTER TABLE content_reports RENAME TO content_reports_old;
CREATE TABLE content_reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'community', 'result')),
  content_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO content_reports (id, kind, content_id, text, reason, created_at)
  SELECT id, kind, content_id, text, reason, created_at FROM content_reports_old;
DROP TABLE content_reports_old;
CREATE INDEX reports_created ON content_reports(created_at, id);
