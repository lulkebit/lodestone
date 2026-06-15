// Transient UI: toasts and the promise-based confirm dialog.

import { $, tErr } from "./dom.js";
import { setIcon } from "./icons.js";
import { t } from "../i18n.js";

const TOAST_MS = 4200;

export function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " toast-error" : "");
  el.setAttribute("role", isError ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  setIcon(icon, isError ? "warning" : "info", { size: 16 });

  const text = document.createElement("span");
  text.textContent = tErr(msg);

  el.append(icon, text);
  $("#toast-container").appendChild(el);
  // Exit animation, then remove.
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 200);
  }, TOAST_MS);
}

// Promise-based confirm so callers can `await` the user's choice. Wires its own
// one-shot listeners (buttons, backdrop click, Escape) and cleans them up.
export function confirmDialog({ title, body, confirmLabel, cancelLabel }) {
  const modal = $("#confirm-modal");
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const okBtn = $("#confirm-ok-btn");
  const cancelBtn = $("#confirm-cancel-btn");
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel || t("common.cancel");

  return new Promise((resolve) => {
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => {
      if (e.target === modal) close(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };

    function close(result) {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);

    modal.hidden = false;
    okBtn.focus();
  });
}
