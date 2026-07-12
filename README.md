# GADA

GADA is a secure, real-time chain-of-custody system for tracking physical assets across a facility. Built for medical environments where accountability, auditability, and access control matter.

---

## Features

- **Facility dashboard** — live grid showing which assets are in which location right now
- **Scan workflow** — log asset movements by tag/barcode with location and action
- **Real-time updates** — WebSocket broadcasts; every screen updates instantly when a scan happens
- **Three-tier roles** — Admin / Staff / Viewer with enforced server-side permissions
- **PIN login** — per-user PIN with rate limiting (10 attempts per 15 min per IP)
- **Session security** — 8-hour session expiry, 30-minute inactivity auto-logout
- **Admin panel** — manage users, register/delete assets, view and export audit log
- **Audit log** — every movement recorded with timestamp, operator, location, action
- **CSV export** — full audit history downloadable (admin only)
- **Undo scan** — 30-second undo window after any scan
- **Cmd+K search** — floating asset search from anywhere in the app
- **Dark mode** — persists across sessions via localStorage
- **Tag autocomplete** — scan page suggests known asset tags as you type
- **Category system** — assets grouped by category, shown on location cards
- **Mobile scan page** — `public/mobile.html`: mobile-optimised scan page with camera barcode support
- **Kiosk dashboard** — `public/kiosk.html`: read-only wall screen dashboard for TV/tablet display
- **Shift reports** — shift-based reporting in the admin panel (CSV and on-screen)
- **Asset status tracking** — available / in-use / maintenance / missing across the app
- **Overdue and missing asset alerts** — dashboard warnings for assets that need attention
- **QR code label generator** — admin-only printable asset tag creation
- **Asset editing** — rename assets and change category/status from admin view
- **Bulk CSV import** — admin-only bulk asset upload from CSV
- **User PIN change** — change your own PIN directly from the scan page
- **Dashboard click-to-transfer** — click assets to view history or jump straight to scan
- **Scan page asset search** — type an asset name or tag to find and pre-fill the tag

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js v5 |
| Database | SQLite via `better-sqlite3` |
| Real-time | Socket.io v4 |
| Auth | `express-session` + PIN verification |
| Rate limiting | `express-rate-limit` |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Dev server | Nodemon |

---

## Project Structure

```
GADA/
├── server.js          # Express app, all API routes, WebSocket server
├── db.js              # SQLite setup, table definitions, indexes
├── config.json        # Users (with PINs) and locations — NEVER commit this
├── gada.db            # SQLite database file — NEVER commit this
├── package.json
├── .env               # Environment variables — NEVER commit this
├── .gitignore
├── backup.sh          # Database backup script
├── CONTRIBUTING.md    # Developer guide
└── public/
    ├── index.html     # Dashboard (facility grid + activity feed)
    ├── scan.html      # Scan workflow page
    ├── mobile.html    # Mobile scan page optimised for one-handed use
    ├── login.html     # PIN login (two-step: select user → enter PIN)
    ├── admin.html     # Admin panel (users, assets, audit log, labels, shift reports)
    ├── kiosk.html     # Read-only wall screen dashboard
    ├── app.js         # Dashboard JS (facility grid, WebSocket, Cmd+K, dark mode)
    ├── scan.js        # Scan page JS (auth, submit, undo, autocomplete)
    └── style.css      # All styles (light + dark mode via CSS variables)
```

---

## Getting Started

### 1. Install dependencies

```bash
cd GADA
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
SESSION_SECRET=replace-this-with-a-long-random-string
NODE_ENV=development
```

Generate a strong secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Configure users and locations

Edit `config.json` in the project root (not in `public/`):

```json
{
  "locations": ["Reception", "Ward A", "Ward B", "Pharmacy"],
  "users": [
    {
      "id": "admin",
      "name": "Admin",
      "role": "Admin",
      "department": "Admin",
      "access": "admin",
      "pin": "0000"
    },
    {
      "id": "nurse-1",
      "name": "Nurse One",
      "role": "Nurse",
      "department": "Ward A",
      "access": "staff",
      "pin": "1234"
    }
  ]
}
```

**Access levels:**
- `admin` — full access: manage users, assets, export audit log
- `staff` — can scan assets and view dashboard
- `viewer` — read-only dashboard, cannot scan

### 4. Run

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

Open `http://localhost:3000`

---

## Default Accounts (change PINs immediately)

| Name | ID | PIN | Access |
|---|---|---|---|
| Sbulele | sbu | 1234 | admin |
| Admin | admin | 0000 | admin |
| Security-1 | sec-1 | 1111 | staff |
| Nurse-1 | nurse-1 | 2222 | staff |
| Doctor-1 | doc-1 | 3333 | staff |

> ⚠️ Change all PINs before any real deployment.

---

## API Reference

All routes require authentication unless noted. Admin-only routes return `403` if the session user is not an admin.

### Auth
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/me` | Public | Returns current session user or `null` |
| `POST` | `/api/login` | Public | `{ userId, pin }` → creates session |
| `POST` | `/api/logout` | Public | Destroys session |
| `GET` | `/api/config` | Public | Returns locations and user names (no PINs) |

### Assets
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/assets` | Auth | All assets with last location and time |
| `GET` | `/api/assets/:tag` | Auth | Single asset + full event history |
| `PUT` | `/api/assets/:tag` | Admin | Update asset name, category, or status |
| `POST` | `/api/assets/import` | Admin | Bulk import assets from CSV |
| `POST` | `/api/assets` | Admin | Register new asset `{ tag, name, category }` |
| `DELETE` | `/api/assets/:tag` | Admin | Delete asset and all its history |

### Scanning
| Method | Route | Access | Description |
|---|---|---|---|
| `POST` | `/api/scan` | Staff | `{ tag, action, location, notes }` → logs movement |
| `DELETE` | `/api/scan/undo/:eventId` | Staff | Undo a scan within 30 seconds |

### Reports
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/reports/shift` | Admin | Shift-based report (query: `from`, `to`, `operator`) — CSV/JSON export |
| `GET` | `/api/kiosk` | Public | Read-only kiosk payload: `{ locations, assets }` (no PINs or personal data) |
| `GET` | `/api/alerts` | Auth | Overdue and missing assets for dashboard alerting |

### Audit
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/audit/log` | Admin | Last 1000 events as JSON |
| `GET` | `/api/audit/export` | Admin | Full history as CSV download |

### Users
| Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/users` | Admin | All users (no PINs) |
| `GET` | `/api/users/:id/activity` | Admin | Activity log for a specific user |
| `POST` | `/api/users/change-pin` | Auth | User changes their own PIN |
| `POST` | `/api/users` | Admin | Create user `{ id, name, role, department, access, pin }` |
| `PUT` | `/api/users/:id` | Admin | Update user fields |
| `DELETE` | `/api/users/:id` | Admin | Remove user |

---

## Security Notes

- `config.json` lives at the project root, not in `public/` — it is never web-accessible
- PINs are stored in `config.json` as plaintext — treat this file like a password file
- Sessions use `httpOnly`, `sameSite: lax` cookies; `secure: true` is enabled in production
- Login is rate-limited to 10 attempts per 15 minutes per IP
- Sessions expire after 8 hours; inactivity timeout is 30 minutes on the scan page
- In production, run behind a reverse proxy (nginx) with HTTPS/TLS

---

## Database Backup

```bash
# Manual backup
npm run backup

# Automatic nightly backup (add to crontab)
0 2 * * * /path/to/GADA/backup.sh
```

Backups are saved to `./backups/` and the last 30 are kept automatically.

---

## Production Deployment (nginx + SSL)

Minimal nginx config:

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

> The `Upgrade` and `Connection` headers are required for Socket.io WebSockets to work through nginx.

---

## Roadmap / Known Missing Features

See `CONTRIBUTING.md` for a full breakdown of planned features and where to implement each one.
