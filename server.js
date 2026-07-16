"use strict";

const express      = require("express");
const path         = require("path");
const fs           = require("fs");
const http         = require("http");
const session      = require("express-session");
const rateLimit    = require("express-rate-limit");
const { Server }   = require("socket.io");
const db           = require("./db");
const isPostgres   = db.isPostgres;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: false } });

// ── config ────────────────────────────────────────────────
let envConfigCache = null;
let configLoadWarningShown = false;

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
  return normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
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

  return { locations: [], users: [] };
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
    : hasExampleFile
      ? exampleConfigPath
      : "CONFIG_JSON";
  const usersCount = Array.isArray(cfg.users) ? cfg.users.length : 0;

  if (!hasFile && !hasExampleFile && !hasEnv) {
    throw new Error(`No config source found. Expected config file at ${configPath}, ${exampleConfigPath}, or CONFIG_JSON.`);
  }

  if (usersCount === 0) {
    throw new Error(`Config loaded from ${source} but contains 0 users.`);
  }
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

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
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
app.use(express.json());
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production');
  process.exit(1);
}
app.use(session({
  secret: process.env.SESSION_SECRET || "gada-dev-secret-change-me-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000  // 8-hour session timeout
  }
}));

app.use("/api", (req, res, next) => {
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

// block direct config access (config is now at root, not public, but belt+suspenders)
app.get("/config.json", (req, res) => res.status(404).send("Not found"));

// serve public files (no auth needed for static assets)
app.use(express.static(path.join(__dirname, "public")));

// ── auth guards ────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
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
  if (access === "viewer") return res.status(403).json({ error: "Scan access required" });
  next();
}

const VALID_ASSET_STATUSES = new Set(["available", "in-use", "maintenance", "missing"]);

// ── safe public config (locations + user names only, no PINs) ──
app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  res.json({
    locations: cfg.locations || [],
    users: (cfg.users || []).map(u => {
      if (typeof u === "string") return { id: u, name: u };
      const { pin, ...safe } = u;
      return safe;
    })
  });
});

app.get("/api/kiosk", async (req, res) => {
  const cfg = loadConfig();
  const assets = await db.prepare(`
    SELECT a.tag, a.name, a.category, a.status,
      (SELECT e.location   FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_location,
      (SELECT e.created_at FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_seen,
      (SELECT e.scanned_by FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_scanned_by
    FROM assets a
    ORDER BY ${isPostgres ? "LOWER(a.tag)" : "a.tag COLLATE NOCASE"}
  `).all();
  res.json({ locations: cfg.locations || [], assets });
});

// ── auth routes ────────────────────────────────────────────
app.post("/api/login", loginLimiter, (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: "User and PIN required" });

  const cfg  = loadConfig();
  const user = findUser(userId, cfg);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const storedPin = typeof user === "string" ? null : user.pin;
  if (!storedPin) return res.status(401).json({ error: "No PIN configured for this account" });
  if (String(pin) !== String(storedPin)) return res.status(401).json({ error: "Invalid credentials" });

  req.session.userId = user.id;
  req.session.loginTime = Date.now();
  res.json({ ok: true, user: formatUser(user.id, cfg) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const cfg = loadConfig();
  res.json({ user: formatUser(req.session.userId, cfg) });
});

// ── asset routes ───────────────────────────────────────────
app.get("/api/assets", requireAuth, async (req, res) => {
  const sql = isPostgres ? `
    SELECT a.*,
      last_event.location AS last_location,
      last_event.scanned_by AS last_scanned_by,
      last_event.created_at AS last_seen
    FROM assets a
    LEFT JOIN LATERAL (
      SELECT e.location, e.scanned_by, e.created_at
      FROM events e
      WHERE e.asset_id = a.asset_id
      ORDER BY e.created_at DESC, e.event_id DESC
      LIMIT 1
    ) last_event ON true
    ORDER BY COALESCE(last_event.created_at, a.created_at) DESC, LOWER(a.tag)
  ` : `
    SELECT a.*,
      (SELECT e.location   FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_location,
      (SELECT e.scanned_by FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_scanned_by,
      (SELECT e.created_at FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_seen
    FROM assets a
    ORDER BY COALESCE(last_seen, a.created_at) DESC, a.tag COLLATE NOCASE
  `;
  const rows = await db.prepare(sql).all();
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
    WITH asset_last_seen AS (
      SELECT a.tag, a.name, a.status,
        (SELECT e.location   FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_location,
        (SELECT e.created_at FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_seen
      FROM assets a
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
    WITH asset_last_seen AS (
      SELECT a.tag, a.name, a.status,
        (SELECT e.location   FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_location,
        (SELECT e.created_at FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_seen
      FROM assets a
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
  const { tag, name, category } = req.body;
  const status = req.body.status || "available";
  if (!tag || !name) return res.status(400).json({ error: "tag and name required" });
  if (!VALID_ASSET_STATUSES.has(status)) return res.status(400).json({ error: "Invalid asset status" });
  try {
    const sql = isPostgres
      ? "INSERT INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?) RETURNING asset_id"
      : "INSERT INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?)";
    const info = await db.prepare(sql).run(tag, name, category || null, status);
    const asset = { asset_id: info.lastInsertRowid || info.rows?.[0]?.asset_id, tag, name, category: category || null, status };
    io.emit("asset:created", asset);
    res.json(asset);
  } catch (e) {
    res.status(409).json({ error: "Tag already exists" });
  }
});

app.post("/api/assets/import", requireAdmin, async (req, res) => {
  const assets = Array.isArray(req.body.assets) ? req.body.assets : null;
  if (!assets) return res.status(400).json({ error: "assets array required" });

  const insertSql = isPostgres
    ? "INSERT INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?) ON CONFLICT (tag) DO NOTHING"
    : "INSERT OR IGNORE INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?)";
  const insert = db.prepare(insertSql);
  let imported = 0;
  let skipped = 0;

  for (const row of assets) {
    const tag = String(row.tag || "").trim();
    const name = String(row.name || "").trim();
    const category = String(row.category || "").trim();
    const status = String(row.status || "available").trim() || "available";

    if (!tag || !name || !VALID_ASSET_STATUSES.has(status)) {
      skipped++;
      continue;
    }

    const info = await insert.run(tag, name, category || null, status);
    if ((info.changes ?? 0) > 0) imported++;
    else skipped++;
  }

  if (imported > 0) io.emit("asset:created", { bulk: true, imported });
  res.json({ imported, skipped });
});

// update asset
app.put("/api/assets/:tag", requireAdmin, async (req, res) => {
  const { name, category, status } = req.body;
  const valid = ['available','in-use','maintenance','missing'];
  if (status && !valid.includes(status))
    return res.status(400).json({ error: "Invalid status" });

  await db.prepare("UPDATE assets SET name=COALESCE(?,name), category=COALESCE(?,category), status=COALESCE(?,status) WHERE tag=?")
    .run(name || null, category || null, status || null, req.params.tag);

  io.emit("asset:updated", { tag: req.params.tag });
  res.json({ ok: true });
});

// delete asset — admin only
app.delete("/api/assets/:tag", requireAdmin, async (req, res) => {
  const asset = await db.prepare("SELECT * FROM assets WHERE tag = ?").get(req.params.tag);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  await db.prepare("DELETE FROM events WHERE asset_id = ?").run(asset.asset_id);
  await db.prepare("DELETE FROM assets WHERE asset_id = ?").run(asset.asset_id);
  io.emit("asset:deleted", { tag: req.params.tag });
  res.json({ ok: true });
});

// ── scan route ─────────────────────────────────────────────
app.post("/api/scan", requireStaff, async (req, res) => {
  const { tag, action, location, notes } = req.body;
  if (!tag || !action || !location) return res.status(400).json({ error: "tag, action, location required" });

  const cfg = loadConfig();
  if (cfg.locations.length && !cfg.locations.includes(location))
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
  io.emit("scan:new", payload);

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
  io.emit("scan:undone", { tag: event.asset_id });
  res.json({ ok: true });
});

// ── audit log viewer — admin only ────────────────
app.get("/api/audit/log", requireAdmin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT
      a.tag, a.name, a.category,
      e.event_id, e.action, e.location, e.scanned_by, e.notes, e.created_at
    FROM events e
    JOIN assets a ON a.asset_id = e.asset_id
    ORDER BY e.created_at DESC
    LIMIT 1000
  `).all();
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
  const escape = v => `"${String(v ?? "").replace(/"/g,'""')}"`;
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
  if (String(newPin).length < 4) return res.status(400).json({ error: "New PIN must be at least 4 digits" });
  if (!/^\d+$/.test(String(newPin))) return res.status(400).json({ error: "New PIN must be numbers only" });

  const cfg = loadConfig();
  const idx = (cfg.users || []).findIndex(u =>
    typeof u === "string" ? u === String(req.session.userId) : String(u.id) === String(req.session.userId)
  );
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  const user = cfg.users[idx];
  if (typeof user === "string" || !user.pin) return res.status(400).json({ error: "No PIN configured for this account" });
  if (String(currentPin) !== String(user.pin)) return res.status(401).json({ error: "Current PIN is incorrect" });

  cfg.users[idx] = { ...user, pin: String(newPin) };
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
  if (pin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits" });
  if (!/^\d+$/.test(pin)) return res.status(400).json({ error: "PIN must be numbers only" });

  const cfg = loadConfig();
  if (findUser(id, cfg)) return res.status(409).json({ error: "User ID already exists" });

  cfg.users.push({ id, name, role: role||"", department: department||"", access: access||"staff", pin });
  saveConfig(cfg);
  res.json({ ok: true });
});

app.put("/api/users/:id", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.users.findIndex(u => (typeof u === "string" ? u : u.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  const existing = cfg.users[idx];
  const updated  = { ...existing, ...req.body };
  if (req.body.pin && req.body.pin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits" });
  cfg.users[idx] = updated;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: "Cannot delete your own account" });
  const cfg = loadConfig();
  cfg.users = cfg.users.filter(u => (typeof u === "string" ? u : u.id) !== req.params.id);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.use("/api", (err, req, res, next) => {
  console.error(`API error ${req.method} ${req.originalUrl}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error" });
});

// ── websocket ──────────────────────────────────────────────
io.on("connection", socket => {
  console.log("WS client connected:", socket.id);
  socket.on("disconnect", () => console.log("WS client disconnected:", socket.id));
});

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
