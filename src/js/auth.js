// Microsoft device-code sign-in: the add-account flow and the re-auth flow for
// an account whose session expired. Owns the auth modal end to end.

import * as api from "./api.js";
import { state, notify } from "./store.js";
import { $, escapeHtml, tErr } from "./dom.js";
import { iconSvg } from "./icons.js";
import { t } from "../i18n.js";

let modal, codeEl, linkEl, statusEl, titleEl, descEl;

function setAuthStatus(kind, msg) {
  statusEl.className = "modal-status" + (kind === "waiting" ? "" : " " + kind);
  let lead = '<span class="spinner"></span>';
  if (kind === "success") lead = iconSvg("check", { size: 16 });
  else if (kind === "error") lead = iconSvg("warning", { size: 16 });
  statusEl.innerHTML = lead + `<span>${escapeHtml(String(msg))}</span>`;
}

function resetCodeRow() {
  codeEl.textContent = "––––––––";
  linkEl.textContent = t("auth.openPage");
  linkEl.dataset.url = "";
}

function openAuthModal() {
  state.reauthId = null;
  titleEl.textContent = t("auth.title");
  descEl.textContent = t("auth.desc");
  resetCodeRow();
  setAuthStatus("waiting", t("auth.requestingCode"));
  modal.hidden = false;
}

// Same modal, account-specific wording, for an expired session.
function openReauthModal(acc) {
  state.reauthId = acc.id;
  titleEl.textContent = t("auth.reauth.title");
  descEl.textContent = t("auth.reauth.desc", { username: acc.username || acc.id });
  resetCodeRow();
  setAuthStatus("waiting", t("auth.waiting"));
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
}

async function onAdd() {
  openAuthModal();
  try {
    await api.addAccount();
  } catch (e) {
    setAuthStatus("error", tErr(String(e)));
  }
}

function onCancel() {
  if (modal.hidden) return;
  closeModal();
  if (state.reauthId) {
    // Can't reconnect without a valid session, so stop the account.
    const id = state.reauthId;
    state.reauthId = null;
    api.stopAccount(id).catch(() => {});
  } else {
    api.cancelAddAccount().catch(() => {});
  }
}

function onCode({ id, user_code, verification_uri }) {
  // A code carrying a known account id comes from a running bot whose session
  // expired: reopen the dialog for that account instead of failing silently.
  const acc = id ? state.accounts.find((a) => a.id === id) : null;
  if (acc) openReauthModal(acc);

  codeEl.textContent = user_code;
  linkEl.dataset.url = verification_uri;
  linkEl.textContent = verification_uri;
  setAuthStatus("waiting", t("auth.waiting"));
  api.openUrl(verification_uri).catch(() => {}); // auto-open the verification page
}

function onSuccess(acc) {
  const existing = state.accounts.find((a) => a.uuid === acc.uuid);
  if (existing) {
    existing.id = acc.id;
    existing.username = acc.username;
  } else {
    state.accounts.push({
      id: acc.id,
      username: acc.username,
      uuid: acc.uuid,
      selected: true,
      status: "disconnected",
      connectedAt: null,
      error: "",
      errorKey: null,
      attempt: null,
    });
  }
  notify();
  setAuthStatus("success", t("auth.signedIn", { username: acc.username }));
  setTimeout(closeModal, 1200);
}

// Called by the bot:status listener: a pending re-auth resolves once the bot
// reconnects with its fresh session.
export function resolveReauthIfConnected(id, status) {
  if (state.reauthId === id && status === "connected") {
    state.reauthId = null;
    setAuthStatus("success", t("auth.reauth.done"));
    setTimeout(closeModal, 1200);
  }
}

export function mountAuth() {
  modal = $("#auth-modal");
  codeEl = $("#auth-code");
  linkEl = $("#auth-link");
  statusEl = $("#auth-status");
  titleEl = modal.querySelector("h2");
  descEl = modal.querySelector(".modal-desc");

  $("#add-account-btn").addEventListener("click", onAdd);
  $("#auth-cancel-btn").addEventListener("click", onCancel);
  $("#copy-code-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(codeEl.textContent.trim());
  });
  linkEl.addEventListener("click", (e) => {
    e.preventDefault();
    if (linkEl.dataset.url) api.openUrl(linkEl.dataset.url).catch(() => {});
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) onCancel();
  });

  api.on("auth:code", onCode);
  api.on("auth:success", onSuccess);
  api.on("auth:error", (payload) => setAuthStatus("error", tErr(payload)));
}
