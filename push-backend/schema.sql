-- Private Cloudflare D1 data; do not copy this database into public GitHub.
-- Push endpoints and cryptographic subscription keys are sensitive metadata.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_test_at TEXT,
  last_sent_day TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_ip_created ON push_subscriptions(ip_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_push_active_day ON push_subscriptions(active,last_sent_day);
