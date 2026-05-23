"use strict";

const express      = require("express");
const path         = require("path");
const fs           = require("fs");
const http         = require("http");
const session      = require("express-session");
const rateLimit    = require("express-rate-limit");
const { Server }   = require("socket.io");
const db           = require("./db");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: false } });

// ── config ────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  } catch { return { locations: [], users: [] }; }
}

function saveConfig(cfg) {
  fs.writeFileSync(
    path.join(__dirname, "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf8"
  );
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
app.get("/api/assets", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT e.location   FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_location,
      (SELECT e.scanned_by FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_scanned_by,
      (SELECT e.created_at FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_seen
    FROM assets a
    ORDER BY COALESCE(last_seen, a.created_at) DESC
  `).all();
  res.json(rows);
});

app.get("/api/assets/labels", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT tag, name, category
    FROM assets
    ORDER BY name COLLATE NOCASE, tag COLLATE NOCASE
  `).all();
  res.json(rows);
});

app.get("/api/alerts", requireAuth, (req, res) => {
  const rows = db.prepare(`
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
  `).all();
  res.json(rows);
});

app.get("/api/assets/:tag", requireAuth, (req, res) => {
  const asset = db.prepare("SELECT * FROM assets WHERE tag = ?").get(req.params.tag);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  const events = db.prepare("SELECT * FROM events WHERE asset_id = ? ORDER BY created_at DESC").all(asset.asset_id);
  res.json({ asset, events });
});

// create asset — admin only
app.post("/api/assets", requireAdmin, (req, res) => {
  const { tag, name, category } = req.body;
  const status = req.body.status || "available";
  if (!tag || !name) return res.status(400).json({ error: "tag and name required" });
  if (!VALID_ASSET_STATUSES.has(status)) return res.status(400).json({ error: "Invalid asset status" });
  try {
    const info = db.prepare("INSERT INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?)")
      .run(tag, name, category || null, status);
    const asset = { asset_id: info.lastInsertRowid, tag, name, category: category || null, status };
    io.emit("asset:created", asset);
    res.json(asset);
  } catch (e) {
    res.status(409).json({ error: "Tag already exists" });
  }
});

app.post("/api/assets/import", requireAdmin, (req, res) => {
  const assets = Array.isArray(req.body.assets) ? req.body.assets : null;
  if (!assets) return res.status(400).json({ error: "assets array required" });

  const insert = db.prepare("INSERT OR IGNORE INTO assets (tag, name, category, status) VALUES (?, ?, ?, ?)");
  let imported = 0;
  let skipped = 0;

  const runImport = db.transaction(rows => {
    for (const row of rows) {
      const tag = String(row.tag || "").trim();
      const name = String(row.name || "").trim();
      const category = String(row.category || "").trim();
      const status = String(row.status || "available").trim() || "available";

      if (!tag || !name || !VALID_ASSET_STATUSES.has(status)) {
        skipped++;
        continue;
      }

      const info = insert.run(tag, name, category || null, status);
      if (info.changes) imported++;
      else skipped++;
    }
  });

  runImport(assets);
  if (imported > 0) io.emit("asset:created", { bulk: true, imported });
  res.json({ imported, skipped });
});

// update asset
app.put("/api/assets/:tag", requireAdmin, (req, res) => {
  const { name, category, status } = req.body;
  const valid = ['available','in-use','maintenance','missing'];
  if (status && !valid.includes(status))
    return res.status(400).json({ error: "Invalid status" });

  db.prepare("UPDATE assets SET name=COALESCE(?,name), category=COALESCE(?,category), status=COALESCE(?,status) WHERE tag=?")
    .run(name || null, category || null, status || null, req.params.tag);

  io.emit("asset:updated", { tag: req.params.tag });
  res.json({ ok: true });
});

// delete asset — admin only
app.delete("/api/assets/:tag", requireAdmin, (req, res) => {
  const asset = db.prepare("SELECT * FROM assets WHERE tag = ?").get(req.params.tag);
  if (!asset) return res.status(404).json({ error: "Asset not found" });
  db.prepare("DELETE FROM events WHERE asset_id = ?").run(asset.asset_id);
  db.prepare("DELETE FROM assets WHERE asset_id = ?").run(asset.asset_id);
  io.emit("asset:deleted", { tag: req.params.tag });
  res.json({ ok: true });
});

// ── scan route ─────────────────────────────────────────────
app.post("/api/scan", requireStaff, (req, res) => {
  const { tag, action, location, notes } = req.body;
  if (!tag || !action || !location) return res.status(400).json({ error: "tag, action, location required" });

  const cfg = loadConfig();
  if (cfg.locations.length && !cfg.locations.includes(location))
    return res.status(400).json({ error: "Invalid location" });

  let asset = db.prepare("SELECT * FROM assets WHERE tag = ?").get(tag);
  if (!asset) {
    const info = db.prepare("INSERT INTO assets (tag, name) VALUES (?, ?)").run(tag, `Unknown Asset (${tag})`);
    asset = { asset_id: info.lastInsertRowid, tag, name: `Unknown Asset (${tag})`, category: null, status: "available" };
  }

  const eventInfo = db.prepare("INSERT INTO events (asset_id, action, location, scanned_by, notes) VALUES (?, ?, ?, ?, ?)")
    .run(asset.asset_id, action, location, req.session.userId, notes || null);

  const payload = { tag: asset.tag, name: asset.name, action, location, scanned_by: req.session.userId, at: new Date().toISOString() };
  io.emit("scan:new", payload);

  res.json({ ok: true, asset, eventId: eventInfo.lastInsertRowid });
});

// ── undo scan — staff+ ────────────────────────────
app.delete("/api/scan/undo/:eventId", requireStaff, (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (!eventId) return res.status(400).json({ error: "Invalid event ID" });

  const event = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Scan event not found" });

  // only the person who scanned can undo, within 30 seconds
  const age = Date.now() - new Date(event.created_at.replace(" ","T")+"Z").getTime();
  if (age > 30000) return res.status(400).json({ error: "Undo window has expired (30s)" });
  if (event.scanned_by !== req.session.userId) return res.status(403).json({ error: "You can only undo your own scans" });

  db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);

  // emit live update
  io.emit("scan:undone", { tag: event.asset_id });
  res.json({ ok: true });
});

// ── audit log viewer — admin only ────────────────
app.get("/api/audit/log", requireAdmin, (req, res) => {
  const rows = db.prepare(`
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
app.get("/api/audit/export", requireAdmin, (req, res) => {
  const rows = db.prepare(`
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

app.get("/api/users/:id/activity", requireAdmin, (req, res) => {
  const rows = db.prepare(`
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

app.post("/api/users", requireAdmin, (req, res) => {
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

// ── websocket ──────────────────────────────────────────────
io.on("connection", socket => {
  console.log("WS client connected:", socket.id);
  socket.on("disconnect", () => console.log("WS client disconnected:", socket.id));
});

// ── start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🏥 GADA running → http://localhost:${PORT}\n`));
