// The account list: rendering, per-row actions, selection, footer controls,
// and the live uptime ticker. Subscribes to the store and re-renders on change.

import * as api from "./api.js";
import {
  state,
  subscribe,
  notify,
  findAccount,
  countConnected,
  updateStatus,
  rememberServer,
} from "./store.js";
import { $, formatUptime } from "./dom.js";
import { iconSvg, setIcon } from "./icons.js";
import { toast, confirmDialog } from "./overlays.js";
import { t } from "../i18n.js";

let listEl, emptyEl, countEl, selectAllEl, botsEl, rowTpl;

// True while a row is being dragged to reorder. Renders are paused so a live
// status update can't rebuild the list out from under the drag.
let dragging = false;
// The active pointer-drag session: { row, id, startY, active }. We use Pointer
// Events rather than HTML5 drag-and-drop, which is unreliable in WKWebView.
let drag = null;

// uuid -> data: URL, so re-renders reuse a fetched avatar without flicker.
const avatarCache = new Map();

// Sub-line under the name: uuid normally, the error when in an error state.
function subText(acc) {
  if (acc.status === "error") {
    if (acc.errorKey) return t(acc.errorKey);
    if (acc.error) return acc.error;
  }
  return acc.uuid || "";
}

// Minecraft head by UUID. The backend fetches it once and caches it on disk; we
// also cache the data URL here. A muted user glyph stands in while loading, when
// avatars are off, or on failure.
function setAvatar(el, uuid) {
  el.classList.remove("has-img");
  el.style.backgroundImage = "";
  const fallback = () => setIcon(el, "user", { size: 18 });

  if (!uuid || !state.showAvatars) {
    fallback();
    return;
  }
  const apply = (url) => {
    el.innerHTML = "";
    el.style.backgroundImage = `url("${url}")`;
    el.classList.add("has-img");
  };
  const cached = avatarCache.get(uuid);
  if (cached) {
    apply(cached);
    return;
  }
  fallback();
  api
    .getAvatar(uuid)
    .then((url) => {
      avatarCache.set(uuid, url);
      if (el.isConnected) apply(url);
    })
    .catch(() => {});
}

function buildRow(acc) {
  const node = rowTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = acc.id;
  wireDrag(node, acc.id);
  const connected = acc.status === "connected";
  const busy = connected || acc.status === "connecting";

  node.classList.toggle("is-connected", connected);
  node.classList.toggle("is-connecting", acc.status === "connecting");
  node.classList.toggle("is-error", acc.status === "error");

  const select = node.querySelector(".account-select");
  select.checked = acc.selected;
  select.setAttribute("aria-label", t("account.select", { name: acc.username || acc.id }));
  select.addEventListener("change", () => toggleSelected(acc.id, select.checked));

  setAvatar(node.querySelector(".avatar"), acc.uuid);

  node.querySelector(".account-name").textContent = acc.username || acc.id;
  node.querySelector(".account-sub").textContent = subText(acc);

  const statusText = node.querySelector(".status-text");
  statusText.textContent =
    acc.status === "connecting" && acc.attempt
      ? t("status.reconnect", { n: acc.attempt })
      : t(`status.${acc.status}`);

  const uptimeEl = node.querySelector(".uptime");
  uptimeEl.dataset.connectedAt = connected && acc.connectedAt ? acc.connectedAt : "";
  uptimeEl.textContent = connected ? formatUptime(acc.connectedAt) : "";

  const connectBtn = node.querySelector(".btn-connect");
  connectBtn.innerHTML =
    iconSvg(busy ? "disconnect" : "connect", { size: 16 }) +
    `<span>${busy ? t("account.disconnect") : t("account.connect")}</span>`;
  connectBtn.classList.toggle("is-connected", busy);
  connectBtn.addEventListener("click", () => (busy ? stopAccount(acc.id) : startAccount(acc.id)));

  const removeBtn = node.querySelector(".btn-remove");
  setIcon(removeBtn, "trash", { size: 16 });
  removeBtn.title = t("account.remove.title");
  removeBtn.setAttribute("aria-label", t("account.remove.title"));
  removeBtn.addEventListener("click", () => removeAccount(acc.id));

  return node;
}

// Reorder is driven from the grip handle only (so checkbox/buttons keep
// working). Pointer Events give us a reliable drag in WKWebView plus live
// visual feedback as rows shift around the one being moved.
function wireDrag(node, id) {
  const handle = node.querySelector(".drag-handle");
  setIcon(handle, "drag", { size: 16, stroke: 2 });
  handle.title = t("account.reorder");
  handle.addEventListener("pointerdown", (e) => startDrag(e, node, id, handle));
}

function startDrag(e, row, id, handle) {
  if (e.button) return; // primary button only
  e.preventDefault();
  drag = { row, id, startY: e.clientY, started: false };
  // Capture so we keep getting moves even if the pointer outruns the row.
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {}
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
}

// Lift the row out of the list into a floating, pointer-following element, and
// drop a placeholder into its slot to show where it will land.
function liftRow(e) {
  const { row } = drag;
  const rect = row.getBoundingClientRect();
  drag.grabDy = e.clientY - rect.top; // keep the grabbed point under the cursor

  const ph = document.createElement("li");
  ph.className = "account-placeholder";
  ph.style.height = rect.height + "px";
  row.before(ph);
  drag.ph = ph;

  row.classList.add("dragging"); // position: fixed comes from here
  row.style.left = rect.left + "px";
  row.style.width = rect.width + "px";
  row.style.top = e.clientY - drag.grabDy + "px";
  dragging = true;
}

function onDragMove(e) {
  if (!drag) return;
  // Wait for a little movement so a plain click on the handle doesn't lift it.
  if (!drag.started) {
    if (Math.abs(e.clientY - drag.startY) < 4) return;
    drag.started = true;
    liftRow(e);
  }
  e.preventDefault();
  // Float with the cursor...
  drag.row.style.top = e.clientY - drag.grabDy + "px";
  // ...and slide the placeholder to the slot the cursor is over.
  const after = rowAfter(e.clientY);
  if (after == null) {
    if (listEl.lastElementChild !== drag.ph) listEl.appendChild(drag.ph);
  } else if (after.previousElementSibling !== drag.ph) {
    listEl.insertBefore(drag.ph, after);
  }
}

function endDrag() {
  if (!drag) return;
  const { row, ph, started } = drag;
  drag = null;
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", endDrag);
  if (!started) return;
  // Drop the row into the placeholder's slot, clear the floating styles, persist.
  row.classList.remove("dragging");
  row.style.left = "";
  row.style.top = "";
  row.style.width = "";
  ph.replaceWith(row);
  dragging = false;
  commitOrder();
}

// The row the cursor is currently above the midpoint of, used as the insertion
// point. Returns null past the last row (append to the end).
function rowAfter(y) {
  let closest = { offset: Number.NEGATIVE_INFINITY, el: null };
  for (const row of listEl.querySelectorAll(".account:not(.dragging)")) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: row };
  }
  return closest.el;
}

// Persist the order shown in the DOM to the store and the backend, then
// re-render so each row's listeners are freshly bound to the new positions.
function commitOrder() {
  const ids = [...listEl.querySelectorAll(".account")].map((el) => el.dataset.id);
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length === state.accounts.length) state.accounts = reordered;
  api.reorderAccounts(ids).catch(() => {});
  notify();
}

function render() {
  if (dragging) return; // don't rebuild the list mid-drag
  const accounts = state.accounts;
  countEl.textContent = String(accounts.length);
  emptyEl.hidden = accounts.length > 0;
  listEl.hidden = accounts.length === 0;

  listEl.innerHTML = "";
  for (const acc of accounts) listEl.appendChild(buildRow(acc));

  syncSelectAll();
  botsEl.textContent = String(countConnected());
}

function syncSelectAll() {
  const total = state.accounts.length;
  const selected = state.accounts.filter((a) => a.selected).length;
  selectAllEl.checked = total > 0 && selected === total;
  selectAllEl.indeterminate = selected > 0 && selected < total;
  selectAllEl.disabled = total === 0;
}

// Tick connected rows' uptimes without a full re-render.
function tickUptimes() {
  for (const el of listEl.querySelectorAll(".uptime")) {
    const at = Number(el.dataset.connectedAt);
    if (at) el.textContent = formatUptime(at);
  }
}

// --- Actions ---
async function startAccount(id) {
  if (!state.serverAddress) {
    toast(t("toast.noServer"), true);
    return;
  }
  rememberServer(state.serverAddress);
  updateStatus(id, "connecting");
  try {
    await api.startAccount(id);
  } catch (e) {
    toast(String(e), true);
    updateStatus(id, "error", { error: String(e) });
  }
}

async function stopAccount(id) {
  try {
    await api.stopAccount(id);
  } catch (e) {
    toast(String(e), true);
  }
}

async function removeAccount(id) {
  const acc = findAccount(id);
  const name = acc ? acc.username || "" : "";
  const ok = await confirmDialog({
    title: t("account.remove.confirm.title"),
    body: t("account.remove.confirm.body", { name }),
    confirmLabel: t("account.remove"),
  });
  if (!ok) return;
  await api.stopAccount(id).catch(() => {});
  await api.removeAccount(id);
  state.accounts = state.accounts.filter((a) => a.id !== id);
  notify();
}

async function toggleSelected(id, selected) {
  const acc = findAccount(id);
  if (acc) acc.selected = selected;
  syncSelectAll();
  await api.setSelected(id, selected).catch(() => {});
}

async function startSelected() {
  if (!state.serverAddress) {
    toast(t("toast.noServer"), true);
    return;
  }
  const selected = state.accounts.filter((a) => a.selected);
  if (!selected.length) {
    toast(t("toast.noneSelected"), true);
    return;
  }
  rememberServer(state.serverAddress);
  for (const a of selected) {
    if (a.status !== "connected" && a.status !== "connecting") updateStatus(a.id, "connecting");
  }
  await api.startSelected().catch((e) => toast(String(e), true));
}

export function mountAccounts() {
  listEl = $("#accounts-list");
  emptyEl = $("#empty-state");
  countEl = $("#account-count");
  selectAllEl = $("#select-all");
  botsEl = $("#overall-bots");
  rowTpl = $("#account-row-template");

  selectAllEl.addEventListener("change", async () => {
    const val = selectAllEl.checked;
    for (const a of state.accounts) a.selected = val;
    notify();
    await api.setAllSelected(val).catch(() => {});
  });
  $("#start-selected-btn").addEventListener("click", startSelected);
  $("#stop-all-btn").addEventListener("click", () =>
    api.stopAll().catch((e) => toast(String(e), true))
  );

  subscribe(render);
  setInterval(tickUptimes, 1000);
  render();
}
