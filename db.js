const Database = require("better-sqlite3");

const db = new Database("gada.db");

// Create tables if they don't exist
db.exec(`
CREATE TABLE IF NOT EXISTS assets (
  asset_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  location TEXT NOT NULL,
  scanned_by TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
`);

module.exports = db;
