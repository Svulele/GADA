const statTotal = document.getElementById('statTotal');
const statToday = document.getElementById('statToday');
const statLast = document.getElementById('statLast');
const q = document.getElementById('q');
const tbody = document.getElementById('assetsTbody');
const refreshBtn = document.getElementById('refreshBtn');
const dialog = document.getElementById('historyDialog');
const dialogTitle = document.getElementById('dialogTitle');
const dialogTag = document.getElementById('dialogTag');
const dialogClose = document.getElementById('dialogClose');
const timeline = document.getElementById('timeline');

dialogClose.addEventListener('click', () => dialog.close());

function parseSqliteDate(s) {
  if (!s) return null;
  return new Date(s.replace(' ', 'T') + 'Z');
}

function fmtDate(s) {
  const d = parseSqliteDate(s);
  if (!d) return '—';
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDateFull(s) {
  const d = parseSqliteDate(s);
  return d ? d.toLocaleString() : '—';
}

function badge(action) {
  const labels = { TRANSFERRED: 'Transfer', SCANNED_IN: 'Check in', SCANNED_OUT: 'Check out' };
  const nice = labels[action] || (action || '').replace(/_/g, ' ');
  return `<span class="badge">${nice}</span>`;
}

function assetRow(a) {
  return `
    <tr class="assetRow" data-tag="${a.tag}">
      <td>
        <div class="assetName">${a.name}</div>
        <div class="assetTag">${a.tag}</div>
      </td>
      <td>
        ${a.last_location
          ? `<span class="locBadge"><span class="locDot"></span>${a.last_location}</span>`
          : `<span style="color:var(--muted);font-size:0.8rem;">Unknown</span>`}
      </td>
      <td class="timeCell">${a.last_seen ? fmtDate(a.last_seen) : '—'}</td>
      <td class="timeCell">${a.last_scanned_by || '—'}</td>
      <td><span class="chevron">›</span></td>
    </tr>
  `;
}

async function viewHistory(tag) {
  dialogTitle.textContent = 'Asset history';
  dialogTag.textContent = '';
  timeline.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);font-size:0.875rem;">Loading…</div>`;
  dialog.showModal();

  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(tag)}`);
    if (!res.ok) { timeline.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);">Could not load history.</div>`; return; }
    const data = await res.json();
    dialogTitle.textContent = data.asset?.name || 'Asset history';
    dialogTag.textContent = data.asset?.tag || '';

    if (!data.events || data.events.length === 0) {
      timeline.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);font-size:0.875rem;">No events recorded yet.</div>`;
      return;
    }

    timeline.innerHTML = data.events.map(e => `
      <div class="event">
        <div class="eventLine"><div class="eventDot"></div></div>
        <div class="eventContent">
          <div class="eventTop">
            <span class="eventLocation">${e.location}</span>
            ${badge(e.action)}
          </div>
          <div class="eventMeta">
            <span>${fmtDateFull(e.created_at)}</span>
            <span>${e.scanned_by}</span>
          </div>
          ${e.notes ? `<div class="eventNotes">${e.notes}</div>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    timeline.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);">Network error.</div>`;
  }
}

tbody.addEventListener('click', e => {
  const row = e.target.closest('.assetRow');
  if (row) viewHistory(row.dataset.tag);
});

if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    await render().catch(console.error);
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  });
}

async function render() {
  const assets = await fetch('/api/assets').then(r => r.json());

  if (statTotal) statTotal.textContent = assets.length;

  const todayCount = assets.filter(a => {
    if (!a.last_seen) return false;
    const d = parseSqliteDate(a.last_seen);
    return d && d.toDateString() === new Date().toDateString();
  }).length;
  if (statToday) statToday.textContent = todayCount;

  const newest = assets.find(a => a.last_seen);
  if (statLast) {
    if (newest?.last_seen) {
      const d = parseSqliteDate(newest.last_seen);
      statLast.textContent = d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    } else {
      statLast.textContent = '—';
    }
  }

  const term = (q.value || '').toLowerCase();
  const filtered = assets.filter(a =>
    a.name.toLowerCase().includes(term) || a.tag.toLowerCase().includes(term)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="emptyState"><div class="emptyIcon">○</div><strong>No assets found</strong><p>Try a different search term.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(assetRow).join('');
}

q.addEventListener('input', render);
render();