const q = document.getElementById("q");
const assetsDiv = document.getElementById("assets");

const statTotal = document.getElementById("statTotal");
const statToday = document.getElementById("statToday");
const statLast = document.getElementById("statLast");

async function loadAssets() {
  const res = await fetch("/api/assets");
  return res.json();
}

function parseSqliteDate(s) {
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS"
  if (!s) return null;
  return new Date(s.replace(" ", "T") + "Z");
}

function isSameDay(d1, d2) {
  return d1.getUTCFullYear() === d2.getUTCFullYear() &&
         d1.getUTCMonth() === d2.getUTCMonth() &&
         d1.getUTCDate() === d2.getUTCDate();
}

function card(a) {
  const lastDate = a.last_seen ? parseSqliteDate(a.last_seen) : null;
  const last = lastDate ? lastDate.toLocaleString() : "Never";

  return `
    <div class="card">
      <div class="row">
        <strong>${a.name}</strong>
        <span class="tag">${a.tag}</span>
      </div>
      <div class="muted">Last seen: ${last}</div>
      <div class="muted">Last location: ${a.last_location || "-"}</div>
      <div class="muted">Last scanned by: ${a.last_scanned_by || "-"}</div>

      <div class="assetActions">
        <button class="smallBtn" onclick="viewHistory('${a.tag}')">History</button>
        <button class="smallBtn" onclick="goScan('${a.tag}')">Scan</button>
      </div>
    </div>
  `;
}

window.goScan = (tag) => {
  window.location.href = `/scan.html?tag=${encodeURIComponent(tag)}`;
};

const modal = document.getElementById("modal");
const modalBackdrop = document.getElementById("modalBackdrop");
const closeModalBtn = document.getElementById("closeModal");
const modalTitle = document.getElementById("modalTitle");
const modalSubtitle = document.getElementById("modalSubtitle");
const timeline = document.getElementById("timeline");

function openModal() {
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  modal.classList.add("hidden");
  document.body.style.overflow = "";
}
modalBackdrop?.addEventListener("click", closeModal);
closeModalBtn?.addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
});

function fmtDate(s) {
  const d = parseSqliteDate(s);
  return d ? d.toLocaleString() : s;
}

function badgeFor(action) {
  const nice = (action || "").replaceAll("_", " ");
  return `<span class="badge">${nice}</span>`;
}

window.viewHistory = async (tag) => {
  const res = await fetch(`/api/assets/${encodeURIComponent(tag)}`);
  const data = await res.json();

  modalTitle.textContent = data.asset.name;
  modalSubtitle.textContent = `Tag: ${data.asset.tag}`;

  if (!data.events.length) {
    timeline.innerHTML = `<div class="muted">No events yet.</div>`;
    openModal();
    return;
  }

  timeline.innerHTML = data.events.map((e, idx) => `
    <div class="event">
      <div>
        <div class="dot"></div>
      </div>
      <div class="line">
        <div class="eventCard">
          <div class="eventTop">
            <strong>${e.location}</strong>
            ${badgeFor(e.action)}
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

  openModal();
};


async function render() {
  const assets = await loadAssets();

  // Stats
  statTotal.textContent = assets.length.toString();

  const now = new Date();
  const todayCount = assets.filter(a => {
    const d = parseSqliteDate(a.last_seen);
    return d ? isSameDay(d, new Date(now.toISOString())) : false;
  }).length;

  statToday.textContent = todayCount.toString();

  const newest = assets.find(a => a.last_seen);
  if (newest) {
    const d = parseSqliteDate(newest.last_seen);
    statLast.textContent = d ? d.toLocaleTimeString() : "—";
  } else {
    statLast.textContent = "—";
  }

  // Filter
  const term = (q.value || "").toLowerCase();
  const filtered = assets.filter(a =>
    a.name.toLowerCase().includes(term) || a.tag.toLowerCase().includes(term)
  );

  assetsDiv.innerHTML = filtered.map(card).join("");
}

q.addEventListener("input", render);
render();
