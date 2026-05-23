# GADA — Developer Guide & Roadmap

This document is for developers continuing work on GADA. It covers the codebase architecture, coding conventions, and a detailed roadmap of planned features with exact file-level instructions for each.

## Current Status

- **Fully built and working**: dashboard, scan workflow, admin panel, audit export, mobile scan page, kiosk dashboard, shift reporting, asset editing, CSV import, user PIN change, real-time updates, dark mode.
- **Planned but not yet started**: deeper asset lifecycle analytics, scheduled maintenance reminders, multi-tenant site support.
- **Known issues / limitations**: plaintext PIN storage in `config.json`, no asset restore audit workflow, SQLite is single-process and not suited for high concurrency.

---

## Architecture Overview

GADA is a monolithic Node.js app. Everything runs in a single process.

```
Request → Express middleware → Route handler → SQLite (via better-sqlite3) → Response
                                     ↓
                               Socket.io broadcast → All connected clients
```

**Key design decisions:**
- `better-sqlite3` is synchronous — no async/await needed for DB calls, which keeps route handlers simple
- All auth state lives in server-side sessions (express-session), not JWTs
- The frontend is vanilla JS — no framework, no build step. Files are served as-is from `public/`
- `config.json` is the source of truth for users and locations — no user table in SQLite

---

## File Responsibilities

### `server.js`
Single file for the entire backend. Sections are clearly commented:
- Config loading/saving (reads/writes `config.json`)
- Middleware (session, rate-limit, static files)
- Auth guards (`requireAuth`, `requireAdmin`, `requireStaff`)
- Route handlers grouped by domain (auth, assets, scan, audit, users)
- WebSocket server (Socket.io)

### `db.js`
Only responsible for opening the SQLite connection and creating tables/indexes. Import it anywhere with `const db = require('./db')`. All queries are written inline in `server.js` using prepared statements.

### `public/app.js`
Handles the dashboard page:
- `load()` — fetches assets + config, renders facility grid and activity feed
- `renderFacility()` — builds location cards from assets grouped by `last_location`
- `renderActivity()` — builds the recent activity strip
- `openHistory()` — fetches and renders asset event history in the dialog modal
- WebSocket listener — calls `load()` on `scan:new`, `asset:created`, `asset:deleted`
- Cmd+K search overlay — built as a self-contained IIFE
- Dark mode toggle — reads/writes `localStorage.gadaDark`

### `public/scan.js`
Handles the scan page:
- `init()` — loads config, populates location dropdown, requires auth
- Submit handler — POSTs to `/api/scan`, shows undo bar on success
- `showUndo()` / `hideUndo()` — manages the 30-second undo countdown bar
- Tag autocomplete — populates `<datalist>` from `/api/assets`
- Recent scans sidebar — session-only array, not persisted
- Inactivity timeout — 30-minute auto-logout

### `public/style.css`
All styles in one file using CSS custom properties (variables). Dark mode is implemented by toggling `body.dark` and redefining the variables. No preprocessor.

---

## Coding Conventions

- **No async/await for DB** — `better-sqlite3` is sync. Use it directly: `db.prepare(...).get()`, `.all()`, `.run()`
- **Prepared statements always** — never interpolate user input into SQL strings
- **Emit after DB write** — always `io.emit(event, payload)` after a successful DB mutation so live clients update
- **Route order matters** — specific routes before parameterised ones (e.g. `/api/assets/labels` before `/api/assets/:tag`)
- **CSS variables for everything** — no hardcoded colours in CSS, always use `var(--name)`
- **No npm for frontend** — load any frontend libraries from cdnjs CDN via `<script>` tags

---

## Database Schema

```sql
CREATE TABLE assets (
  asset_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  tag        TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  category   TEXT,
  status     TEXT NOT NULL DEFAULT 'available',  -- planned, not yet added
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,       -- TRANSFERRED | SCANNED_IN | SCANNED_OUT
  location   TEXT NOT NULL,
  scanned_by TEXT NOT NULL,       -- user ID from config.json
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX idx_events_asset_id ON events(asset_id);
CREATE INDEX idx_events_created_at ON events(created_at);
```

**To add a column to an existing database** (for users who already have data):
```js
// In db.js, after db.exec(createTables):
try {
  db.prepare("ALTER TABLE assets ADD COLUMN status TEXT NOT NULL DEFAULT 'available'").run();
} catch {} // silently skip if column already exists
```

---

## Planned Features — Implementation Guide

### 1. Asset Status Field ✅

**Priority: High** — makes GADA feel medical, not generic.

Valid values: `available` | `in-use` | `maintenance` | `missing`

**`db.js`**
Add `status TEXT NOT NULL DEFAULT 'available'` to the `assets` CREATE TABLE statement. Add the ALTER TABLE migration below the exec call (see pattern above).

**`server.js`**
- `POST /api/assets` — include `status: req.body.status || 'available'` in the INSERT
- Add `PUT /api/assets/:tag` route (requireAdmin):
  ```js
  app.put("/api/assets/:tag", requireAdmin, (req, res) => {
    const { name, category, status } = req.body;
    const valid = ['available','in-use','maintenance','missing'];
    if (status && !valid.includes(status))
      return res.status(400).json({ error: "Invalid status" });
    db.prepare("UPDATE assets SET name=COALESCE(?,name), category=COALESCE(?,category), status=COALESCE(?,status) WHERE tag=?")
      .run(name||null, category||null, status||null, req.params.tag);
    io.emit("asset:updated", { tag: req.params.tag });
    res.json({ ok: true });
  });
  ```

**`public/admin.html`**
- Register modal: add `<select id="aStatus">` with the four options
- Asset rows: add a status badge using a helper:
  ```js
  function statusBadge(s) {
    const map = {
      'available':   { label:'Available',   color:'var(--green-text)',  bg:'var(--green-bg)',  border:'var(--green-mid)' },
      'in-use':      { label:'In use',      color:'#7a5200',           bg:'#fff3e0',          border:'#f5c85a' },
      'maintenance': { label:'Maintenance', color:'#6b3d00',           bg:'#fff0e0',          border:'#f5a855' },
      'missing':     { label:'Missing',     color:'var(--red)',        bg:'var(--red-bg)',    border:'#f0c0c0' },
    };
    const m = map[s] || map['available'];
    return `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;
      color:${m.color};background:${m.bg};border:1px solid ${m.border};">${m.label}</span>`;
  }
  ```

**`public/app.js`**
- In `renderFacility`: add `${a.status && a.status !== 'available' ? statusBadge(a.status) : ''}` below the asset name in `lcAssetRow`
- Copy the same `statusBadge()` function into `app.js`

---

### 2. Overdue / Missing Alerts ✅

**Priority: High** — a facility needs to know when equipment goes dark.

**`server.js`**
Add `GET /api/alerts` (requireAuth):
```js
app.get("/api/alerts", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.tag, a.name, a.category, a.status,
      MAX(e.created_at) as last_seen,
      (SELECT e2.location FROM events e2 WHERE e2.asset_id = a.asset_id ORDER BY e2.created_at DESC LIMIT 1) as last_location
    FROM assets a
    LEFT JOIN events e ON e.asset_id = a.asset_id
    GROUP BY a.asset_id
    HAVING a.status = 'missing'
      OR (last_seen IS NOT NULL AND (julianday('now') - julianday(last_seen)) * 24 > 24)
      OR last_seen IS NULL
  `).all();
  res.json(rows);
});
```

**`public/app.js`**
In `load()`, after `renderFacility()`:
```js
const alerts = await fetch('/api/alerts', {credentials:'include'}).then(r=>r.json());
renderAlerts(alerts);
```

Add `renderAlerts(alerts)` function that:
- If `alerts.length === 0`, removes any existing alert banner and returns
- Otherwise inserts a `<div class="alertsBanner">` before `.facilityGrid`
- Each alert row: asset name, last seen (timeAgo), last location, a dismiss button
- Tags location cards whose assets are overdue with class `locCardWarning`

**`public/style.css`**
```css
.alertsBanner {
  background: var(--amber-bg, #fdf3e0);
  border: 1px solid var(--amber-mid, #e8c87a);
  border-radius: var(--rl);
  padding: 14px 18px;
  margin-bottom: 16px;
}
.alertsBannerTitle {
  font-size: 12px; font-weight: 600; color: var(--amber, #b07020);
  text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px;
}
.alertRow {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 0; border-bottom: 1px solid var(--amber-mid, #e8c87a);
  font-size: 13px;
}
.alertRow:last-child { border-bottom: none; }
.locCardWarning { border-color: var(--amber-mid, #e8c87a) !important; }
```

Add to `:root`: `--amber: #b07020; --amber-bg: #fdf3e0; --amber-mid: #e8c87a;`
Add to `body.dark`: `--amber: #d4952a; --amber-bg: #1f1800; --amber-mid: #4a3800;`

---

### 3. QR Code Label Generator ✅

**Priority: Medium** — best demo feature.

No new npm packages — use cdnjs.

**`public/admin.html`**
- Add a 4th tab button: `<button class="aTab" data-tab="labels">Labels</button>`
- Add tab content div `id="tab-labels"`:
  ```html
  <div class="aTabContent" id="tab-labels" style="display:none;">
    <div class="adminHead">
      <div>
        <div class="adminTitle">Print labels</div>
        <div class="adminSub">Generate QR code labels for all registered assets.</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="generateLabelsBtn">Generate</button>
        <button class="btn btnPrimary" id="printLabelsBtn" style="display:none;">Print</button>
      </div>
    </div>
    <div id="labelsPreview"></div>
  </div>
  ```
- Add before `</body>`:
  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  ```
- Add JS to handle label generation:
  ```js
  document.getElementById('generateLabelsBtn').onclick = async () => {
    const assets = await fetch('/api/assets',{credentials:'include'}).then(r=>r.json());
    const preview = document.getElementById('labelsPreview');
    preview.innerHTML = '<div class="labelsGrid" id="labelsGrid"></div>';
    const grid = document.getElementById('labelsGrid');
    for (const a of assets) {
      const card = document.createElement('div');
      card.className = 'labelCard';
      card.innerHTML = `
        <div class="labelQR" id="qr-${a.tag}"></div>
        <div class="labelName">${a.name}</div>
        <div class="labelTag">${a.tag}</div>
        <div class="labelBrand">GADA</div>`;
      grid.appendChild(card);
      new QRCode(card.querySelector('.labelQR'), {
        text: a.tag, width: 100, height: 100,
        colorDark: '#1a1814', colorLight: '#ffffff'
      });
    }
    document.getElementById('printLabelsBtn').style.display = '';
  };
  document.getElementById('printLabelsBtn').onclick = () => window.print();

  document.querySelector('[data-tab="labels"]').addEventListener('click', () => {});
  ```
- Add CSS:
  ```css
  .labelsGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px; padding: 16px 0;
  }
  .labelCard {
    background: #fff; border: 1px solid #ccc;
    border-radius: 8px; padding: 12px;
    text-align: center; break-inside: avoid;
  }
  .labelQR { display: flex; justify-content: center; margin-bottom: 8px; }
  .labelName { font-size: 11px; font-weight: 600; color: #1a1814; margin-bottom: 2px; }
  .labelTag { font-family: monospace; font-size: 10px; color: #666; margin-bottom: 4px; }
  .labelBrand { font-size: 9px; color: #999; text-transform: uppercase; letter-spacing: 0.1em; }

  @media print {
    header, .adminTabs, .adminHead, nav, .navRight { display: none !important; }
    .labelsGrid { display: grid !important; }
    body { background: white !important; }
  }
  ```

---

### 4. Asset Editing

**Priority: High** — needed before real use.

**`server.js`**
Already described in feature 1 above — add `PUT /api/assets/:tag`.

**`public/admin.html`**
- Store `modal.dataset.editTag = ''` on the Register modal element
- Change asset list row to include Edit button:
  ```js
  `<button class="btn btnSm" onclick="editAsset('${a.tag}')">Edit</button>`
  ```
- Add `editAsset(tag)` function:
  ```js
  async function editAsset(tag) {
    const assets = await fetch('/api/assets',{credentials:'include'}).then(r=>r.json());
    const a = assets.find(x=>x.tag===tag); if(!a) return;
    document.getElementById('aTag').value = a.tag;
    document.getElementById('aTag').disabled = true;
    document.getElementById('aName').value = a.name;
    document.getElementById('aCat').value = a.category||'';
    document.getElementById('aStatus').value = a.status||'available'; // once status is added
    document.getElementById('assetModalErr').textContent = '';
    document.getElementById('assetModal').dataset.editTag = tag;
    document.getElementById('assetModal').showModal();
  }
  ```
- In `assetModalSave` handler, check `modal.dataset.editTag`:
  ```js
  const editTag = modal.dataset.editTag;
  if (editTag) {
    res = await fetch(`/api/assets/${encodeURIComponent(editTag)}`, {
      method:'PUT', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, category, status })
    });
  } else {
    // existing POST logic
  }
  ```
- Reset `dataset.editTag = ''` and re-enable tag input when modal closes

---

### 5. Per-User Activity View ✅

**Priority: Medium**

**`server.js`**
```js
app.get("/api/users/:id/activity", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, a.tag, a.name, a.category
    FROM events e
    JOIN assets a ON a.asset_id = e.asset_id
    WHERE e.scanned_by = ?
    ORDER BY e.created_at DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(rows);
});
```

**`public/admin.html`**
- Add "Activity" button to each user row: `<button class="btn btnSm" onclick="viewUserActivity('${u.id}','${u.name}')">Activity</button>`
- Add `viewUserActivity(id, name)` function that:
  - Fetches `/api/users/${id}/activity`
  - Reuses the existing `<dialog id="userModal">` or opens a new dialog
  - Renders a timeline of events (same style as asset history modal — `.evt`, `.evtDot`, `.evtC`, `.evtTop`, `.evtMeta`)
  - Shows asset name → location, action badge, timestamp

---

### 6. Bulk Asset Import via CSV ✅

**Priority: Medium**

**`server.js`**
```js
app.post("/api/assets/import", requireAdmin, (req, res) => {
  // IMPORTANT: place this route BEFORE /api/assets/:tag
  const { assets } = req.body;
  if (!Array.isArray(assets)) return res.status(400).json({ error: "assets array required" });
  let imported = 0, skipped = 0;
  const stmt = db.prepare("INSERT OR IGNORE INTO assets (tag, name, category) VALUES (?, ?, ?)");
  const insertMany = db.transaction((list) => {
    for (const a of list) {
      if (!a.tag || !a.name) { skipped++; continue; }
      const info = stmt.run(a.tag.trim(), a.name.trim(), a.category?.trim()||null);
      if (info.changes > 0) imported++; else skipped++;
    }
  });
  insertMany(assets);
  res.json({ ok: true, imported, skipped });
});
```

**`public/admin.html`**
- Add "Import CSV" button next to "Register asset" in the Assets tab header
- Add hidden `<input type="file" id="csvImport" accept=".csv">` 
- Button click triggers `csvImport.click()`
- On file change, read with `FileReader`, parse:
  ```js
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h=>h.trim().toLowerCase());
  const assets = lines.slice(1).map(line => {
    const cols = line.split(',');
    return Object.fromEntries(headers.map((h,i) => [h, (cols[i]||'').trim()]));
  });
  ```
- Show preview table (tag, name, category columns) with row count
- Confirm button POSTs to `/api/assets/import`
- Show toast: "Imported 12, skipped 2 duplicates"

Expected CSV format (first row is header):
```
tag,name,category
MED-DF-001,Defibrillator Unit,Medical Equipment
MED-PM-003,Patient Monitor,Medical Equipment
```

---

### 7. User PIN Change ✅

**Priority: Medium**

**`server.js`**
```js
app.post("/api/users/change-pin", requireAuth, (req, res) => {
  // IMPORTANT: place before /api/users/:id routes
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) return res.status(400).json({ error: "Both PINs required" });
  if (newPin.length < 4 || !/^\d+$/.test(newPin))
    return res.status(400).json({ error: "New PIN must be 4+ digits" });

  const cfg  = loadConfig();
  const user = findUser(req.session.userId, cfg);
  if (!user || typeof user === 'string') return res.status(400).json({ error: "Cannot change PIN" });
  if (String(user.pin) !== String(currentPin))
    return res.status(401).json({ error: "Current PIN is incorrect" });

  const idx = cfg.users.findIndex(u => (typeof u === 'string' ? u : u.id) === req.session.userId);
  cfg.users[idx] = { ...cfg.users[idx], pin: newPin };
  saveConfig(cfg);
  res.json({ ok: true });
});
```

**`public/scan.html`**
Below the Sign out button in `.scBottom`, add:
```html
<button class="btn btnSm" id="changePinToggle" 
  style="width:100%;justify-content:center;margin-top:6px;color:var(--text-3);">
  Change PIN
</button>
<div id="changePinForm" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
  <div class="field" style="margin-bottom:10px;">
    <label class="label">Current PIN</label>
    <input class="input" id="cpCurrent" type="password" maxlength="8" placeholder="••••"/>
  </div>
  <div class="field" style="margin-bottom:10px;">
    <label class="label">New PIN</label>
    <input class="input" id="cpNew" type="password" maxlength="8" placeholder="••••"/>
  </div>
  <div class="field" style="margin-bottom:12px;">
    <label class="label">Confirm PIN</label>
    <input class="input" id="cpConfirm" type="password" maxlength="8" placeholder="••••"/>
  </div>
  <button class="btn btnPrimary btnSm" id="cpSave" style="width:100%;justify-content:center;">Save PIN</button>
  <div id="cpMsg" style="font-size:12px;margin-top:8px;"></div>
</div>
```

**`public/scan.js`**
```js
document.getElementById('changePinToggle').onclick = () => {
  const form = document.getElementById('changePinForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
};

document.getElementById('cpSave').onclick = async () => {
  const current = document.getElementById('cpCurrent').value;
  const newPin  = document.getElementById('cpNew').value;
  const confirm = document.getElementById('cpConfirm').value;
  const msg     = document.getElementById('cpMsg');
  if (newPin !== confirm) { msg.style.color='var(--red)'; msg.textContent='PINs do not match.'; return; }
  if (newPin.length < 4)  { msg.style.color='var(--red)'; msg.textContent='PIN must be 4+ digits.'; return; }
  const res = await fetch('/api/users/change-pin', {
    method:'POST', credentials:'include',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ currentPin: current, newPin })
  });
  const d = await res.json().catch(()=>({}));
  if (res.ok) {
    msg.style.color='var(--green-text)'; msg.textContent='PIN updated.';
    document.getElementById('cpCurrent').value = '';
    document.getElementById('cpNew').value = '';
    document.getElementById('cpConfirm').value = '';
  } else {
    msg.style.color='var(--red)'; msg.textContent = d.error||'Could not update PIN.';
  }
};
```

---

### 8. Production `.env` Hard Fail ✅

**`server.js`**
Replace the current `SESSION_SECRET` block:
```js
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET environment variable must be set in production.');
    process.exit(1);
  } else {
    console.warn('⚠️  SESSION_SECRET not set — using insecure default. Never do this in production.');
  }
}
```
Then use `SESSION_SECRET || 'gada-dev-secret-change-me'` in the session config.

---

### 9. Backup Script

**New file: `backup.sh`** in project root:
```bash
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
DEST="$SCRIPT_DIR/backups/gada_$DATE.db"
mkdir -p "$SCRIPT_DIR/backups"
cp "$SCRIPT_DIR/gada.db" "$DEST"
echo "✅ Backed up to $DEST"
# Keep last 30 backups only
ls -t "$SCRIPT_DIR/backups"/gada_*.db | tail -n +31 | xargs rm -f 2>/dev/null || true
echo "🗂  Backup count: $(ls "$SCRIPT_DIR/backups"/gada_*.db 2>/dev/null | wc -l | tr -d ' ')"
```

Run `chmod +x backup.sh` after creating it.

**`package.json`** — add to scripts:
```json
"backup": "bash backup.sh",
"start:prod": "NODE_ENV=production node server.js"
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: 3000) |
| `SESSION_SECRET` | **Yes in production** | Long random string for session signing |
| `NODE_ENV` | No | Set to `production` to enable secure cookies and hard-fail on missing secret |

---

## Testing Checklist (before demo or deployment)

- [ ] All default PINs changed in `config.json`
- [ ] `SESSION_SECRET` set in `.env`
- [ ] `NODE_ENV=production` in `.env`
- [ ] Running behind nginx with HTTPS
- [ ] `gada.db` not in git history
- [ ] `config.json` not in git history
- [ ] Backup cron job active
- [ ] Rate limiting tested (10 failed logins → blocked for 15 min)
- [ ] Inactivity timeout tested (30 min idle → redirect to login)
- [ ] Viewer account cannot scan (submit button disabled)
- [ ] Admin CSV export works and contains all events
- [ ] WebSocket live update works across two browser tabs
- [ ] Mobile scan page works on phone browser
- [ ] Kiosk page displays correctly on large screen
- [ ] Shift report generates correctly for today
- [ ] Transfer from dashboard pre-fills the scan page correctly

