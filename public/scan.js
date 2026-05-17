console.log("GADA scan.js loaded");

let CONFIG = {};

function $(id) { return document.getElementById(id); }

async function loadConfig() {
  try {
    const res = await fetch("/config.json");
    CONFIG = await res.json();
  } catch (err) {
    console.error("Failed to load config:", err);
    CONFIG = { locations: [], users: [] };
  }
}

function populateDropdowns() {
  const locSelect = $("location");
  locSelect.innerHTML = (CONFIG.locations || [])
    .map(l => `<option value="${l}">${l}</option>`)
    .join("");
}

async function requireAuth() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    const me = await res.json();
    if (!me.user) {
      window.location.href = "/login.html";
      return null;
    }
    return me.user;
  } catch (err) {
    console.error(err);
    window.location.href = "/login.html";
  }
}

async function init() {
  await loadConfig();
  populateDropdowns();
  const user = await requireAuth();
  if (!user) return;
  setCurrentUser(user);
  $("action").value = "TRANSFERRED";
  $("tag").focus();
}

function setCurrentUser(user) {
  const status = $("currentUserStatus");
  if (!status) return;
  status.textContent = user.name || user.id;
  const meta = document.getElementById("currentUserMeta");
  if (meta && user.role) meta.textContent = user.role + (user.department ? " - " + user.department : "");
}

// Handle logout
$("logoutBtn").onclick = async () => {
  try {
    await fetch("/api/logout", {
      method: "POST",
      credentials: "include"
    });
    window.location.href = "/login.html";
  } catch (err) {
    console.error("Logout failed", err);
    showMessage("Logout failed.", "error");
  }
};

function showMessage(text, type = "default") {
  const bar = $("msg");
  bar.textContent = text;
  bar.className = type === "error" ? "messageBar error" : "messageBar success";
  if (text) {
    bar.style.display = "block";
    setTimeout(() => bar.style.display = "none", 5000);
  }
}

$("clear").onclick = () => {
  $("tag").value = "";
  $("notes").value = "";
  showMessage("");
  $("tag").focus();
};

$("submit").onclick = async () => {
  const tag = $("tag").value.trim();
  if (!tag) {
    showMessage("Please enter an asset tag.", "error");
    $("tag").focus();
    return;
  }

  const payload = {
    tag,
    action: $("action").value,
    location: $("location").value,
    notes: ($("notes")?.value || "").trim()
  };

  const btn = $("submit");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btnIcon">⏳</span> Recording...';

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || "Scan failed.");
    }

    showMessage("✅ Scan recorded successfully!");
    $("tag").value = "";
    $("notes").value = "";
    $("tag").focus();
  } catch (err) {
    showMessage("❌ " + (err.message || "Could not record scan."), "error");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
};

document.addEventListener("DOMContentLoaded", init);
