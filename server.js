"use strict";

const express      = require("express");
const path         = require("path");
const fs           = require("fs");
const crypto       = require("crypto");
const http         = require("http");
const session      = require("express-session");
const rateLimit    = require("express-rate-limit");
const { Server }   = require("socket.io");
const db           = require("./db");
const isPostgres   = db.isPostgres;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: false } });
function emitAuthenticated(event, payload) {
  io.to("authenticated").emit(event, payload);
}
function emitKioskUpdate() {
  io.emit("kiosk:update");
}

// ── config ────────────────────────────────────────────────
let envConfigCache = null;
let configLoadWarningShown = false;
const configFileCache = new Map();

function normalizeConfig(cfg) {
  cfg.locations ||= [];
  cfg.users ||= [];
  return cfg;
}

function getConfigPath() {
  return process.env.CONFIG_JSON_PATH
    ? path.resolve(process.env.CONFIG_JSON_PATH)
    : path.join(__dirname, "config.json");
}

function getExampleConfigPath() {
  return path.join(__dirname, "config.example.json");
}

function readConfigFile(configPath) {
  const stat = fs.statSync(configPath);
  const cached = configFileCache.get(configPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const value = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  configFileCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function loadConfig() {
  const configPath = getConfigPath();
  const exampleConfigPath = getExampleConfigPath();

  if (process.env.CONFIG_JSON_PATH || fs.existsSync(configPath)) {
    try {
      return readConfigFile(configPath);
    } catch (err) {
      if (!configLoadWarningShown) {
        console.error("Failed to load config file:", configPath, err.message);
        configLoadWarningShown = true;
      }
      return { locations: [], users: [] };
    }
  }

  if (envConfigCache) return envConfigCache;
  if (process.env.CONFIG_JSON) {
    try {
      envConfigCache = normalizeConfig(JSON.parse(process.env.CONFIG_JSON));
      return envConfigCache;
    } catch (err) {
      if (!configLoadWarningShown) {
        console.error("Failed to parse CONFIG_JSON:", err.message);
        configLoadWarningShown = true;
      }
      envConfigCache = { locations: [], users: [] };
      return envConfigCache;
    }
  }

  if (fs.existsSync(exampleConfigPath)) {
    try {
      return readConfigFile(exampleConfigPath);
    } catch (err) {
      if (!configLoadWarningShown) {
        console.error("Failed to load example config file:", exampleConfigPath, err.message);
        configLoadWarningShown = true;
      }
      return { locations: [], users: [] };
    }
  }

  return { locations: [], users: [] };
}

const PIN_HASH_PREFIX = "scrypt$";

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(pin), salt, 64).toString("hex");
  return `${PIN_HASH_PREFIX}${salt}$${derived}`;
}

function verifyPin(pin, storedPin) {
  const stored = String(storedPin || "");
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/i.exec(stored);
  if (match) {
    const expected = Buffer.from(match[2], "hex");
    const actual = crypto.scryptSync(String(pin), match[1], expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }
  const candidate = Buffer.from(String(pin));
  const legacy = Buffer.from(stored);
  return candidate.length === legacy.length && crypto.timingSafeEqual(candidate, legacy);
}

function isHashedPin(pin) {
  return typeof pin === "string" && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(pin);
}

function hashLegacyPins(cfg) {
  let changed = false;
  cfg.users = (cfg.users || []).map(user => {
    if (!user || typeof user === "string" || !user.pin || isHashedPin(user.pin)) return user;
    changed = true;
    return { ...user, pin: hashPin(user.pin) };
  });
  if (changed) saveConfig(cfg);
}

function validateConfigForStartup() {
  const cfg = loadConfig();
  const configPath = getConfigPath();
  const exampleConfigPath = getExampleConfigPath();
  const hasFile = fs.existsSync(configPath);
  const hasExampleFile = fs.existsSync(exampleConfigPath);
  const hasEnv = Boolean(process.env.CONFIG_JSON);
  const source = process.env.CONFIG_JSON_PATH || hasFile
    ? configPath
    : hasEnv
      ? "CONFIG_JSON"
      : hasExampleFile
        ? exampleConfigPath
        : "CONFIG_JSON";
  const usersCount = Array.isArray(cfg.users) ? cfg.users.length : 0;

  if (process.env.NODE_ENV === "production") {
    if (!(process.env.CONFIG_JSON_PATH || hasFile || hasEnv)) {
      throw new Error("Production requires a private config.json, CONFIG_JSON_PATH, or CONFIG_JSON; demo config is disabled.");
    }
    if (cfg.users.some(u => typeof u === "string" || ["demo-admin", "demo-staff"].includes(String(u?.id)))) {
      throw new Error("Production config contains demo accounts. Replace demo account IDs and credentials before starting.");
    }
    if (cfg.users.some(u => u.pin === "0000" || u.pin === "1111")) {
      throw new Error("Production config contains a known demo PIN. Change it before starting.");
    }
    if (cfg.users.some(u => !u.pin)) throw new Error("Every production user must have a PIN configured.");
  }

  if (!hasFile && !hasExampleFile && !hasEnv) {
    throw new Error(`No config source found. Expected config file at ${configPath}, ${exampleConfigPath}, or CONFIG_JSON.`);
  }

  if (usersCount === 0) {
    throw new Error(`Config loaded from ${source} but contains 0 users.`);
  }
  hashLegacyPins(cfg);
}

function saveConfig(cfg) {
  normalizeConfig(cfg);

  const configPath = getConfigPath();
  const shouldWriteFile = Boolean(process.env.CONFIG_JSON_PATH) || fs.existsSync(configPath);

  if (!shouldWriteFile && process.env.CONFIG_JSON) {
    envConfigCache = cfg;
    process.env.CONFIG_JSON = JSON.stringify(cfg);
    return;
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch {}
  configFileCache.delete(configPath);
}

function findUser(id, cfg) {
  return (cfg.users || []).find(u =>
    typeof u === "string" ? u === String(id) : String(u.id) === String(id)
  ) || null;
}

function formatUser(id, cfg) {
  const u = findUser(id, cfg);
  if (!u) return null;
  if (typeof u === "string") return { id: u, name: u, access: "staff" };
  return { id: u.id, name: u.name, role: u.role, department: u.department, access: u.access || "staff" };
}

const TIMESTAMP_FIELDS = new Set(["created_at", "updated_at", "last_seen"]);

function normalizeTimestampValue(value) {
  if (value == null || value === "") return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  const withTimeSeparator = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withTimeSeparator);
  const candidate = hasTimezone ? withTimeSeparator : `${withTimeSeparator}Z`;
  const parsed = new Date(candidate);

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeTimestamps(value, key = "") {
  if (TIMESTAMP_FIELDS.has(key)) return normalizeTimestampValue(value);
  if (Array.isArray(value)) return value.map(item => normalizeTimestamps(item));
  if (!value || typeof value !== "object" || value instanceof Date) return value;

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, normalizeTimestamps(entryValue, entryKey)])
  );
}

// ── middleware ─────────────────────────────────────────────
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === "production") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production');
  process.exit(1);
}
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

class DatabaseSessionStore extends session.Store {
  get(sid, callback) {
    db.prepare("SELECT sess, expire FROM sessions WHERE sid = ?").get(sid).then(row => {
      if (!row || Number(row.expire) <= Date.now()) {
        if (row) this.destroy(sid, () => callback(null, null));
        else callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.sess));
    }).catch(callback);
  }

  set(sid, sess, callback) {
    const expire = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess.cookie?.maxAge || SESSION_MAX_AGE_MS);
    db.prepare(`
      INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `).run(sid, JSON.stringify(sess), expire).then(() => callback?.(null), err => callback?.(err));
  }

  touch(sid, sess, callback) {
    const expire = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess.cookie?.maxAge || SESSION_MAX_AGE_MS);
    db.prepare("UPDATE sessions SET expire = ? WHERE sid = ?").run(expire, sid)
      .then(() => callback?.(null), err => callback?.(err));
  }

  destroy(sid, callback) {
    db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid)
      .then(() => callback?.(null), err => callback?.(err));
  }
}

const sessionMiddleware = session({
  name: "gada.sid",
  secret: process.env.SESSION_SECRET || "gada-dev-secret-change-me-in-production",
  store: new DatabaseSessionStore(),
  proxy: process.env.NODE_ENV === "production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_MS
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin) {
    const forwardedProto = String(socket.handshake.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = process.env.NODE_ENV === "production" ? (forwardedProto || "https") : "http";
    const host = socket.handshake.headers.host;
    if (!host || origin !== `${protocol}://${host}`) return next(new Error("Cross-origin socket blocked"));
  }
  const userId = socket.request.session?.userId;
  if (userId && findUser(userId, loadConfig())) {
    socket.data.authenticated = true;
    socket.data.userId = String(userId);
    return next();
  }
  socket.data.authenticated = false;
  next(); // Public kiosk sockets receive only the sanitized kiosk:update signal.
});

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.body === undefined) req.body = {};
  else if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "JSON body must be an object" });
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;
    if ((origin && origin !== expectedOrigin) || req.get("sec-fetch-site") === "cross-site") {
      return res.status(403).json({ error: "Cross-origin request blocked" });
    }
  }
  const sendJson = res.json.bind(res);
  res.json = body => sendJson(normalizeTimestamps(body));
  next();
});

// rate-limit login attempts: 10 per 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Please wait 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false
});
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  keyGenerator: req => String(req.body?.userId || "unknown").trim().toLowerCase().slice(0, 80),
  message: { error: "Too many login attempts for this account. Please wait 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false
});

// block direct config access (config is now at root, not public, but belt+suspenders)
app.get("/config.json", (req, res) => res.status(404).send("Not found"));

// serve public files (no auth needed for static assets)
app.use(express.static(path.join(__dirname, "public")));

// ── auth guards ────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId || !findUser(req.session.userId, loadConfig())) return res.status(401).json({ error: "Not authenticated" });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  const cfg  = loadConfig();
  const user = findUser(req.session.userId, cfg);
  if (!user || user.access !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

function requireStaff(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  const cfg    = loadConfig();
  const user   = findUser(req.session.userId, cfg);
  const access = user?.access || "viewer";
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (!["admin", "staff"].includes(access)) return res.status(403).json({ error: "Scan access required" });
  next();
}

const VALID_ASSET_STATUSES = new Set(["available", "in-use", "maintenance", "missing"]);

// ── safe public config (locations + user names only, no PINs) ──
app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  res.set("Cache-Control", "private, max-age=15, must-revalidate");
  res.json({
    locations: cfg.locations || [],
    users: (cfg.users || []).map(u => typeof u === "string"
      ? { id: u, name: u }
      : { id: u.id, name: u.name || u.id })
  });
});

app.get("/api/kiosk", async (req, res) => {
  const cfg = loadConfig();
  const assets = await db.prepare(`
    WITH ranked_events AS (
      SELECT e.asset_id, e.location, e.created_at,
        ROW_NUMBER() OVER (PARTITION BY e.asset_id ORDER BY e.created_at DESC, e.event_id DESC) AS event_rank
      FROM events e
    )
    SELECT a.tag, a.name, a.category, a.status,
      e.location AS last_location, e.created_at AS last_seen
    FROM assets a
    LEFT JOIN ranked_events e ON e.asset_id = a.asset_id AND e.event_rank = 1
    ORDER BY ${isPostgres ? "LOWER(a.tag)" : "a.tag COLLATE NOCASE"}
  `).all();
  res.set("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
  res.json({ locations: cfg.locations || [], assets });
});

// ── auth routes ────────────────────────────────────────────
app.post("/api/login", loginLimiter, loginAccountLimiter, (req, res, next) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: "User and PIN required" });
  if (!/^\d{4,8}$/.test(String(pin))) return res.status(401).json({ error: "Invalid credentials" });

  const cfg  = loadConfig();
  const user = findUser(userId, cfg);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const storedPin = typeof user === "string" ? null : user.pin;
  if (!storedPin) return res.status(401).json({ error: "Invalid credentials" });
  if (!verifyPin(pin, storedPin)) return res.status(401).json({ error: "Invalid credentials" });

  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.userId = user.id;
    req.session.loginTime = Date.now();
    req.session.save(saveError => {
      if (saveError) return next(saveError);
      res.json({ ok: true, user: formatUser(user.id, cfg) });
    });
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    res.clearCookie("gada.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    if (err) return res.status(500).json({ error: "Could not end session" });
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const cfg = loadConfig();
  res.json({ user: formatUser(req.session.userId, cfg) });
});

// ── asset routes ───────────────────────────────────────────
app.get("/api/assets", requireAuth, async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : null;
  const rows = await db.prepare(`
    WITH ranked_events AS (
      SELECT e.asset_id, e.location, e.scanned_by, e.created_at,
        ROW_NUMBER() OVER (PARTITION BY e.asset_id ORDER BY e.created_at DESC, e.event_id DESC) AS event_rank
      FROM events e
    )
    SELECT a.*, e.location AS last_location, e.scanned_by AS last_scanned_by, e.created_at AS last_seen
    FROM assets a
    LEFT JOIN ranked_events e ON e.asset_id = a.asset_id AND e.event_rank = 1
    ORDER BY COALESCE(e.created_at, a.created_at) DESC,
      ${isPostgres ? "LOWER(a.tag)" : "a.tag COLLATE NOCASE"}
    ${limit ? "LIMIT ?" : ""}
  `).all(...(limit ? [limit] : []));
  res.json(rows);
});

app.get("/api/assets/search", requireAuth, async (req, res) => {
  const term = String(req.query.q || "").trim().slice(0, 80).toLowerCase().replace(/[\\%_]/g, "");
  if (!term) return res.json([]);
  const prefix = `${term}%`;
  const tagSearch = isPostgres ? "LOWER(a.tag)" : "LOWER(a.tag) COLLATE NOCASE";
  const nameSearch = isPostgres ? "LOWER(a.name)" : "LOWER(a.name) COLLATE NOCASE";
  const rows = await db.prepare(`
    WITH matched_assets AS (
      SELECT a.*
      FROM assets a
      WHERE ${tagSearch} LIKE ? OR ${nameSearch} LIKE ?
      ORDER BY CASE WHEN LOWER(a.tag) = ? THEN 0 ELSE 1 END,
        ${isPostgres ? "LOWER(a.name), LOWER(a.tag)" : "a.name COLLATE NOCASE, a.tag COLLATE NOCASE"}
      LIMIT 20
    ), ranked_events AS (
      SELECT e.asset_id, e.location, e.created_at,
        ROW_NUMBER() OVER (PARTITION BY e.asset_id ORDER BY e.created_at DESC, e.event_id DESC) AS event_rank
      FROM events e JOIN matched_assets a ON a.asset_id = e.asset_id
    )
    SELECT a.tag, a.name, a.category, a.status,
      e.location AS last_location, e.created_at AS last_seen
    FROM matched_assets a
    LEFT JOIN ranked_events e ON e.asset_id = a.asset_id AND e.event_rank = 1
    ORDER BY CASE WHEN LOWER(a.tag) = ? THEN 0 ELSE 1 END,
      ${isPostgres ? "LOWER(a.name), LOWER(a.tag)" : "a.name COLLATE NOCASE, a.tag COLLATE NOCASE"}
  `).all(prefix, prefix, term, term);
  res.json(rows);
});

app.get("/api/assets/labels", requireAdmin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT tag, name, category
    FROM assets
    ORDER BY ${isPostgres ? "LOWER(name), LOWER(tag)" : "name COLLATE NOCASE, tag COLLATE NOCASE"}
  `).all();
  res.json(rows);
});

app.get("/api/alerts", requireAuth, async (req, res) => {
  const sql = isPostgres ? `
    WITH ranked_events AS (
      SELECT e.asset_id, e.location, e.created_at,
        ROW_NUMBER() OVER (PARTITION BY e.asset_id ORDER BY e.created_at DESC, e.event_id DESC) AS event_rank
      FROM events e
    ), asset_last_seen AS (
      SELECT a.tag, a.name, a.status, e.location AS last_location, e.created_at AS last_seen
      FROM assets a LEFT JOIN ranked_events e ON e.asset_id = a.asset_id AND e.event_rank = 1
    )
    SELECT tag, name, last_seen, last_location, status,
      CASE
        WHEN last_seen IS NULL THEN NULL
        ELSE ROUND(EXTRACT(EPOCH FROM NOW() - last_seen) / 3600.0, 1)
      END AS hours_since
    FROM asset_last_seen
    WHERE status = 'missing'
      OR (last_seen IS NOT NULL AND last_seen < NOW() - INTERVAL '24 hours')
    ORDER BY
      CASE WHEN status = 'missing' THEN 0 ELSE 1 END,
      hours_since DESC
  ` : `
    WITH ranked_events AS (
      SELECT e.asset_id, e.location, e.created_at,
        ROW_NUMBER() OVER (PARTITION BY e.asset_id ORDER BY e.created_at DESC, e.event_id DESC) AS event_rank
      FROM events e
    ), asset_last_seen AS (
      SELECT a.tag, a.name, a.status, e.location AS last_location, e.created_at AS last_seen
      FROM assets a LEFT JOIN ranked_events e ON e.asset_id = a.asset_id AND e.event_rank = 1
    )
    SELECT tag, name, last_seen, last_location, status,
      CASE
        WHEN last_seen IS NULL THEN NULL
        ELSE ROUND((julianday('now') - julianday(last_seen)) * 24, 1)
      END AS hours_since
    FROM asset_last_seen
    WHERE status = 'missing'
      OR (last_seen IS NOT NULL AND last_seen < datetime('now', '-24 hours'))
    ORDER BY
      CASE WHEN status = 'missing' THEN 0 ELSE 1 END,
      hours_since DESC
  `;
  const rows = await db.prepare(sql).all();
  res.json(rows);
});

app.get("/api/assets/:tag", requireAuth, async (req, res) => {
  const asset = await db.prepare("SELECT * FROM assets WHERE tag = ?").get(req.params.tag);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  const events = await db.prepare("SELECT * FROM events WHERE asset_id = ? ORDER BY created_at DESC").all(asset.asset_id);
  res.json({ asset, events });
});

// create asset — admin only
app.post("/api/assets", requireAdmin, async (req, res) => {
  const tag = typeof req.body.tag === "string" ? req.body.tag.trim() : "";
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const category = typeof req.body.category === "string" ? req.body.category.trim() : "";
  const status = req.body.status || "available";
  if (!tag || !name) return res.status(400).json({ error: "tag and name required" });
  if (tag.length > 100 || name.length > 120 || category.length > 80) return res.status(400).json({ error: "Asset fields exceed the allowed length" });
  if (!VALID_ASSET_STATUSES.has(status)) return res.status(400).json({ error: "Invalid asset status" });
  try {
    const sql = isPostgres
      ? "INSERT INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?) RETURNING asset_id"
      : "INSERT INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?)";
    const info = await db.prepare(sql).run(tag, name, category || null, status);
    const asset = { asset_id: info.lastInsertRowid || info.rows?.[0]?.asset_id, tag, name, category: category || null, status };
    emitAuthenticated("asset:created", asset);
    emitKioskUpdate();
    res.json(asset);
  } catch (e) {
    res.status(409).json({ error: "Tag already exists" });
  }
});

app.post("/api/assets/import", requireAdmin, async (req, res) => {
  const assets = Array.isArray(req.body.assets) ? req.body.assets : null;
  if (!assets) return res.status(400).json({ error: "assets array required" });

  let imported = 0;
  let skipped = 0;
  const validRows = [];

  for (const row of assets) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped++;
      continue;
    }
    const tag = String(row.tag || "").trim();
    const name = String(row.name || "").trim();
    const category = String(row.category || "").trim();
    const status = String(row.status || "available").trim() || "available";

    if (!tag || tag.length > 100 || !name || name.length > 120 || category.length > 80 || !VALID_ASSET_STATUSES.has(status)) {
      skipped++;
      continue;
    }

    validRows.push([tag, name, category || null, status]);
  }

  // Batch imports so large CSV uploads issue one INSERT per chunk, not one
  // database round trip for each asset.
  for (let offset = 0; offset < validRows.length; offset += 200) {
    const chunk = validRows.slice(offset, offset + 200);
    const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    const info = await db.prepare(`
      INSERT INTO assets (tag, name, category, status) VALUES ${values}
      ON CONFLICT (tag) DO NOTHING${isPostgres ? " RETURNING tag" : ""}
    `).run(...chunk.flat());
    imported += info.changes ?? 0;
  }
  skipped += validRows.length - imported;

  if (imported > 0) {
    emitAuthenticated("asset:created", { bulk: true, imported });
    emitKioskUpdate();
  }
  res.json({ imported, skipped });
});

// update asset
app.put("/api/assets/:tag", requireAdmin, async (req, res) => {
  const { name, category, status } = req.body;
  const valid = ['available','in-use','maintenance','missing'];
  if (status && !valid.includes(status))
    return res.status(400).json({ error: "Invalid status" });
  if ((name != null && (typeof name !== "string" || !name.trim() || name.length > 120)) ||
      (category != null && (typeof category !== "string" || category.length > 80))) {
    return res.status(400).json({ error: "Invalid asset name or category" });
  }

  const result = await db.prepare("UPDATE assets SET name=COALESCE(?,name), category=COALESCE(?,category), status=COALESCE(?,status) WHERE tag=?")
    .run(name?.trim() || null, category?.trim() || null, status || null, req.params.tag);
  if (!result.changes) return res.status(404).json({ error: "Asset not found" });

  emitAuthenticated("asset:updated", { tag: req.params.tag });
  emitKioskUpdate();
  res.json({ ok: true });
});

// delete asset — admin only
app.delete("/api/assets/:tag", requireAdmin, async (req, res) => {
  const asset = await db.prepare("SELECT * FROM assets WHERE tag = ?").get(req.params.tag);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  await db.prepare("DELETE FROM events WHERE asset_id = ?").run(asset.asset_id);
  await db.prepare("DELETE FROM assets WHERE asset_id = ?").run(asset.asset_id);
  emitAuthenticated("asset:deleted", { tag: req.params.tag });
  emitKioskUpdate();
  res.json({ ok: true });
});

// ── scan route ─────────────────────────────────────────────
app.post("/api/scan", requireStaff, async (req, res) => {
  const { tag, action, location, notes } = req.body;
  if (typeof tag !== "string" || !tag.trim() || tag.length > 100 || !action || !location) {
    return res.status(400).json({ error: "A valid tag, action and location are required" });
  }
  if (!["TRANSFERRED", "SCANNED_IN", "SCANNED_OUT"].includes(action)) return res.status(400).json({ error: "Invalid scan action" });
  if (notes != null && (typeof notes !== "string" || notes.length > 500)) return res.status(400).json({ error: "Notes must be 500 characters or fewer" });

  const cfg = loadConfig();
  if (!cfg.locations.length || !cfg.locations.includes(location))
    return res.status(400).json({ error: "Invalid location" });

  let asset = await db.prepare("SELECT * FROM assets WHERE tag = ?").get(tag);
  if (!asset) {
    const insertAssetSql = isPostgres
      ? "INSERT INTO assets (tag, name) VALUES (?, ?) RETURNING asset_id"
      : "INSERT INTO assets (tag, name) VALUES (?, ?)";
    const info = await db.prepare(insertAssetSql).run(tag, `Unknown Asset (${tag})`);
    asset = {
      asset_id: info.lastInsertRowid || info.rows?.[0]?.asset_id,
      tag,
      name: `Unknown Asset (${tag})`,
      category: null,
      status: "available"
    };
  }

  const eventSql = isPostgres
    ? "INSERT INTO events (asset_id, action, location, scanned_by, notes) VALUES (?, ?, ?, ?, ?) RETURNING event_id"
    : "INSERT INTO events (asset_id, action, location, scanned_by, notes) VALUES (?, ?, ?, ?, ?)";
  const eventInfo = await db.prepare(eventSql)
    .run(asset.asset_id, action, location, req.session.userId, notes || null);

  const payload = { tag: asset.tag, name: asset.name, action, location, scanned_by: req.session.userId, at: new Date().toISOString() };
  emitAuthenticated("scan:new", payload);
  emitKioskUpdate();

  res.json({ ok: true, asset, eventId: eventInfo.lastInsertRowid });
});

// ── undo scan — staff+ ────────────────────────────
app.delete("/api/scan/undo/:eventId", requireStaff, async (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (!eventId) return res.status(400).json({ error: "Invalid event ID" });

  const event = await db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Scan event not found" });

  // only the person who scanned can undo, within 30 seconds
  const age = Date.now() - new Date(event.created_at).getTime();
  if (age > 30000) return res.status(400).json({ error: "Undo window has expired (30s)" });
  if (event.scanned_by !== req.session.userId) return res.status(403).json({ error: "You can only undo your own scans" });

  await db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);

  // emit live update
  emitAuthenticated("scan:undone", { tag: event.asset_id });
  emitKioskUpdate();
  res.json({ ok: true });
});

// ── audit log viewer — admin only ────────────────
app.get("/api/audit/log", requireAdmin, async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1000)) : 1000;
  const rows = await db.prepare(`
    SELECT
      a.tag, a.name, a.category,
      e.event_id, e.action, e.location, e.scanned_by, e.notes, e.created_at
    FROM events e
    JOIN assets a ON a.asset_id = e.asset_id
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(rows);
});

// ── audit export — admin only ─────────────────────────────
app.get("/api/audit/export", requireAdmin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT
      a.tag, a.name, a.category,
      e.action, e.location, e.scanned_by, e.notes, e.created_at
    FROM events e
    JOIN assets a ON a.asset_id = e.asset_id
    ORDER BY e.created_at DESC
  `).all();

  const header = ["Tag","Asset Name","Category","Action","Location","Scanned By","Notes","Timestamp"];
  const escape = v => {
    let value = String(v ?? "");
    if (/^[\s]*[=+\-@]/.test(value)) value = `'${value}`;
    return `"${value.replace(/"/g,'""')}"`;
  };
  const csv = [header.join(","), ...rows.map(r =>
    [r.tag, r.name, r.category||"", r.action, r.location, r.scanned_by, r.notes||"", r.created_at].map(escape).join(",")
  )].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="gada-audit-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

app.get("/api/reports/shift", requireAdmin, async (req, res) => {
  const { from, to, operator } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to required" });
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: "Invalid date range" });
  }

  const fromTs = isPostgres ? fromDate.toISOString() : fromDate.toISOString().slice(0, 19).replace('T', ' ');
  const toTs = isPostgres ? toDate.toISOString() : toDate.toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.prepare(`
    SELECT a.tag, a.name, a.category, e.action, e.location, e.scanned_by, e.notes, e.created_at
    FROM events e
    JOIN assets a ON a.asset_id = e.asset_id
    WHERE e.created_at >= ? AND e.created_at <= ?
    ${operator ? 'AND e.scanned_by = ?' : ''}
    ORDER BY e.created_at ASC
  `).all(...(operator ? [fromTs, toTs, operator] : [fromTs, toTs]));

  const summary = {
    total_scans: rows.length,
    unique_assets: new Set(rows.map(r => r.tag)).size,
    unique_operators: new Set(rows.map(r => r.scanned_by)).size,
    locations_active: new Set(rows.map(r => r.location)).size
  };

  const countBy = (key) => Object.entries(rows.reduce((acc, row) => {
    const value = row[key] || 'Unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {})).map(([label, count]) => ({ [key]: label, count }));

  const byOperator = countBy('scanned_by').sort((a, b) => b.count - a.count).map(r => ({ scanned_by: r.scanned_by, count: r.count }));
  const byLocation = countBy('location').sort((a, b) => b.count - a.count).map(r => ({ location: r.location, count: r.count }));
  const byAction = countBy('action').sort((a,b) => b.count - a.count).map(r => ({ action: r.action, count: r.count }));

  res.json({
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    summary,
    by_operator: byOperator,
    by_location: byLocation,
    by_action: byAction,
    events: rows
  });
});

// ── user management — admin only ──────────────────────────
app.post("/api/users/change-pin", requireAuth, (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) return res.status(400).json({ error: "currentPin and newPin required" });
  if (!/^\d{4,8}$/.test(String(currentPin))) return res.status(401).json({ error: "Current PIN is incorrect" });
  const minPinLength = 6;
  if (!new RegExp(`^\\d{${minPinLength},8}$`).test(String(newPin))) {
    return res.status(400).json({ error: `New PIN must be ${minPinLength}–8 digits` });
  }

  const cfg = loadConfig();
  const idx = (cfg.users || []).findIndex(u =>
    typeof u === "string" ? u === String(req.session.userId) : String(u.id) === String(req.session.userId)
  );
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  const user = cfg.users[idx];
  if (typeof user === "string" || !user.pin) return res.status(400).json({ error: "No PIN configured for this account" });
  if (!verifyPin(currentPin, user.pin)) return res.status(401).json({ error: "Current PIN is incorrect" });

  cfg.users[idx] = { ...user, pin: hashPin(newPin) };
  saveConfig(cfg);
  res.json({ ok: true });
});

app.get("/api/users", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  // never send PINs to the client
  const safe = (cfg.users || []).map(u => {
    if (typeof u === "string") return { id: u, name: u, access: "staff" };
    const { pin, ...rest } = u;
    return rest;
  });
  res.json(safe);
});

app.get("/api/users/:id/activity", requireAdmin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT
      e.event_id, e.action, e.location, e.scanned_by, e.notes, e.created_at,
      a.name AS asset_name, a.tag
    FROM events e
    JOIN assets a ON a.asset_id = e.asset_id
    WHERE e.scanned_by = ?
    ORDER BY e.created_at DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(rows);
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const { id, name, role, department, access, pin } = req.body;
  if (!id || !name || !pin) return res.status(400).json({ error: "id, name and pin required" });
  const minPinLength = 6;
  if (typeof id !== "string" || !id.trim() || id.length > 80 || typeof name !== "string" || !name.trim() || name.length > 120 ||
      !new RegExp(`^\\d{${minPinLength},8}$`).test(String(pin))) {
    return res.status(400).json({ error: `Use a valid ID and name, and a PIN of ${minPinLength}–8 digits` });
  }
  if (access && !["admin", "staff", "viewer"].includes(access)) return res.status(400).json({ error: "Invalid access level" });
  if ((role != null && typeof role !== "string") || (department != null && typeof department !== "string") ||
      String(role || "").length > 80 || String(department || "").length > 80) return res.status(400).json({ error: "Role or department is invalid" });

  const cfg = loadConfig();
  if (findUser(id.trim(), cfg)) return res.status(409).json({ error: "User ID already exists" });

  cfg.users.push({ id: id.trim(), name: name.trim(), role: String(role || "").trim(), department: String(department || "").trim(), access: access || "staff", pin: hashPin(pin) });
  saveConfig(cfg);
  res.json({ ok: true });
});

app.put("/api/users/:id", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.users.findIndex(u => (typeof u === "string" ? u : u.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  const body = req.body;
  const allowedFields = new Set(["name", "role", "department", "access", "pin"]);
  if (Object.keys(body).some(key => !allowedFields.has(key))) return res.status(400).json({ error: "Unsupported user field" });
  const minPinLength = 6;
  if (body.access && !["admin", "staff", "viewer"].includes(body.access)) return res.status(400).json({ error: "Invalid access level" });
  if (body.name != null && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)) return res.status(400).json({ error: "Invalid user name" });
  if ((body.role != null && (typeof body.role !== "string" || body.role.length > 80)) ||
      (body.department != null && (typeof body.department !== "string" || body.department.length > 80))) {
    return res.status(400).json({ error: "Role or department is too long" });
  }
  if (body.pin != null && !new RegExp(`^\\d{${minPinLength},8}$`).test(String(body.pin))) {
    return res.status(400).json({ error: `PIN must be ${minPinLength}–8 digits` });
  }
  const existing = cfg.users[idx];
  if (typeof existing === "string") return res.status(400).json({ error: "Legacy user entry must be replaced with a PIN-based account" });
  const updated = { ...existing };
  for (const field of ["name", "role", "department", "access"]) {
    if (body[field] != null) updated[field] = typeof body[field] === "string" ? body[field].trim() : body[field];
  }
  if (body.pin != null) updated.pin = hashPin(body.pin);
  cfg.users[idx] = updated;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: "Cannot delete your own account" });
  const cfg = loadConfig();
  if (!findUser(req.params.id, cfg)) return res.status(404).json({ error: "User not found" });
  cfg.users = cfg.users.filter(u => (typeof u === "string" ? u : u.id) !== req.params.id);
  saveConfig(cfg);
  io.in(`user:${req.params.id}`).disconnectSockets(true);
  res.json({ ok: true });
});

app.use("/api", (err, req, res, next) => {
  console.error(`API error ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error" });
});

// ── websocket ──────────────────────────────────────────────
io.on("connection", socket => {
  if (socket.data.authenticated) {
    socket.join("authenticated");
    socket.join(`user:${socket.data.userId}`);
  }
  console.log("WS client connected:", socket.id);
  socket.on("disconnect", () => console.log("WS client disconnected:", socket.id));
});

const sessionCleanup = setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expire <= ?").run(Date.now())
    .catch(err => console.error("Expired session cleanup failed:", err.message));
}, 60 * 60 * 1000);
sessionCleanup.unref();

// ── start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`FATAL: Port ${PORT} is already in use.`);
  } else {
    console.error("FATAL: Server failed to start:", err.message);
  }
  process.exit(1);
});

db.ready
  .then(() => {
    try {
      validateConfigForStartup();
    } catch (err) {
      console.error("FATAL: Config validation failed:", err.message);
      process.exit(1);
    }
    server.listen(PORT, () => console.log(`\n🏥 GADA running → http://localhost:${PORT}\n`));
  })
  .catch(err => {
    console.error("FATAL: Database initialization failed:", err.message);
    process.exit(1);
  });
