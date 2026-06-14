const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---------- State ----------
let accounts = []; // {id,label,username,uuid,selected,status,connectedAt,error}
let serverAddress = "";

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const listEl = $("#accounts-list");
const emptyEl = $("#empty-state");
const countEl = $("#account-count");
const serverInput = $("#server-input");
const serverHint = $("#server-save-hint");
const selectAllEl = $("#select-all");
const rowTpl = $("#account-row-template");

const overallCpuEl = $("#overall-cpu");
const overallMemEl = $("#overall-mem");
const overallBotsEl = $("#overall-bots");

const authModal = $("#auth-modal");
const authCode = $("#auth-code");
const authLink = $("#auth-link");
const authStatus = $("#auth-status");

const STATUS = {
  disconnected: { text: "Getrennt", cls: "" },
  connecting: { text: "Verbinde …", cls: "connecting" },
  connected: { text: "Verbunden", cls: "connected" },
  error: { text: "Fehler", cls: "error" },
};

// ---------- Rendering ----------
function render() {
  countEl.textContent = accounts.length;
  emptyEl.style.display = accounts.length ? "none" : "flex";
  listEl.style.display = accounts.length ? "flex" : "none";

  // Reconcile rows (rebuild simply — list is small)
  listEl.innerHTML = "";
  for (const acc of accounts) {
    listEl.appendChild(buildRow(acc));
  }
  syncSelectAll();
  updateOverall();
}

// Sub-line under the account name: live metrics while connected, else uuid/error.
function subText(acc) {
  if (acc.status === "connected") {
    return acc.cpu != null
      ? `CPU ${acc.cpu} % · RAM ${acc.mem} MB`
      : "läuft …";
  }
  if (acc.status === "error" && acc.error) return acc.error;
  return acc.uuid || "";
}

// Overall = sum across currently-connected bots.
function updateOverall() {
  let cpu = 0;
  let mem = 0;
  let n = 0;
  for (const a of accounts) {
    if (a.status === "connected" && a.cpu != null) {
      cpu += a.cpu;
      mem += a.mem;
      n++;
    }
  }
  overallCpuEl.innerHTML = `${cpu.toFixed(1)}&nbsp;%`;
  overallMemEl.innerHTML = `${Math.round(mem)}&nbsp;MB`;
  overallBotsEl.textContent = String(n);
}

function buildRow(acc) {
  const node = rowTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = acc.id;
  const status = STATUS[acc.status] || STATUS.disconnected;
  const connected = acc.status === "connected";

  if (connected) node.classList.add("is-connected");
  if (acc.status === "error") node.classList.add("is-error");

  const select = node.querySelector(".account-select");
  select.checked = acc.selected;
  select.addEventListener("change", () => toggleSelected(acc.id, select.checked));

  node.querySelector(".account-name").textContent = acc.username || acc.label;
  node.querySelector(".account-sub").textContent = subText(acc);

  const statusText = node.querySelector(".status-text");
  statusText.className = "status-text " + status.cls;
  statusText.textContent =
    acc.status === "connecting" && acc.attempt
      ? `Reconnect #${acc.attempt}`
      : status.text;

  const uptimeEl = node.querySelector(".uptime");
  uptimeEl.dataset.connectedAt = connected && acc.connectedAt ? acc.connectedAt : "";
  uptimeEl.textContent = connected ? formatUptime(acc.connectedAt) : "";

  const connectBtn = node.querySelector(".btn-connect");
  const busy = acc.status === "connecting" || acc.status === "connected";
  connectBtn.textContent = busy ? "Trennen" : "Verbinden";
  connectBtn.classList.toggle("is-connected", busy);
  connectBtn.addEventListener("click", () =>
    busy ? stopAccount(acc.id) : startAccount(acc.id)
  );

  node
    .querySelector(".btn-remove")
    .addEventListener("click", () => removeAccount(acc.id));

  return node;
}

function formatUptime(connectedAt) {
  if (!connectedAt) return "";
  const secs = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Tick uptimes without full re-render
setInterval(() => {
  for (const el of listEl.querySelectorAll(".uptime")) {
    const at = Number(el.dataset.connectedAt);
    if (at) el.textContent = formatUptime(at);
  }
}, 1000);

function syncSelectAll() {
  const selectable = accounts.length;
  const selected = accounts.filter((a) => a.selected).length;
  selectAllEl.checked = selectable > 0 && selected === selectable;
  selectAllEl.indeterminate = selected > 0 && selected < selectable;
}

// ---------- Actions ----------
async function loadState() {
  const state = await invoke("get_state");
  accounts = (state.accounts || []).map((a) => ({
    id: a.id,
    username: a.username,
    uuid: a.uuid,
    selected: a.selected,
    status: a.status || "disconnected",
    connectedAt: a.connected_at ? a.connected_at * 1000 : null,
    cpu: null,
    mem: null,
    error: "",
  }));
  serverAddress = state.server_address || "";
  serverInput.value = serverAddress;
  render();
}

let serverSaveTimer;
serverInput.addEventListener("input", () => {
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(async () => {
    serverAddress = serverInput.value.trim();
    await invoke("set_server", { address: serverAddress });
    serverHint.textContent = "Gespeichert";
    serverHint.classList.add("show");
    setTimeout(() => serverHint.classList.remove("show"), 1400);
  }, 400);
});

async function toggleSelected(id, selected) {
  const acc = accounts.find((a) => a.id === id);
  if (acc) acc.selected = selected;
  syncSelectAll();
  await invoke("set_selected", { id, selected });
}

selectAllEl.addEventListener("change", async () => {
  const val = selectAllEl.checked;
  for (const a of accounts) a.selected = val;
  render();
  await invoke("set_all_selected", { selected: val });
});

async function startAccount(id) {
  if (!serverAddress) {
    toast("Bitte zuerst eine Server-Adresse eintragen.", true);
    return;
  }
  updateStatus(id, "connecting");
  try {
    await invoke("start_account", { id });
  } catch (e) {
    toast(String(e), true);
    updateStatus(id, "error", { error: String(e) });
  }
}

async function stopAccount(id) {
  try {
    await invoke("stop_account", { id });
  } catch (e) {
    toast(String(e), true);
  }
}

async function removeAccount(id) {
  await invoke("stop_account", { id }).catch(() => {});
  await invoke("remove_account", { id });
  accounts = accounts.filter((a) => a.id !== id);
  render();
}

$("#start-selected-btn").addEventListener("click", async () => {
  if (!serverAddress) {
    toast("Bitte zuerst eine Server-Adresse eintragen.", true);
    return;
  }
  const selected = accounts.filter((a) => a.selected);
  if (!selected.length) {
    toast("Keine Accounts ausgewählt.", true);
    return;
  }
  for (const a of selected) {
    if (a.status !== "connected" && a.status !== "connecting") {
      updateStatus(a.id, "connecting");
    }
  }
  await invoke("start_selected").catch((e) => toast(String(e), true));
});

$("#stop-all-btn").addEventListener("click", async () => {
  await invoke("stop_all").catch((e) => toast(String(e), true));
});

// ---------- Add account (device code flow) ----------
$("#add-account-btn").addEventListener("click", async () => {
  openAuthModal();
  try {
    await invoke("add_account");
  } catch (e) {
    setAuthStatus("error", String(e));
  }
});

function openAuthModal() {
  authCode.textContent = "––––––––";
  authLink.textContent = "Anmeldeseite öffnen";
  authLink.dataset.url = "";
  setAuthStatus("waiting", "Code wird angefordert …");
  authModal.hidden = false;
}

function setAuthStatus(kind, msg) {
  authStatus.className = "modal-status" + (kind === "waiting" ? "" : " " + kind);
  const spinner = kind === "waiting" ? '<span class="spinner"></span> ' : "";
  authStatus.innerHTML = spinner + msg;
}

$("#auth-cancel-btn").addEventListener("click", () => {
  authModal.hidden = true;
  invoke("cancel_add_account").catch(() => {});
});

$("#copy-code-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(authCode.textContent.trim());
});

authLink.addEventListener("click", (e) => {
  e.preventDefault();
  const url = authLink.dataset.url;
  if (url) invoke("open_url", { url }).catch(() => {});
});

// ---------- Status helper ----------
function updateStatus(id, status, extra = {}) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.status = status;
  if ("connectedAt" in extra) acc.connectedAt = extra.connectedAt;
  if ("error" in extra) acc.error = extra.error;
  if ("attempt" in extra) acc.attempt = extra.attempt;
  if (status !== "connected") {
    acc.connectedAt = null;
    acc.cpu = null;
    acc.mem = null;
  }
  if (status !== "connecting") acc.attempt = null;
  render();
}

// ---------- Toasts ----------
function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  $("#toast-container").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- Event wiring ----------
listen("auth:code", (e) => {
  const { user_code, verification_uri } = e.payload;
  authCode.textContent = user_code;
  authLink.dataset.url = verification_uri;
  authLink.textContent = verification_uri;
  setAuthStatus("waiting", "Warte auf Anmeldung …");
  // auto-open the verification page
  invoke("open_url", { url: verification_uri }).catch(() => {});
});

listen("auth:success", (e) => {
  const acc = e.payload;
  const existing = accounts.find((a) => a.uuid === acc.uuid);
  if (existing) {
    existing.id = acc.id;
    existing.username = acc.username;
  } else {
    accounts.push({
      id: acc.id,
      username: acc.username,
      uuid: acc.uuid,
      status: "disconnected",
      connectedAt: null,
      selected: true,
    });
  }
  setAuthStatus("success", `${acc.username} angemeldet`);
  render();
  setTimeout(() => (authModal.hidden = true), 1200);
});

listen("auth:error", (e) => {
  setAuthStatus("error", e.payload);
});

listen("bot:status", (e) => {
  const { id, status, connected_at, error, attempt } = e.payload;
  updateStatus(id, status, {
    connectedAt: connected_at ? connected_at * 1000 : null,
    error: error || "",
    attempt: attempt || null,
  });
});

listen("bot:metrics", (e) => {
  const { id, cpu, mem_mb } = e.payload;
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.cpu = cpu;
  acc.mem = mem_mb;
  if (acc.status === "connected") {
    const row = listEl.querySelector(`.account-row[data-id="${id}"]`);
    if (row) row.querySelector(".account-sub").textContent = subText(acc);
  }
  updateOverall();
});

// ---------- Version, updates & changelog ----------
const versionBadge = $("#version-badge");
const versionText = $("#version-text");
const updateDot = $("#update-dot");
const updateBanner = $("#update-banner");
const updateBannerText = $("#update-banner-text");
const updateInstallBtn = $("#update-install-btn");
const updateDismissBtn = $("#update-dismiss-btn");
const updateProgress = $("#update-progress");
const updateProgressBar = $("#update-progress-bar");

const whatsnewModal = $("#whatsnew-modal");
const whatsnewVersion = $("#whatsnew-version");
const whatsnewBody = $("#whatsnew-body");

let availableVersion = null;
let installing = false;

// Minimal Markdown → HTML for changelog bodies (headings, lists, bold, code).
function renderMarkdown(md) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");

  let html = "";
  let inList = false;
  let li = null;
  const flushLi = () => {
    if (li != null) {
      html += `<li>${inline(li.trim())}</li>`;
      li = null;
    }
  };
  const closeList = () => {
    flushLi();
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^#{1,6}\s+/.test(line)) {
      closeList();
      html += `<h3>${inline(line.replace(/^#{1,6}\s+/, ""))}</h3>`;
    } else if (/^\s*-\s+/.test(line)) {
      flushLi();
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      li = line.replace(/^\s*-\s+/, "");
    } else if (line.trim() === "") {
      flushLi();
    } else if (li != null) {
      li += " " + line.trim(); // continuation of a wrapped list item
    } else {
      closeList();
      html += `<p>${inline(line.trim())}</p>`;
    }
  }
  closeList();
  return html;
}

function openWhatsNew(wn) {
  whatsnewVersion.textContent = "Version " + wn.version;
  whatsnewBody.innerHTML = renderMarkdown(wn.notes);
  whatsnewModal.hidden = false;
}

async function initVersion() {
  try {
    const v = await invoke("get_app_version");
    versionText.textContent = "v" + v;
  } catch {}
}

// After an update the running version differs from the last one the user saw;
// the backend then returns that version's changelog so we can surface it.
async function showWhatsNewIfUpdated() {
  try {
    const wn = await invoke("get_whats_new");
    if (wn) openWhatsNew(wn);
  } catch {}
}

// Silent background check on launch. Stays quiet when offline or in dev.
async function checkForUpdate() {
  try {
    const meta = await invoke("check_for_update");
    if (meta && meta.available) {
      availableVersion = meta.version;
      updateDot.hidden = false;
      updateBannerText.textContent = `Version ${meta.version} verfügbar`;
      updateBanner.hidden = false;
    }
  } catch {
    // No reachable updater endpoint — nothing to show.
  }
}

versionBadge.addEventListener("click", async () => {
  try {
    const wn = await invoke("get_changelog", { version: null });
    if (wn) openWhatsNew(wn);
    else toast("Kein Changelog für diese Version gefunden.");
  } catch {}
});

$("#whatsnew-close-btn").addEventListener("click", () => {
  whatsnewModal.hidden = true;
});
whatsnewModal.addEventListener("click", (e) => {
  if (e.target === whatsnewModal) whatsnewModal.hidden = true;
});

updateDismissBtn.addEventListener("click", () => {
  updateBanner.hidden = true;
});

updateInstallBtn.addEventListener("click", async () => {
  if (installing) return;
  installing = true;
  updateInstallBtn.disabled = true;
  updateDismissBtn.disabled = true;
  updateProgress.hidden = false;
  updateBannerText.textContent = `Lade Version ${availableVersion} …`;
  try {
    await invoke("install_update");
    // On success the app relaunches into the new version — usually unreachable.
  } catch (e) {
    installing = false;
    updateInstallBtn.disabled = false;
    updateDismissBtn.disabled = false;
    updateProgress.hidden = true;
    updateProgressBar.style.width = "0";
    updateBannerText.textContent = "Update fehlgeschlagen";
    toast(String(e), true);
  }
});

listen("update:progress", (e) => {
  const { downloaded, total } = e.payload;
  if (total) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    updateProgressBar.style.width = pct + "%";
    updateBannerText.textContent = `Lade Version ${availableVersion} … ${pct}%`;
  }
});

listen("update:downloaded", () => {
  updateProgressBar.style.width = "100%";
  updateBannerText.textContent = "Installiere … App startet neu";
});

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  loadState();
  initVersion();
  showWhatsNewIfUpdated();
  checkForUpdate();
});
