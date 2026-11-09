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
  schedule_json TEXT NOT NULL DEFAULT '["12:00"]'
);
CREATE INDEX IF NOT EXISTS idx_push_ip_created ON push_subscriptions(ip_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_push_active ON push_subscriptions(active);
-- Reservation log prevents repeated sends for the same local day and time slot.
-- Contents are private D1 data; never export the rows to the public GitHub repository.
CREATE TABLE IF NOT EXISTS push_delivery_log (
  subscription_id TEXT NOT NULL,
  date_jst TEXT NOT NULL,
  time_jst TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now')),
  PRIMARY KEY(subscription_id,date_jst,time_jst),
  FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_push_delivery_day ON push_delivery_log(date_jst);
