CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  installation_hash TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE daily_budget (
  day TEXT PRIMARY KEY,
  checks INTEGER NOT NULL DEFAULT 0,
  connections INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE installation_usage (
  installation_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_hash, day)
);
