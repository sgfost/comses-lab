CREATE TABLE agent_logins (
 device_hash TEXT PRIMARY KEY,
 user_code TEXT NOT NULL UNIQUE,
 request TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','consumed')),
 expires_at INTEGER NOT NULL,
 next_poll_at INTEGER NOT NULL,
 poll_interval INTEGER NOT NULL DEFAULT 5,
 approved_by TEXT REFERENCES users(id),
 approved_request TEXT,
 grant_id TEXT REFERENCES agent_grants(id)
);
