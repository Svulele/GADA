const modal   = document.getElementById('modal');
const dTitle  = document.getElementById('dTitle');
const dTag    = document.getElementById('dTag');
const dClose  = document.getElementById('dClose');
const dBody   = document.getElementById('dBody');
let alertsDismissed = false;

dClose.addEventListener('click', () => modal.close());
modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });

// ── helpers ──────────────────────────────────────
function toDate(s) {
  if (!s) return null;
  return new Date(s.replace(' ','T')+'Z');
}
function timeAgo(s) {
  const d = toDate(s); if (!d) return '—';
  const m = Math.floor((Date.now()-d)/60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}
function fullDate(s) {
  const d = toDate(s);
  return d ? d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
}
function actionLabel(a) {
  return {TRANSFERRED:'Transfer',SCANNED_IN:'Check in',SCANNED_OUT:'Check out'}[a]||(a||'').replace(/_/g,' ');
}
function statusLabel(status) {
  return ({
    available: 'Available',
    'in-use': 'In use',
    maintenance: 'Maintenance',
    missing: 'Missing'
  })[status] || 'Available';
}
function statusBadge(status) {
  const safeStatus = ['available', 'in-use', 'maintenance', 'missing'].includes(status) ? status : 'available';
  return `<span class="statusBadge status-${safeStatus}">${statusLabel(safeStatus)}</span>`;
}
function ensureAlertsBanner() {
  let banner = document.getElementById('alertsBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'alertsBanner';
    banner.className = 'alertsBanner';
    const grid = document.getElementById('facilityGrid');
    grid.parentNode.insertBefore(banner, grid);
  }
  return banner;
}
function renderAlerts(alerts) {
  const banner = ensureAlertsBanner();
  if (!alerts.length) {
    alertsDismissed = false;
    banner.remove();
    return;
  }
  if (alertsDismissed) {
    banner.remove();
    return;
  }

  banner.innerHTML = `
    <div class="alertsHead">
      <div>
        <div class="alertsTitle">Asset alerts</div>
        <div class="alertsSub">${alerts.length} asset${alerts.length === 1 ? '' : 's'} need attention</div>
      </div>
      <button class="alertBannerDismiss" type="button" aria-label="Dismiss alerts">Dismiss</button>
    </div>
    <div class="alertsList">
      ${alerts.map(a => `
        <div class="alertRow" data-tag="${a.tag}">
          <div class="alertAsset">
            <span class="actName">${a.name}</span>
            ${statusBadge(a.status)}
          </div>
          <div class="alertMeta">
            <span>${a.last_seen ? timeAgo(a.last_seen) : 'Never seen'}</span>
            <span>${a.last_location || 'Unknown location'}</span>
          </div>
          <button class="btn btnSm" type="button" data-mark-found="${a.tag}">Mark found</button>
        </div>`).join('')}
    </div>`;

  banner.querySelector('.alertBannerDismiss').onclick = () => {
    alertsDismissed = true;
    banner.remove();
  };
  banner.querySelectorAll('[data-mark-found]').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await fetch(`/api/assets/${encodeURIComponent(btn.dataset.markFound)}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'available' })
        }).then(async r => {
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error(data.error || 'Could not mark asset found');
          }
        });
        alertsDismissed = false;
        await load();
      } catch(e) {
        btn.disabled = false;
        showToast(e.message);
      }
    };
  });
}

// icon per location type
function locationIcon(name) {
  const n = (name||'').toLowerCase();
  if (n.includes('ward'))      return `<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="8" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.4"/><path d="M10 11v3M8.5 12.5h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('recep'))     return `<svg viewBox="0 0 20 20" fill="none"><rect x="2" y="5" width="16" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M6 10h8M6 13h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('triage'))    return `<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 7v3l2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('pharm'))     return `<svg viewBox="0 0 20 20" fill="none"><rect x="5" y="3" width="10" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 8h4M10 6v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('radio'))     return `<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M5 5l2.5 2.5M15 5l-2.5 2.5M10 3v2M10 15v2M3 10h2M15 10h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('lab'))       return `<svg viewBox="0 0 20 20" fill="none"><path d="M7 3v7l-3 5h12l-3-5V3" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 3h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('record'))    return `<svg viewBox="0 0 20 20" fill="none"><rect x="4" y="3" width="12" height="14" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 8h6M7 11h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  if (n.includes('financ'))    return `<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="6" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 9h14" stroke="currentColor" stroke-width="1.4"/><circle cx="7" cy="13" r="1" fill="currentColor"/></svg>`;
  if (n.includes('secur'))     return `<svg viewBox="0 0 20 20" fill="none"><path d="M10 3L4 6v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V6l-6-3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  return `<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2" stroke="currentColor" stroke-width="1.4"/></svg>`;
}

// ── open history modal ────────────────────────────
async function openHistory(tag) {
  dTitle.textContent = 'Movement history'; dTag.textContent = '';
  dBody.innerHTML = `<div class="emptyState">Loading…</div>`;
  modal.showModal();
  try {
    const data = await fetch(`/api/assets/${encodeURIComponent(tag)}`).then(r=>r.json());
    dTitle.textContent = data.asset?.name || 'Movement history';
    dTag.textContent   = data.asset?.tag  || '';
    if (!data.events?.length) {
      dBody.innerHTML = `<div class="emptyState">No events yet.</div>`; return;
    }
    dBody.innerHTML = data.events.map(e=>`
      <div class="evt">
        <div class="evtLine"><div class="evtDot"></div></div>
        <div class="evtC">
          <div class="evtTop">
            <span class="evtLoc">${e.location}</span>
            <span class="evtBadge">${actionLabel(e.action)}</span>
          </div>
          <div class="evtMeta"><span>${fullDate(e.created_at)}</span><span>${e.scanned_by}</span></div>
          ${e.notes?`<div class="evtNote">${e.notes}</div>`:''}
        </div>
      </div>`).join('');
  } catch {
    dBody.innerHTML = `<div class="emptyState">Could not load history.</div>`;
  }
}

// ── render facility grid ──────────────────────────
function renderFacility(assets, locations, alerts = []) {
  const grid = document.getElementById('facilityGrid');
  const overdueLocations = new Set(alerts
    .filter(a => a.last_location && Number(a.hours_since) >= 24)
    .map(a => a.last_location));

  // group assets by last_location
  const byLoc = {};
  locations.forEach(l => byLoc[l] = []);
  assets.forEach(a => {
    const loc = a.last_location;
    if (loc && byLoc[loc] !== undefined) byLoc[loc].push(a);
    // unknown location assets just won't show in a tile
  });

  grid.innerHTML = locations.map(loc => {
    const items = byLoc[loc] || [];
    const count = items.length;
    const preview = items.slice(0, 3);
    const overflow = count - 3;

    return `
      <div class="locCard ${count === 0 ? 'locCardEmpty' : ''} ${overdueLocations.has(loc) ? 'locCardAlert' : ''}">
        <div class="lcHead">
          <div class="lcIcon">${locationIcon(loc)}</div>
          <div class="lcName">${loc}</div>
          <div class="lcCount ${count > 0 ? 'lcCountFull' : ''}">${count}</div>
        </div>
        <div class="lcAssets">
          ${count === 0
            ? `<div class="lcEmpty">No assets</div>`
            : preview.map(a => `
                <div class="lcAssetRow" data-tag="${a.tag}">
                  <div style="min-width:0;">
                    <div class="lcAssetTitle">
                      <span class="lcAssetName">${a.name}</span>
                      ${statusBadge(a.status)}
                    </div>
                    ${a.category ? `<div class="catBadge">${a.category}</div>` : ''}
                  </div>
                  <span class="lcAssetTime">${timeAgo(a.last_seen)}</span>
                </div>`).join('') +
              (overflow > 0 ? `<div class="lcMore">+${overflow} more</div>` : '')
          }
        </div>
      </div>`;
  }).join('');

  // click to view history
  grid.querySelectorAll('.lcAssetRow').forEach(el => {
    el.addEventListener('click', () => openHistory(el.dataset.tag));
  });
}

// ── render activity feed ──────────────────────────
function renderActivity(assets) {
  const feed = document.getElementById('activityFeed');
  const recent = assets
    .filter(a => a.last_seen)
    .sort((a,b) => new Date(b.last_seen.replace(' ','T')+'Z') - new Date(a.last_seen.replace(' ','T')+'Z'))
    .slice(0, 8);

  if (!recent.length) {
    feed.innerHTML = `<div class="emptyState" style="padding:20px;">No activity yet.</div>`;
    return;
  }

  feed.innerHTML = recent.map(a => `
    <div class="actItem" data-tag="${a.tag}">
      <div class="actDot"></div>
      <div class="actContent">
        <span class="actName">${a.name}</span>
        ${statusBadge(a.status)}
        <span class="actArrow">→</span>
        <span class="actLoc">${a.last_location || 'Unknown'}</span>
      </div>
      <div class="actMeta">
        <span class="actTime">${timeAgo(a.last_seen)}</span>
        <span class="actOp">${a.last_scanned_by || '—'}</span>
      </div>
    </div>`).join('');

  feed.querySelectorAll('.actItem').forEach(el => {
    el.addEventListener('click', () => openHistory(el.dataset.tag));
  });
}

// ── main load ─────────────────────────────────────
async function load() {
  try {
    const [assets, cfg] = await Promise.all([
      fetch('/api/assets').then(r=>r.json()),
      fetch('/api/config',{cache:'no-store'}).then(r=>r.json())
    ]);

    const locations = cfg.locations || [];

    // pulse bar stats
    document.getElementById('totalAssets').textContent = assets.length;
    const today = assets.filter(a => {
      const d = toDate(a.last_seen);
      return d && d.toDateString() === new Date().toDateString();
    }).length;
    document.getElementById('totalToday').textContent = today;

    const filled = locations.filter(l => assets.some(a => a.last_location === l)).length;
    document.getElementById('pulseCount').textContent =
      `${filled} of ${locations.length} locations active`;

    renderFacility(assets, locations);
    const alerts = await fetch('/api/alerts', { credentials:'include' }).then(r=>r.json());
    renderAlerts(alerts);
    renderFacility(assets, locations, alerts);
    renderActivity(assets);
  } catch(e) {
    console.error(e);
  }
}

document.getElementById('refreshBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.style.opacity = '0.4';
  await load();
  btn.style.opacity = '1';
});

load();

// auto-refresh every 60s
setInterval(load, 60000);

// ── WebSocket live updates ────────────────────────
try {
  const socket = io();
  socket.on('scan:new', payload => {
    load();
    showToast(`${payload.name} → ${payload.location}`);
  });
  socket.on('asset:created', () => load());
  socket.on('asset:updated', () => load());
  socket.on('asset:deleted', () => load());
} catch(e) { console.warn('WebSocket unavailable', e); }

// ── toast ─────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('gadaToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'gadaToast';
    t.style.cssText = `position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(20px);
      background:var(--text);color:#fff;font-size:13px;font-weight:500;padding:10px 18px;
      border-radius:100px;opacity:0;transition:all 0.2s;z-index:9999;pointer-events:none;
      font-family:var(--font);white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.15);`;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(8px)';
  }, 3000);
}

// ── Cmd+K / Ctrl+K search ────────────────────────
(async () => {
  // build search overlay
  const overlay = document.createElement('div');
  overlay.id = 'kSearch';
  overlay.style.cssText = `display:none;position:fixed;inset:0;z-index:10000;
    background:rgba(20,18,14,0.35);backdrop-filter:blur(4px);
    align-items:flex-start;justify-content:center;padding-top:15vh;`;
  overlay.innerHTML = `
    <div style="width:100%;max-width:520px;background:var(--surface);
      border:1px solid var(--border-2);border-radius:var(--rl);overflow:hidden;
      box-shadow:0 20px 60px rgba(0,0,0,0.18);animation:slideUp 0.16s ease;">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);">
        <svg width="15" height="15" viewBox="0 0 14 14" fill="none" style="color:var(--text-3);flex-shrink:0;">
          <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.3"/>
          <path d="M10 10L13 13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        <input id="kInput" placeholder="Search assets…" autocomplete="off"
          style="flex:1;border:none;background:transparent;font-family:var(--font);
          font-size:15px;color:var(--text);outline:none;" />
        <kbd style="font-size:11px;color:var(--text-3);background:var(--surface-2);
          border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-family:var(--mono);">esc</kbd>
      </div>
      <div id="kResults" style="max-height:340px;overflow-y:auto;"></div>
    </div>`;
  document.body.appendChild(overlay);

  let allAssets = [];
  async function refreshAssets() {
    try { allAssets = await fetch('/api/assets',{credentials:'include'}).then(r=>r.json()); } catch {}
  }
  await refreshAssets();

  function openSearch() {
    overlay.style.display = 'flex';
    document.getElementById('kInput').value = '';
    renderResults('');
    setTimeout(() => document.getElementById('kInput').focus(), 50);
  }
  function closeSearch() { overlay.style.display = 'none'; }

  function renderResults(q) {
    const res = document.getElementById('kResults');
    const term = q.toLowerCase();
    const matches = term
      ? allAssets.filter(a => a.name.toLowerCase().includes(term) || a.tag.toLowerCase().includes(term))
      : allAssets.slice(0, 8);

    if (!matches.length) {
      res.innerHTML = `<div style="text-align:center;padding:32px;font-size:13px;color:var(--text-3);">No assets found</div>`;
      return;
    }
    res.innerHTML = matches.map(a => `
      <div class="kItem" data-tag="${a.tag}" style="display:flex;align-items:center;gap:12px;
        padding:11px 18px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:500;color:var(--text);">${a.name}</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);">${a.tag}</div>
        </div>
        ${a.last_location
          ? `<span style="font-size:11px;font-weight:500;padding:3px 8px;border-radius:5px;
              background:var(--green-bg);border:1px solid var(--green-mid);color:var(--green-text);">${a.last_location}</span>`
          : ''}
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);">${a.last_seen ? timeAgo(a.last_seen) : '—'}</span>
      </div>`).join('');

    res.querySelectorAll('.kItem').forEach(el => {
      el.addEventListener('mouseenter', () => el.style.background = 'var(--green-lite)');
      el.addEventListener('mouseleave', () => el.style.background = '');
      el.addEventListener('click', () => { closeSearch(); openHistory(el.dataset.tag); });
    });
  }

  document.getElementById('kInput').addEventListener('input', e => {
    renderResults(e.target.value);
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSearch(); });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); refreshAssets(); openSearch(); }
    if (e.key === 'Escape') closeSearch();
  });

  // floating search button
  const fab = document.createElement('button');
  fab.title = 'Search assets (⌘K)';
  fab.style.cssText = `position:fixed;bottom:28px;right:28px;z-index:500;
    width:46px;height:46px;border-radius:50%;background:var(--green);border:none;
    display:flex;align-items:center;justify-content:center;cursor:pointer;
    box-shadow:0 4px 16px rgba(61,110,78,0.35);transition:all 0.15s;`;
  fab.innerHTML = `<svg width="18" height="18" viewBox="0 0 14 14" fill="none">
    <circle cx="6" cy="6" r="4" stroke="white" stroke-width="1.5"/>
    <path d="M10 10L13 13" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  fab.addEventListener('click', () => { refreshAssets(); openSearch(); });
  fab.addEventListener('mouseenter', () => fab.style.transform = 'scale(1.08)');
  fab.addEventListener('mouseleave', () => fab.style.transform = 'scale(1)');
  document.body.appendChild(fab);
})();

// ── DARK MODE TOGGLE ──────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('darkToggle');
  if (!btn) return;
  function updateIcon() {
    const dark = document.body.classList.contains('dark');
    btn.innerHTML = dark
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.1 3.1l1 1M11.9 11.9l1 1M11.9 3.1l1-1M3.1 11.9l-1 1"
            stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
         </svg>`
      : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M13 10A6 6 0 0 1 6 3a6 6 0 1 0 7 7z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
         </svg>`;
  }
  updateIcon();
  btn.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('gadaDark', document.body.classList.contains('dark') ? '1' : '0');
    updateIcon();
  });
});
