let CONFIG = {};

function $(id) { return document.getElementById(id); }

async function loadConfig() {
  try { CONFIG = await fetch('/api/config').then(r=>r.json()); }
  catch { CONFIG = { locations:[], users:[] }; }
}

function populateLocations() {
  const sel = $('location');
  sel.innerHTML = (CONFIG.locations||[])
    .map(l=>`<option value="${l}">${l}</option>`)
    .join('');
}

async function requireAuth() {
  try {
    const me = await fetch('/api/me',{credentials:'include'}).then(r=>r.json());
    if (!me.user) { window.location.href='/login.html'; return null; }
    // viewers cannot scan
    if (me.user.access === 'viewer') {
      $('submit').disabled = true;
      $('submit').title = 'Viewer accounts cannot record scans';
      showMsg('Your account is view-only. Contact an admin to change your access level.','err');
    }
    return me.user;
  } catch { window.location.href='/login.html'; }
}

function setUser(user) {
  const name     = user.name || user.id || '?';
  const initials = name.split(/[\s\-_]/).map(p=>p[0]).join('').toUpperCase().slice(0,2);

  // header chip
  const av = document.getElementById('userAvatar');
  const un = document.getElementById('userName');
  const ur = document.getElementById('userRole');
  if (av) av.textContent = initials;
  if (un) un.textContent = name;
  if (ur) ur.textContent = user.role || '';

  // sidebar card
  const s = $('currentUserStatus');
  const m = $('currentUserMeta');
  if (s) s.textContent = name;
  if (m) m.textContent = [user.role, user.department].filter(Boolean).join(' · ');

  // show admin link if admin
  if (user.access === 'admin') {
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.style.display = 'inline-flex';
  }
}

function showMsg(text, type) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'notice ' + (type==='err' ? 'err' : 'ok');
  if (text && type !== 'err') setTimeout(()=>{ el.className='notice'; }, 5000);
}

function showPinMsg(text, type) {
  const el = $('pinMsg');
  if (!el) return;
  el.textContent = text;
  el.className = 'notice ' + (type==='err' ? 'err' : 'ok');
}

$('logoutBtn').onclick = async () => {
  await fetch('/api/logout',{method:'POST',credentials:'include'}).catch(()=>{});
  window.location.href = '/login.html';
};

$('togglePinForm').onclick = () => {
  const form = $('pinForm');
  const isOpen = form.style.display !== 'none';
  form.style.display = isOpen ? 'none' : 'block';
  $('togglePinForm').textContent = isOpen ? 'Change PIN' : 'Cancel PIN change';
  if (!isOpen) $('currentPin').focus();
};

$('savePin').onclick = async () => {
  const currentPin = $('currentPin').value.trim();
  const newPin = $('newPin').value.trim();
  const confirmPin = $('confirmPin').value.trim();

  if (!currentPin || !newPin || !confirmPin) {
    showPinMsg('Fill in all PIN fields.', 'err');
    return;
  }
  if (newPin !== confirmPin) {
    showPinMsg('New PIN and confirmation do not match.', 'err');
    $('confirmPin').focus();
    return;
  }
  if (newPin.length < 4 || !/^\d+$/.test(newPin)) {
    showPinMsg('New PIN must be at least 4 digits and numbers only.', 'err');
    $('newPin').focus();
    return;
  }

  const btn = $('savePin');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/users/change-pin', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPin, newPin })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showPinMsg(data.error || 'Current PIN is incorrect.', 'err');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Could not change PIN.');

    ['currentPin','newPin','confirmPin'].forEach(id => $(id).value = '');
    showPinMsg('PIN changed.', 'ok');
  } catch(err) {
    showPinMsg(err.message || 'Could not change PIN.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save PIN';
  }
};

$('clear').onclick = () => {
  $('tag').value = '';
  $('notes').value = '';
  $('msg').className = 'notice';
  $('tag').focus();
};

$('submit').onclick = async () => {
  const tag = $('tag').value.trim();
  if (!tag) { showMsg('Please enter an asset tag.','err'); $('tag').focus(); return; }

  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Recording…';

  try {
    const res = await fetch('/api/scan',{
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        tag,
        action:   $('action').value,
        location: $('location').value,
        notes:    ($('notes').value||'').trim()
      })
    });
    const data = await res.json().catch(()=>({}));
    if (res.status === 401) { window.location.href='/login.html'; return; }
    if (!res.ok) throw new Error(data.error||'Scan failed.');
    showMsg('Scan recorded.','ok');
    $('tag').value = '';
    $('notes').value = '';
    $('tag').focus();
  } catch(err) {
    showMsg(err.message||'Could not record scan.','err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Record scan';
  }
};

$('tag').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('submit').click();
});

async function init() {
  await loadConfig();
  populateLocations();
  const user = await requireAuth();
  if (user) setUser(user);
  $('action').value = 'TRANSFERRED';
  $('tag').focus();
}

document.addEventListener('DOMContentLoaded', init);

// ── DARK MODE ─────────────────────────────────────
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

// ── UNDO LAST SCAN ────────────────────────────────
let lastEventId  = null;
let undoTimer    = null;
let undoProgress = null;
const UNDO_MS    = 30000;

function buildUndoBar() {
  if (document.getElementById('undoBar')) return;
  const bar = document.createElement('div');
  bar.id = 'undoBar';
  bar.className = 'undoBar';
  bar.innerHTML = `
    <span id="undoMsg">Scan recorded</span>
    <button id="undoBtn">Undo</button>
    <div class="undoProgress" id="undoProgress"></div>`;
  document.body.appendChild(bar);

  document.getElementById('undoBtn').onclick = async () => {
    if (!lastEventId) return;
    try {
      const res = await fetch(`/api/scan/undo/${lastEventId}`, {
        method: 'DELETE', credentials: 'include'
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        hideUndo();
        showMsg('Scan undone.', 'ok');
        lastEventId = null;
      } else {
        hideUndo();
        showMsg(d.error || 'Could not undo scan.', 'err');
      }
    } catch {
      showMsg('Network error.', 'err');
    }
  };
}

function showUndo(eventId, assetName) {
  buildUndoBar();
  lastEventId = eventId;
  clearTimeout(undoTimer);
  const bar  = document.getElementById('undoBar');
  const prog = document.getElementById('undoProgress');
  document.getElementById('undoMsg').textContent = `"${assetName}" scanned`;
  bar.classList.add('show');
  // shrinking progress bar
  prog.style.transition = 'none';
  prog.style.width = '100%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      prog.style.transition = `width ${UNDO_MS}ms linear`;
      prog.style.width = '0%';
    });
  });
  undoTimer = setTimeout(hideUndo, UNDO_MS);
}

function hideUndo() {
  const bar = document.getElementById('undoBar');
  if (bar) bar.classList.remove('show');
  clearTimeout(undoTimer);
}

// patch submit to capture event id and show undo
const _origSubmit = $('submit').onclick;
$('submit').onclick = async () => {
  const tag = $('tag').value.trim();
  if (!tag) { showMsg('Please enter an asset tag.', 'err'); $('tag').focus(); return; }

  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Recording…';

  try {
    const res = await fetch('/api/scan', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag,
        action:   $('action').value,
        location: $('location').value,
        notes:    ($('notes').value || '').trim()
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (!res.ok) throw new Error(data.error || 'Scan failed.');

    // show undo bar
    const assetName = data.asset?.name || tag;
    if (data.eventId) showUndo(data.eventId, assetName);

    showMsg('Scan recorded.', 'ok');
    $('tag').value = '';
    $('notes').value = '';
    $('tag').focus();
  } catch(err) {
    showMsg(err.message || 'Could not record scan.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Record scan';
  }
};

// ── TAG AUTOCOMPLETE ──────────────────────────────
async function loadTagSuggestions() {
  try {
    const assets = await fetch('/api/assets', {credentials:'include'}).then(r=>r.json());
    const dl = document.getElementById('tagSuggestions');
    if (!dl) return;
    dl.innerHTML = assets.map(a =>
      `<option value="${a.tag}" label="${a.name} — ${a.tag}">`
    ).join('');
  } catch {}
}

// ── RECENT SCANS THIS SESSION ─────────────────────
const sessionScans = [];

function addRecentScan(tag, name, location, action) {
  sessionScans.unshift({ tag, name, location, action, at: new Date() });
  if (sessionScans.length > 10) sessionScans.pop();
  renderRecentScans();
}

function renderRecentScans() {
  const el = document.getElementById('recentScans');
  if (!el) return;
  if (!sessionScans.length) {
    el.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text-3);text-align:center;">No scans yet</div>';
    return;
  }
  const actionLabel = a => ({TRANSFERRED:'Transfer',SCANNED_IN:'Check in',SCANNED_OUT:'Check out'}[a]||a);
  el.innerHTML = sessionScans.map((s,i) => `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);
      ${i===0?'background:var(--green-lite);':''}">
      <div style="font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${s.name}
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
        <span style="font-size:10px;font-weight:500;color:var(--green-text);">${s.location}</span>
        <span style="font-size:10px;color:var(--text-3);">·</span>
        <span style="font-size:10px;color:var(--text-3);">${actionLabel(s.action)}</span>
      </div>
    </div>`).join('');
}

// Patch the submit to also update recent scans
// We need to intercept after the fetch succeeds
const _scanInit = init;
init = async function() {
  await _scanInit();
  await loadTagSuggestions();

  // wrap submit to capture success and update recent list
  const submitBtn = $('submit');
  const _onclick = submitBtn.onclick;
  submitBtn.onclick = async function() {
    const tag      = $('tag').value.trim();
    const location = $('location').value;
    const action   = $('action').value;

    // call the original (which now includes undo logic)
    await _onclick.call(this);

    // if scan succeeded (msg shows ok), add to recent
    const msg = $('msg');
    if (msg && msg.classList.contains('ok')) {
      try {
        const assets = await fetch('/api/assets',{credentials:'include'}).then(r=>r.json());
        const asset  = assets.find(a=>a.tag===tag);
        addRecentScan(tag, asset?.name||tag, location, action);
        await loadTagSuggestions(); // refresh autocomplete
      } catch {}
    }
  };
};

// ── INACTIVITY TIMEOUT (30 min) ───────────────────
(function() {
  const TIMEOUT_MS = 30 * 60 * 1000;
  let timer;
  function reset() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await fetch('/api/logout', {method:'POST', credentials:'include'}).catch(()=>{});
      window.location.href = '/login.html?reason=timeout';
    }, TIMEOUT_MS);
  }
  ['click','keydown','mousemove','touchstart'].forEach(e =>
    document.addEventListener(e, reset, {passive:true})
  );
  reset();
})();
