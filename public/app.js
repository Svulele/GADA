console.log("GADA app.js loaded");
const statTotal = document.getElementById("statTotal");
const statToday = document.getElementById("statToday");
const statLast = document.getElementById("statLast");

const q = document.getElementById("q");
const assetsDiv = document.getElementById("assets");

// Dialog elements
const dialog = document.getElementById("historyDialog");
const dialogTitle = document.getElementById("dialogTitle");
const dialogSubtitle = document.getElementById("dialogSubtitle");
const dialogClose = document.getElementById("dialogClose");
const timeline = document.getElementById("timeline");

dialogClose.addEventListener("click", () => dialog.close());

// allow Esc to close automatically (dialog does this by default)

async function loadAssets() {
  const res = await fetch("/api/assets");
  return res.json();
}

function parseSqliteDate(s) {
  if (!s) return null;
  return new Date(s.replace(" ", "T") + "Z");
}

function fmtDate(s) {
  const d = parseSqliteDate(s);
  return d ? d.toLocaleString() : "—";
}

function badge(action) {
  const nice = (action || "").replaceAll("_", " ");
  return `<span class="badge">${nice}</span>`;
}

function assetCard(a) {
  return `
    <div class="card">
      <div class="row">
        <strong>${a.name}</strong>
        <span class="tag">${a.tag}</span>
      </div>

      <div class="muted">Last seen: ${a.last_seen ? fmtDate(a.last_seen) : "Never"}</div>
      <div class="muted">Location: ${a.last_location || "-"}</div>
      <div class="muted">By: ${a.last_scanned_by || "-"}</div>

      <div class="assetActions">
        <button class="smallBtn js-scan" data-tag="${a.tag}">Scan</button>
        <button class="smallBtn js-history" data-tag="${a.tag}">History</button>
      </div>
    </div>
  `;
}

function goScan(tag) {
  window.location.href = `/scan.html?tag=${encodeURIComponent(tag)}`;
}

async function viewHistory(tag) {
  dialogTitle.textContent = "Asset history";
  dialogSubtitle.textContent = `Tag: ${tag}`;
  timeline.innerHTML = `<div class="muted">Loading history…</div>`;
  dialog.showModal();

  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(tag)}`);
    if (!res.ok) {
      timeline.innerHTML = `<div class="muted">Could not load history (HTTP ${res.status}).</div>`;
      return;
    }

    const data = await res.json();
    dialogTitle.textContent = data.asset?.name || "Asset history";
    dialogSubtitle.textContent = `Tag: ${data.asset?.tag || tag}`;

    if (!data.events || data.events.length === 0) {
      timeline.innerHTML = `<div class="muted">No events yet.</div>`;
      return;
    }

    timeline.innerHTML = data.events.map(e => `
      <div class="event">
        <div><div class="dot"></div></div>
        <div class="line">
          <div class="eventCard">
            <div class="eventTop">
              <strong>${e.location}</strong>
              ${badge(e.action)}
            </div>
            <div class="eventMeta">
              <div>🕒 ${fmtDate(e.created_at)}</div>
              <div>👤 ${e.scanned_by}</div>
              ${e.notes ? `<div>📝 ${e.notes}</div>` : ``}
            </div>
          </div>
        </div>
      </div>
    `).join("");

  } catch (err) {
    console.error(err);
    timeline.innerHTML = `<div class="muted">Network error loading history.</div>`;
  }
}

// One click handler for the whole list
assetsDiv.addEventListener("click", (e) => {
  const historyBtn = e.target.closest(".js-history");
  const scanBtn = e.target.closest(".js-scan");

  if (historyBtn) viewHistory(historyBtn.dataset.tag);
  if (scanBtn) goScan(scanBtn.dataset.tag);
});

async function render() {
  const assets = await loadAssets();
  if (statTotal) statTotal.textContent = assets.length.toString();

const now = new Date();
const todayCount = assets.filter(a => {
  if (!a.last_seen) return false;
  const d = parseSqliteDate(a.last_seen);
  if (!d) return false;
  return d.toDateString() === new Date().toDateString();
}).length;

if (statToday) statToday.textContent = todayCount.toString();

const newest = assets.find(a => a.last_seen);
if (statLast) statLast.textContent = newest?.last_seen ? fmtDate(newest.last_seen) : "—";

  const term = (q.value || "").toLowerCase();
  const filtered = assets.filter(a =>
    a.name.toLowerCase().includes(term) || a.tag.toLowerCase().includes(term)
  );
  assetsDiv.innerHTML = filtered.map(assetCard).join("");
}

q.addEventListener("input", render);
render();