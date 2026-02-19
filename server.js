const express = require("express");
const path = require("path");
const db = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Helper: get asset by tag
function getAssetByTag(tag) {
  return db.prepare("SELECT * FROM assets WHERE tag = ?").get(tag);
}

// Create asset (for admin/testing)
app.post("/api/assets", (req, res) => {
  const { tag, name, category } = req.body;
  if (!tag || !name) return res.status(400).json({ error: "tag and name are required" });

  try {
    const stmt = db.prepare("INSERT INTO assets (tag, name, category) VALUES (?, ?, ?)");
    const info = stmt.run(tag, name, category || null);
    res.json({ asset_id: info.lastInsertRowid, tag, name, category: category || null });
  } catch (e) {
    res.status(409).json({ error: "Asset tag already exists", details: e.message });
  }
});

// List assets with last seen info
app.get("/api/assets", (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT e.location FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_location,
      (SELECT e.scanned_by FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_scanned_by,
      (SELECT e.created_at FROM events e WHERE e.asset_id = a.asset_id ORDER BY e.created_at DESC LIMIT 1) AS last_seen
    FROM assets a
    ORDER BY COALESCE(last_seen, a.created_at) DESC
  `).all();

  res.json(rows);
});

// Get asset + full history by tag
app.get("/api/assets/:tag", (req, res) => {
  const { tag } = req.params;
  const asset = getAssetByTag(tag);
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  const events = db.prepare(`
    SELECT * FROM events
    WHERE asset_id = ?
    ORDER BY created_at DESC
  `).all(asset.asset_id);

  res.json({ asset, events });
});

// Log scan event by tag
app.post("/api/scan", (req, res) => {
  const { tag, action, location, scanned_by, notes } = req.body;
  if (!tag || !action || !location || !scanned_by) {
    return res.status(400).json({ error: "tag, action, location, scanned_by required" });
  }

  let asset = getAssetByTag(tag);

  // Auto-create unknown asset (useful for MVP)
  if (!asset) {
    const name = `Unknown Asset (${tag})`;
    const info = db.prepare("INSERT INTO assets (tag, name) VALUES (?, ?)").run(tag, name);
    asset = { asset_id: info.lastInsertRowid, tag, name, category: null };
  }

  db.prepare(`
    INSERT INTO events (asset_id, action, location, scanned_by, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(asset.asset_id, action, location, scanned_by, notes || null);

  res.json({ ok: true, asset });
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`GADA running on http://localhost:${PORT}`));
