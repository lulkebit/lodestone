import * as i18n from "./i18n.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const t = i18n.t;

// ---------- State ----------
let accounts = []; // {id,label,username,uuid,selected,status,connectedAt,error}
let serverAddress = "";
let reauthId = null; // account id currently re-authenticating (expired session)
let showAvatars = true; // load skin-head avatars (cached locally) — see settings
const avatarCache = new Map(); // uuid -> data: URL, so re-renders don't re-fetch

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
const authTitle = authModal.querySelector("h2");
const authDesc = authModal.querySelector(".modal-desc");

// CSS class per status; the label text comes from the active language.
const STATUS_CLS = {
  disconnected: "",
  connecting: "connecting",
  connected: "connected",
  error: "error",
};
const statusLabel = (s) => t(`status.${s}`);

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

// Sub-line under the account name: running state while connected, else uuid/error.
function subText(acc) {
  if (acc.status === "connected") {
    return t("account.running");
  }
  if (acc.status === "error") {
    if (acc.errorKey) return t(acc.errorKey);
    if (acc.error) return acc.error;
  }
  return acc.uuid || "";
}

// Online bot count. CPU/RAM are whole-process totals pushed via `app:metrics`,
// since the bots now share one process and can't be measured individually.
function updateOverall() {
  let n = 0;
  for (const a of accounts) if (a.status === "connected") n++;
  overallBotsEl.textContent = String(n);
}

function buildRow(acc) {
  const node = rowTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = acc.id;
  const cls = STATUS_CLS[acc.status] ?? "";
  const connected = acc.status === "connected";

  if (connected) node.classList.add("is-connected");
  if (acc.status === "error") node.classList.add("is-error");

  const select = node.querySelector(".account-select");
  select.checked = acc.selected;
  select.addEventListener("change", () => toggleSelected(acc.id, select.checked));

  // Minecraft head avatar by UUID; falls back to a neutral block.
  setAvatar(node.querySelector(".account-avatar"), acc.uuid);

  node.querySelector(".account-name").textContent = acc.username || acc.label;
  node.querySelector(".account-sub").textContent = subText(acc);

  const statusText = node.querySelector(".status-text");
  statusText.className = "status-text " + cls;
  statusText.textContent =
    acc.status === "connecting" && acc.attempt
      ? t("status.reconnect", { n: acc.attempt })
      : statusLabel(acc.status);

  const uptimeEl = node.querySelector(".uptime");
  uptimeEl.dataset.connectedAt = connected && acc.connectedAt ? acc.connectedAt : "";
  uptimeEl.textContent = connected ? formatUptime(acc.connectedAt) : "";

  const connectBtn = node.querySelector(".btn-connect");
  const busy = acc.status === "connecting" || acc.status === "connected";
  connectBtn.textContent = busy ? t("account.disconnect") : t("account.connect");
  connectBtn.classList.toggle("is-connected", busy);
  connectBtn.addEventListener("click", () =>
    busy ? stopAccount(acc.id) : startAccount(acc.id)
  );

  const removeBtn = node.querySelector(".btn-remove");
  removeBtn.textContent = t("account.remove");
  removeBtn.title = t("account.remove.title");
  removeBtn.addEventListener("click", () => removeAccount(acc.id));

  return node;
}

// Show a Minecraft head for `uuid`. The backend fetches it from mc-heads.net
// once and caches the PNG on disk (and we cache the data URL here), so it works
// offline afterwards and each UUID leaves this machine at most once. When the
// user turns avatars off, nothing is requested and we show a neutral block.
function setAvatar(img, uuid) {
  if (!uuid || !showAvatars) {
    img.removeAttribute("src");
    img.classList.add("is-fallback");
    return;
  }
  const cached = avatarCache.get(uuid);
  if (cached) {
    img.src = cached;
    return;
  }
  invoke("get_avatar", { uuid })
    .then((dataUrl) => {
      avatarCache.set(uuid, dataUrl);
      // The row may have been rebuilt since; only apply to the live node.
      if (img.isConnected) img.src = dataUrl;
    })
    .catch(() => {
      img.removeAttribute("src");
      img.classList.add("is-fallback");
    });
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
async function loadState(state) {
  if (!state) state = await invoke("get_state");
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
    errorKey: null,
  }));
  serverAddress = state.server_address || "";
  serverInput.value = serverAddress;
  showAvatars = state.show_avatars !== false;
  render();
}

let serverSaveTimer;
serverInput.addEventListener("input", () => {
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(async () => {
    serverAddress = serverInput.value.trim();
    await invoke("set_server", { address: serverAddress });
    serverHint.textContent = t("common.saved");
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
    toast(t("toast.noServer"), true);
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
  const acc = accounts.find((a) => a.id === id);
  const name = acc ? acc.username || acc.label || "" : "";
  const ok = await confirmDialog({
    title: t("account.remove.confirm.title"),
    body: t("account.remove.confirm.body", { name }),
    confirmLabel: t("account.remove"),
  });
  if (!ok) return;
  await invoke("stop_account", { id }).catch(() => {});
  await invoke("remove_account", { id });
  accounts = accounts.filter((a) => a.id !== id);
  render();
}

$("#start-selected-btn").addEventListener("click", async () => {
  if (!serverAddress) {
    toast(t("toast.noServer"), true);
    return;
  }
  const selected = accounts.filter((a) => a.selected);
  if (!selected.length) {
    toast(t("toast.noneSelected"), true);
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
    setAuthStatus("error", tErr(String(e)));
  }
});

function openAuthModal() {
  reauthId = null;
  authTitle.textContent = t("auth.title");
  authDesc.textContent = t("auth.desc");
  authCode.textContent = "––––––––";
  authLink.textContent = t("auth.openPage");
  authLink.dataset.url = "";
  setAuthStatus("waiting", t("auth.requestingCode"));
  authModal.hidden = false;
}

// Reused for an expired session: same modal, account-specific wording.
function openReauthModal(acc) {
  authTitle.textContent = t("auth.reauth.title");
  authDesc.textContent = t("auth.reauth.desc", {
    username: acc.username || acc.label || "",
  });
  authCode.textContent = "––––––––";
  authLink.textContent = t("auth.openPage");
  authLink.dataset.url = "";
  setAuthStatus("waiting", t("auth.waiting"));
  authModal.hidden = false;
}

function setAuthStatus(kind, msg) {
  authStatus.className = "modal-status" + (kind === "waiting" ? "" : " " + kind);
  const spinner = kind === "waiting" ? '<span class="spinner"></span> ' : "";
  authStatus.innerHTML = spinner + msg;
}

$("#auth-cancel-btn").addEventListener("click", () => {
  authModal.hidden = true;
  if (reauthId) {
    // Can't reconnect without a valid session — stop the account.
    const id = reauthId;
    reauthId = null;
    stopAccount(id);
  } else {
    invoke("cancel_add_account").catch(() => {});
  }
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
  if ("errorKey" in extra) acc.errorKey = extra.errorKey;
  if ("attempt" in extra) acc.attempt = extra.attempt;
  if (status !== "connected") {
    acc.connectedAt = null;
    acc.cpu = null;
    acc.mem = null;
  }
  if (status !== "connecting") acc.attempt = null;
  render();
}

// Translate a backend error if it is a known i18n key (e.g. "error.noServer",
// "bot.error.kicked"); otherwise pass the text through unchanged.
function tErr(msg) {
  const s = String(msg);
  if (/^(error|bot\.error|auth\.error)\./.test(s)) return t(s);
  return s;
}

// ---------- Confirm dialog ----------
const confirmModal = $("#confirm-modal");
const confirmTitle = $("#confirm-title");
const confirmBody = $("#confirm-body");
const confirmOkBtn = $("#confirm-ok-btn");
const confirmCancelBtn = $("#confirm-cancel-btn");
let confirmResolver = null;

// Promise-based confirm so callers can `await` the user's choice.
function confirmDialog({ title, body, confirmLabel, cancelLabel }) {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmOkBtn.textContent = confirmLabel;
  confirmCancelBtn.textContent = cancelLabel || t("common.cancel");
  confirmModal.hidden = false;
  return new Promise((resolve) => (confirmResolver = resolve));
}

function closeConfirm(result) {
  confirmModal.hidden = true;
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

confirmOkBtn.addEventListener("click", () => closeConfirm(true));
confirmCancelBtn.addEventListener("click", () => closeConfirm(false));
confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirm(false);
});

// ---------- Toasts ----------
function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = tErr(msg);
  $("#toast-container").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- Event wiring ----------
listen("auth:code", (e) => {
  const { id, user_code, verification_uri } = e.payload;
  // A code carrying a known account id comes from a running bot whose session
  // expired: reopen the dialog for that account instead of failing silently.
  const acc = id ? accounts.find((a) => a.id === id) : null;
  if (acc) {
    reauthId = id;
    openReauthModal(acc);
  }
  authCode.textContent = user_code;
  authLink.dataset.url = verification_uri;
  authLink.textContent = verification_uri;
  setAuthStatus("waiting", t("auth.waiting"));
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
  setAuthStatus("success", t("auth.signedIn", { username: acc.username }));
  render();
  setTimeout(() => (authModal.hidden = true), 1200);
});

listen("auth:error", (e) => {
  setAuthStatus("error", tErr(e.payload));
});

listen("bot:status", (e) => {
  const { id, status, connected_at, error, error_key, attempt } = e.payload;
  updateStatus(id, status, {
    connectedAt: connected_at ? connected_at * 1000 : null,
    error: error || "",
    errorKey: error_key || null,
    attempt: attempt || null,
  });
  // A pending re-auth resolved once the bot reconnects.
  if (reauthId === id && status === "connected") {
    reauthId = null;
    setAuthStatus("success", t("auth.reauth.done"));
    setTimeout(() => (authModal.hidden = true), 1200);
  }
});

// Whole-process resource usage (all bots + the app), sampled in the backend.
listen("app:metrics", (e) => {
  const { cpu, mem_mb } = e.payload;
  overallCpuEl.innerHTML = `${Number(cpu).toFixed(1)}&nbsp;%`;
  overallMemEl.innerHTML = `${Math.round(mem_mb)}&nbsp;MB`;
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
  whatsnewVersion.textContent = t("whatsnew.version", { version: wn.version });
  whatsnewBody.innerHTML = renderMarkdown(wn.notes);
  whatsnewModal.hidden = false;
}

async function initVersion() {
  try {
    const v = await invoke("get_app_version");
    versionText.textContent = "v" + v;
    if (settingsVersion) settingsVersion.textContent = "v" + v;
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

function showUpdateBanner(version) {
  availableVersion = version;
  updateDot.hidden = false;
  updateBannerText.textContent = t("update.available", { version });
  updateBanner.hidden = false;
}

// Silent background check on launch. Stays quiet when offline or in dev.
async function checkForUpdate() {
  try {
    const meta = await invoke("check_for_update");
    if (meta && meta.available) showUpdateBanner(meta.version);
  } catch {
    // No reachable updater endpoint — nothing to show.
  }
}

versionBadge.addEventListener("click", async () => {
  try {
    const wn = await invoke("get_changelog", { version: null });
    if (wn) openWhatsNew(wn);
    else toast(t("whatsnew.none"));
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
  updateBannerText.textContent = t("update.downloading", { version: availableVersion });
  try {
    await invoke("install_update");
    // On success the app relaunches into the new version — usually unreachable.
  } catch (e) {
    installing = false;
    updateInstallBtn.disabled = false;
    updateDismissBtn.disabled = false;
    updateProgress.hidden = true;
    updateProgressBar.style.width = "0";
    updateBannerText.textContent = t("update.failed");
    toast(String(e), true);
  }
});

listen("update:progress", (e) => {
  const { downloaded, total } = e.payload;
  if (total) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    updateProgressBar.style.width = pct + "%";
    updateBannerText.textContent = t("update.downloadingPct", { version: availableVersion, pct });
  }
});

listen("update:downloaded", () => {
  updateProgressBar.style.width = "100%";
  updateBannerText.textContent = t("update.installing");
});

// ---------- Settings ----------
const settingsModal = $("#settings-modal");
const languageSelect = $("#language-select");
const avatarsToggle = $("#avatars-toggle");
const settingsVersion = $("#settings-version");
const updateCheckStatus = $("#update-check-status");
const checkUpdateBtn = $("#check-update-btn");

function populateLanguages() {
  const langs = i18n.getAvailable();
  languageSelect.innerHTML = "";
  for (const [code, name] of Object.entries(langs)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    languageSelect.appendChild(opt);
  }
  languageSelect.value = i18n.getLanguage();
}

async function applyLanguage(code) {
  await i18n.setLanguage(code); // updates every [data-i18n] element
  render(); // rebuild dynamic account rows in the new language
  if (availableVersion) {
    updateBannerText.textContent = t("update.available", { version: availableVersion });
  }
  updateCheckStatus.textContent = "";
  updateCheckStatus.classList.remove("error");
}

$("#settings-btn").addEventListener("click", () => {
  populateLanguages();
  avatarsToggle.checked = showAvatars;
  updateCheckStatus.textContent = "";
  updateCheckStatus.classList.remove("error");
  settingsModal.hidden = false;
});

avatarsToggle.addEventListener("change", () => {
  showAvatars = avatarsToggle.checked;
  render();
  invoke("set_show_avatars", { enabled: showAvatars }).catch(() => {});
});

$("#settings-close-btn").addEventListener("click", () => {
  settingsModal.hidden = true;
});
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.hidden = true;
});

languageSelect.addEventListener("change", async () => {
  const code = languageSelect.value;
  await applyLanguage(code);
  invoke("set_language", { language: code }).catch(() => {});
});

checkUpdateBtn.addEventListener("click", async () => {
  updateCheckStatus.classList.remove("error");
  updateCheckStatus.textContent = t("settings.checking");
  checkUpdateBtn.disabled = true;
  try {
    const meta = await invoke("check_for_update");
    if (meta && meta.available) {
      showUpdateBanner(meta.version);
      updateCheckStatus.textContent = t("update.available", { version: meta.version });
    } else {
      updateCheckStatus.textContent = t("settings.upToDate");
    }
  } catch {
    updateCheckStatus.classList.add("error");
    updateCheckStatus.textContent = t("settings.checkFailed");
  } finally {
    checkUpdateBtn.disabled = false;
  }
});

// ---------- Boot ----------
async function boot() {
  await i18n.loadAvailable();
  let state = {};
  try {
    state = await invoke("get_state");
  } catch {}
  await i18n.setLanguage(i18n.pickDefault(state.language));
  loadState(state);
  initVersion();
  showWhatsNewIfUpdated();
  checkForUpdate();
}
window.addEventListener("DOMContentLoaded", boot);
