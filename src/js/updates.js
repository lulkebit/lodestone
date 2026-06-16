// Version badge, the "update available" banner, and the "What's new" changelog
// screen. Update checking/installing runs in the backend; this just drives the
// UI and listens for `update:*` progress events.

import * as api from "./api.js";
import { subscribe } from "./store.js";
import { $, renderMarkdown } from "./dom.js";
import { toast } from "./overlays.js";
import { t } from "../i18n.js";

let banner, bannerText, installBtn, dismissBtn, progress, progressBar;
let versionText, settingsVersion, updateDot, versionBadge;
let whatsnewModal, whatsnewVersion, whatsnewBody;
let availableVersion = null;
let installing = false;

export function showUpdateBanner(version) {
  availableVersion = version;
  updateDot.hidden = false;
  bannerText.textContent = t("update.available", { version });
  banner.hidden = false;
}

function openWhatsNew(wn) {
  whatsnewVersion.textContent = t("whatsnew.version", { version: wn.version });
  whatsnewBody.innerHTML = renderMarkdown(wn.notes);
  whatsnewModal.hidden = false;
}

async function initVersion() {
  try {
    const v = await api.getAppVersion();
    versionText.textContent = "v" + v;
    if (settingsVersion) settingsVersion.textContent = "v" + v;
  } catch {}
}

// After an update the running version differs from the last one the user saw;
// the backend returns that version's changelog so we can surface it.
async function showWhatsNewIfUpdated() {
  try {
    const wn = await api.getWhatsNew();
    if (wn) openWhatsNew(wn);
  } catch {}
}

// Silent background check on launch. Stays quiet when offline or in dev.
async function checkForUpdate() {
  try {
    const meta = await api.checkForUpdate();
    if (meta && meta.available) showUpdateBanner(meta.version);
  } catch {}
}

async function install() {
  if (installing) return;
  installing = true;
  installBtn.disabled = true;
  dismissBtn.disabled = true;
  progress.hidden = false;
  bannerText.textContent = t("update.downloading", { version: availableVersion });
  try {
    await api.installUpdate();
    // On success the app relaunches into the new version (usually unreachable).
  } catch (e) {
    installing = false;
    installBtn.disabled = false;
    dismissBtn.disabled = false;
    progress.hidden = true;
    progressBar.style.width = "0";
    bannerText.textContent = t("update.failed");
    toast(String(e), true);
  }
}

export function mountUpdates() {
  banner = $("#update-banner");
  bannerText = $("#update-banner-text");
  installBtn = $("#update-install-btn");
  dismissBtn = $("#update-dismiss-btn");
  progress = $("#update-progress");
  progressBar = $("#update-progress-bar");
  versionText = $("#version-text");
  settingsVersion = $("#settings-version");
  updateDot = $("#update-dot");
  versionBadge = $("#version-badge");
  whatsnewModal = $("#whatsnew-modal");
  whatsnewVersion = $("#whatsnew-version");
  whatsnewBody = $("#whatsnew-body");

  versionBadge.addEventListener("click", async () => {
    try {
      const wn = await api.getChangelog();
      if (wn) openWhatsNew(wn);
      else toast(t("whatsnew.none"));
    } catch {}
  });
  dismissBtn.addEventListener("click", () => {
    banner.hidden = true;
  });
  installBtn.addEventListener("click", install);
  $("#whatsnew-close-btn").addEventListener("click", () => {
    whatsnewModal.hidden = true;
  });
  whatsnewModal.addEventListener("click", (e) => {
    if (e.target === whatsnewModal) whatsnewModal.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !whatsnewModal.hidden) whatsnewModal.hidden = true;
  });

  api.on("update:progress", ({ downloaded, total }) => {
    if (total) {
      const pct = Math.min(100, Math.round((downloaded / total) * 100));
      progressBar.style.width = pct + "%";
      bannerText.textContent = t("update.downloadingPct", { version: availableVersion, pct });
    }
  });
  api.on("update:downloaded", () => {
    progressBar.style.width = "100%";
    bannerText.textContent = t("update.installing");
  });

  // Keep the banner text translated when the language changes.
  subscribe(() => {
    if (availableVersion && !banner.hidden) {
      bannerText.textContent = t("update.available", { version: availableVersion });
    }
  });

  initVersion();
  showWhatsNewIfUpdated();
  checkForUpdate();
}
