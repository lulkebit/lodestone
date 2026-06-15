// App entry point: load the language, hydrate icons, mount each feature module,
// wire the global backend listeners, then push the initial state into the store.
// Feature logic lives in ./js/* — this file only orchestrates boot.

import * as i18n from "./i18n.js";
import * as api from "./js/api.js";
import { state, toAccount, updateStatus, notify } from "./js/store.js";
import { mountIcons } from "./js/icons.js";
import { $ } from "./js/dom.js";
import { mountAccounts } from "./js/accounts.js";
import { mountAuth, resolveReauthIfConnected } from "./js/auth.js";
import { mountUpdates } from "./js/updates.js";
import { mountSettings } from "./js/settings.js";

let serverInput;

function wireServerInput() {
  serverInput = $("#server-input");
  const hint = $("#server-save-hint");
  let timer;
  serverInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      state.serverAddress = serverInput.value.trim();
      await api.setServer(state.serverAddress);
      hint.classList.add("show");
      setTimeout(() => hint.classList.remove("show"), 1400);
    }, 400);
  });
}

function wireMetrics() {
  const cpuEl = $("#overall-cpu");
  const memEl = $("#overall-mem");
  // Whole-process CPU/RAM (all bots + the app), sampled in the backend.
  api.on("app:metrics", ({ cpu, mem_mb }) => {
    cpuEl.innerHTML = `${Number(cpu).toFixed(1)}&nbsp;%`;
    memEl.innerHTML = `${Math.round(mem_mb)}&nbsp;MB`;
  });
}

function wireBotStatus() {
  api.on("bot:status", ({ id, status, connected_at, error, error_key, attempt }) => {
    updateStatus(id, status, {
      connectedAt: connected_at ? connected_at * 1000 : null,
      error: error || "",
      errorKey: error_key || null,
      attempt: attempt || null,
    });
    resolveReauthIfConnected(id, status);
  });
}

function applyState(s) {
  state.accounts = (s.accounts || []).map(toAccount);
  state.serverAddress = s.server_address || "";
  state.showAvatars = s.show_avatars !== false;
  serverInput.value = state.serverAddress;
  notify();
}

async function boot() {
  await i18n.loadAvailable();
  let s = {};
  try {
    s = await api.getState();
  } catch {}
  await i18n.setLanguage(i18n.pickDefault(s.language));

  mountIcons();
  mountAccounts();
  mountAuth();
  mountUpdates();
  mountSettings();
  wireServerInput();
  wireMetrics();
  wireBotStatus();

  applyState(s);
}

window.addEventListener("DOMContentLoaded", boot);
