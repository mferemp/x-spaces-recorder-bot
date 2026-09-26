// Local SQLite schema. Applied on startup by backend/lib/db.js.
// Column names match the queries the routes already run.

const SQL = `
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  source TEXT,
  kind TEXT,
  m3u8 TEXT,
  file_path TEXT,
  size_bytes INTEGER DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  enhanced INTEGER DEFAULT 0,
  state TEXT DEFAULT 'ready',
  access_mode TEXT DEFAULT 'public',
  x_connection_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  parent_recording_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  duration_seconds REAL NOT NULL,
  status TEXT DEFAULT 'completed',
  format TEXT DEFAULT 'm4a',
  size_bytes INTEGER DEFAULT 0,
  enhanced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS x_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'local',
  user_id TEXT DEFAULT 'local',
  x_account_id TEXT,
  x_handle TEXT,
  display_name TEXT,
  avatar_url TEXT,
  auth_type TEXT DEFAULT 'session',
  encrypted_credentials TEXT,
  credential_key_version TEXT,
  status TEXT DEFAULT 'pending',
  granted_scopes TEXT,
  connected_at TEXT,
  last_validated_at TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_keys (
  version TEXT PRIMARY KEY,
  key_hex TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`

module.exports = { SQL }
