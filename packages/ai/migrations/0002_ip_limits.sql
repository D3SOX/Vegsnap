-- Keyed IP hashes: kept on sessions only while unverified, and as per-day verification counters.
ALTER TABLE sessions ADD COLUMN ip_hash TEXT;
CREATE INDEX sessions_pending_ip ON sessions(ip_hash, expires_at) WHERE verified = 0;
CREATE TABLE ip_usage (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  connections INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
