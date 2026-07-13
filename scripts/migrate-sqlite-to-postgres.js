const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Database = require('better-sqlite3');
const { Client } = require('pg');

function maskDatabaseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.password) url.password = '****';
    return url.toString();
  } catch {
    return 'configured DATABASE_URL';
  }
}

function explainConnectionError(err, rawUrl) {
  if (err.code === 'ENOTFOUND') {
    return [
      `Could not resolve the Postgres host: ${err.hostname}`,
      '',
      'Check DATABASE_URL in your .env file. It is still pointing at a host',
      'that DNS cannot find. If you switched to Neon, paste the Neon connection',
      'string here. If you are using Supabase, recopy the current Supabase',
      'connection string and replace [YOUR-PASSWORD] with your database password.',
      '',
      `Current target: ${maskDatabaseUrl(rawUrl)}`
    ].join('\n');
  }

  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    return [
      `Could not connect to Postgres (${err.code}).`,
      'Check that the database is running and that your network can reach it.',
      '',
      `Current target: ${maskDatabaseUrl(rawUrl)}`
    ].join('\n');
  }

  if (err.code === '28P01') {
    return [
      'Postgres rejected the username or password.',
      'Check the password in DATABASE_URL. URL-encode special characters like @, #, %, /, and spaces.',
      '',
      `Current target: ${maskDatabaseUrl(rawUrl)}`
    ].join('\n');
  }

  return err.message;
}

const sqlitePath = path.join(__dirname, '..', 'gada.db');
if (!fs.existsSync(sqlitePath)) {
  console.error('Cannot find gada.db in project root.');
  process.exit(1);
}

const sqliteDb = new Database(sqlitePath, { readonly: true });
const pgUrl = process.env.DATABASE_URL;
if (!pgUrl) {
  console.error('Set DATABASE_URL in .env or in the environment before running this script.');
  process.exit(1);
}

let pg;

(async () => {
  pg = new Client({ connectionString: pgUrl });
  console.log(`Connecting to Postgres: ${maskDatabaseUrl(pgUrl)}`);
  await pg.connect();

  const createSchema = `
CREATE TABLE IF NOT EXISTS assets (
  asset_id SERIAL PRIMARY KEY,
  tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  event_id SERIAL PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(asset_id),
  action TEXT NOT NULL,
  location TEXT NOT NULL,
  scanned_by TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_asset_id ON events(asset_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
  `;

  await pg.query(createSchema);
  console.log('Truncating existing Postgres tables...');
  await pg.query('TRUNCATE events, assets RESTART IDENTITY CASCADE');

  console.log('Migrating assets...');
  const assets = sqliteDb.prepare('SELECT asset_id, tag, name, category, status, created_at FROM assets').all();
  for (const asset of assets) {
    await pg.query(
      'INSERT INTO assets (asset_id, tag, name, category, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [asset.asset_id, asset.tag, asset.name, asset.category, asset.status, asset.created_at]
    );
  }

  console.log('Migrating events...');
  const events = sqliteDb.prepare('SELECT event_id, asset_id, action, location, scanned_by, notes, created_at FROM events').all();
  for (const event of events) {
    await pg.query(
      'INSERT INTO events (event_id, asset_id, action, location, scanned_by, notes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [event.event_id, event.asset_id, event.action, event.location, event.scanned_by, event.notes, event.created_at]
    );
  }

  await pg.query("SELECT setval(pg_get_serial_sequence('assets','asset_id'), COALESCE((SELECT MAX(asset_id) FROM assets), 1), true)");
  await pg.query("SELECT setval(pg_get_serial_sequence('events','event_id'), COALESCE((SELECT MAX(event_id) FROM events), 1), true)");

  await pg.end();
  sqliteDb.close();
  console.log('Migration complete.');
})().catch(err => {
  console.error(explainConnectionError(err, pgUrl));
  try {
    if (pg) pg.end();
  } catch {}
  sqliteDb.close();
  process.exit(1);
});
