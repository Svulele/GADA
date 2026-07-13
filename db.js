const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const usePostgres = Boolean(process.env.DATABASE_URL);

function placeholderify(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

function createSqliteDb() {
  const Database = require("better-sqlite3");
  const dbPath = path.join(__dirname, "gada.db");
  const sqliteDb = new Database(dbPath);
  console.log("✅ Using SQLite DB at:", dbPath);

  const normalizeParams = params => params === undefined ? [] : Array.isArray(params) ? params : [params];

  const prepare = sql => {
    const stmt = sqliteDb.prepare(sql);
    return {
      all: (...params) => Promise.resolve(stmt.all(normalizeParams(params.length ? params : undefined))),
      get: (...params) => Promise.resolve(stmt.get(normalizeParams(params.length ? params : undefined))),
      run: (...params) => Promise.resolve(stmt.run(normalizeParams(params.length ? params : undefined)))
    };
  };

  return {
    isPostgres: false,
    prepare,
    transaction(fn) {
      const tx = sqliteDb.transaction((...args) => fn({ prepare }, ...args));
      return (...args) => Promise.resolve(tx(...args));
    },
    exec(sql) {
      sqliteDb.exec(sql);
      return Promise.resolve();
    }
  };
}

function createPostgresDb() {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const safeDatabaseUrl = (() => {
    try {
      const url = new URL(process.env.DATABASE_URL);
      if (url.password) url.password = "****";
      return url.toString();
    } catch {
      return "configured DATABASE_URL";
    }
  })();
  console.log("✅ Using Postgres DB at:", safeDatabaseUrl);

  const normalizeParams = params => Array.isArray(params) ? params : params === undefined ? [] : [params];

  const prepareStatement = (sql, client) => {
    const query = async params => {
      const text = placeholderify(sql);
      return client.query(text, normalizeParams(params));
    };

    return {
      all: async (...params) => {
        const res = await query(params.length ? params : undefined);
        return res.rows;
      },
      get: async (...params) => {
        const res = await query(params.length ? params : undefined);
        return res.rows[0] || null;
      },
      run: async (...params) => {
        const res = await query(params.length ? params : undefined);
        const result = { rowCount: res.rowCount, changes: res.rowCount };
        if (res.rows && res.rows[0]) {
          result.lastInsertRowid = res.rows[0].asset_id ?? res.rows[0].event_id ?? res.rows[0].id ?? null;
        }
        return result;
      }
    };
  };

  return {
    isPostgres: true,
    prepare(sql) {
      return prepareStatement(sql, pool);
    },
    transaction(fn) {
      return async (...args) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const tx = {
            prepare: sql => prepareStatement(sql, client)
          };
          const result = await fn(tx, ...args);
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      };
    },
    async exec(sql) {
      await pool.query(sql);
    }
  };
}

const db = usePostgres ? createPostgresDb() : createSqliteDb();

db.ready = (async () => {
  if (usePostgres) {
    await db.exec(`
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
    `);
  } else {
    const dbPath = path.join(__dirname, "gada.db");
    const sqliteDb = require("better-sqlite3")(dbPath);
    sqliteDb.exec(`
CREATE TABLE IF NOT EXISTS assets (
  asset_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'available',
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

    try {
      sqliteDb.exec("ALTER TABLE assets ADD COLUMN status TEXT NOT NULL DEFAULT 'available'");
    } catch (e) {
      if (!String(e.message || "").includes("duplicate column name")) throw e;
    }
    sqliteDb.close();
  }
})();

module.exports = db;
