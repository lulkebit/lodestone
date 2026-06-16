// Settings modal: interface language, the avatars toggle, and a manual update
// check. Language and avatar changes re-render the rest of the UI via the store.

import * as api from "./api.js";
import { state, notify } from "./store.js";
import { $ } from "./dom.js";
import { showUpdateBanner } from "./updates.js";
import * as i18n from "../i18n.js";

const t = i18n.t;

let modal, languageSelect, avatarsToggle, updateCheckStatus, checkUpdateBtn;

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
  await i18n.setLanguage(code); // re-applies every [data-i18n] element
  notify(); // re-render dynamic content (account rows, update banner)
  updateCheckStatus.textContent = "";
  updateCheckStatus.classList.remove("error");
}

function openSettings() {
  populateLanguages();
  avatarsToggle.checked = state.showAvatars;
  updateCheckStatus.textContent = "";
  updateCheckStatus.classList.remove("error");
  modal.hidden = false;
}

async function onCheck() {
  updateCheckStatus.classList.remove("error");
  updateCheckStatus.textContent = t("settings.checking");
  checkUpdateBtn.disabled = true;
  try {
    const meta = await api.checkForUpdate();
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
}

export function mountSettings() {
  modal = $("#settings-modal");
  languageSelect = $("#language-select");
  avatarsToggle = $("#avatars-toggle");
  updateCheckStatus = $("#update-check-status");
  checkUpdateBtn = $("#check-update-btn");

  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close-btn").addEventListener("click", () => {
    modal.hidden = true;
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
  });

  languageSelect.addEventListener("change", async () => {
    const code = languageSelect.value;
    await applyLanguage(code);
    api.setLanguage(code).catch(() => {});
  });
  avatarsToggle.addEventListener("change", () => {
    state.showAvatars = avatarsToggle.checked;
    notify();
    api.setShowAvatars(state.showAvatars).catch(() => {});
  });
  checkUpdateBtn.addEventListener("click", onCheck);
}
