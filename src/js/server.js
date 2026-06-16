// The server field: saves the address (debounced), live-pings it to show a
// reachability / version / MOTD line, and offers recently used servers as a
// quick-pick list. Pings run in the backend (azalea Server List Ping).

import * as api from "./api.js";
import { state, subscribe, rememberServer } from "./store.js";
import { $ } from "./dom.js";
import { setIcon } from "./icons.js";
import { t } from "../i18n.js";

let input, hint, statusEl, dotEl, textEl, faviconEl, suggestEl;
let saveTimer;
// The address the visible status line describes, so a slow ping that resolves
// after the user has moved on can be discarded.
let pinging = null;

// host, or host:port. Covers domains and IPv4; intentionally permissive since
// the backend resolves and validates for real.
function looksLikeServer(addr) {
  return /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(addr);
}

// Minecraft section-sign colour codes occasionally survive into the plain MOTD;
// drop them and collapse whitespace so the preview stays one tidy line.
function cleanMotd(s) {
  return s.replace(/§./g, "").replace(/\s+/g, " ").trim();
}

function setStatus(cls, text, favicon) {
  statusEl.hidden = false;
  dotEl.className = "server-status-dot " + cls;
  textEl.textContent = text;
  if (favicon) {
    faviconEl.style.backgroundImage = `url("${favicon}")`;
    faviconEl.hidden = false;
  } else {
    faviconEl.hidden = true;
    faviconEl.style.backgroundImage = "";
  }
}

function hideStatus() {
  statusEl.hidden = true;
  faviconEl.hidden = true;
  pinging = null;
}

async function ping(addr) {
  addr = (addr || "").trim();
  if (!looksLikeServer(addr)) {
    hideStatus();
    return;
  }
  pinging = addr;
  setStatus("checking", t("server.checking"));
  let res;
  try {
    res = await api.pingServer(addr);
  } catch {
    res = { online: false, error: "server.ping.offline" };
  }
  if (pinging !== addr) return; // a newer ping (or clear) superseded this one
  if (res.online) {
    const parts = [];
    if (res.players_online != null && res.players_max != null)
      parts.push(`${res.players_online}/${res.players_max}`);
    if (res.version) parts.push(res.version);
    if (res.motd) parts.push(cleanMotd(res.motd));
    setStatus("online", parts.join("  ·  "), res.favicon);
  } else {
    setStatus("offline", t(res.error || "server.ping.offline"));
  }
}

// Save the current value after a short pause, then re-ping it.
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const addr = input.value.trim();
    state.serverAddress = addr;
    await api.setServer(addr).catch(() => {});
    hint.classList.add("show");
    setTimeout(() => hint.classList.remove("show"), 1400);
    ping(addr);
  }, 450);
}

// Pick from history: save and ping immediately, no debounce.
async function pick(addr) {
  clearTimeout(saveTimer);
  input.value = addr;
  state.serverAddress = addr;
  rememberServer(addr);
  closeSuggest();
  await api.setServer(addr).catch(() => {});
  ping(addr);
  input.focus();
}

function openSuggest() {
  const q = input.value.trim().toLowerCase();
  const matches = (state.serverHistory || []).filter(
    (s) => s.toLowerCase() !== q && (!q || s.toLowerCase().includes(q))
  );
  suggestEl.innerHTML = "";
  suggestEl.setAttribute("aria-label", t("server.recent"));
  if (!matches.length) {
    closeSuggest();
    return;
  }
  for (const s of matches) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "server-suggest-item";
    item.setAttribute("role", "option");
    const ico = document.createElement("span");
    ico.className = "server-suggest-ico";
    setIcon(ico, "server", { size: 14 });
    const label = document.createElement("span");
    label.textContent = s;
    item.append(ico, label);
    // mousedown (not click) so it fires before the input's blur closes the list.
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(s);
    });
    suggestEl.appendChild(item);
  }
  suggestEl.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function closeSuggest() {
  suggestEl.hidden = true;
  input.setAttribute("aria-expanded", "false");
}

// Keep the field in sync when the state loads/changes (but never clobber what
// the user is actively typing).
function syncFromState() {
  if (document.activeElement !== input) input.value = state.serverAddress || "";
}

// Ping whatever server is currently saved. Called once after the initial state
// load so the user sees status without having to touch the field.
export function pingCurrent() {
  ping(state.serverAddress || "");
}

export function mountServer() {
  input = $("#server-input");
  hint = $("#server-save-hint");
  statusEl = $("#server-status");
  dotEl = $("#server-status-dot");
  textEl = $("#server-status-text");
  faviconEl = $("#server-favicon");
  suggestEl = $("#server-suggest");

  input.addEventListener("input", () => {
    scheduleSave();
    openSuggest();
  });
  input.addEventListener("focus", openSuggest);
  // Delay so a suggestion's mousedown can run before we hide the list.
  input.addEventListener("blur", () => setTimeout(closeSuggest, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSuggest();
  });

  subscribe(syncFromState);
  syncFromState();
}
