const q = document.getElementById("q");
const assetsDiv = document.getElementById("assets");

async function loadAssets() {
  const res = await fetch("/api/assets");
  return res.json();
}

function card(a) {
  const last = a.last_seen ? new Date(a.last_seen + "Z").toLocaleString() : "Never";
  return `
    <div class="card">
      <div class="row">
        <strong>${a.name}</strong>
        <span class="tag">${a.tag}</span>
      </div>
      <div class="muted">Last seen: ${last}</div>
      <div class="muted">Last location: ${a.last_location || "-"}</div>
      <div class="muted">Last scanned by: ${a.last_scanned_by || "-"}</div>
      <button onclick="viewHistory('${a.tag}')">View history</button>
    </div>
  `;
}

window.viewHistory = async (tag) => {
  const res = await fetch(`/api/assets/${encodeURIComponent(tag)}`);
  const data = await res.json();
  alert(
    `${data.asset.name}\n\n` +
    data.events.map(e => `${e.created_at} | ${e.action} | ${e.location} | ${e.scanned_by}`).join("\n")
  );
};

async function render() {
  const assets = await loadAssets();
  const term = (q.value || "").toLowerCase();
  const filtered = assets.filter(a =>
    a.name.toLowerCase().includes(term) || a.tag.toLowerCase().includes(term)
  );
  assetsDiv.innerHTML = filtered.map(card).join("");
}

q.addEventListener("input", render);
render();
