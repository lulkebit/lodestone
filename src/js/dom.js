// Small DOM + formatting helpers shared across the UI modules.

import { t } from "../i18n.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Connection uptime as `h:mm:ss` (or `m:ss` under an hour). */
export function formatUptime(connectedAt) {
  if (!connectedAt) return "";
  const secs = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Translate a backend message if it is a known i18n key (e.g. "error.noServer",
// "bot.error.kicked"); otherwise pass the text through unchanged.
export function tErr(msg) {
  const s = String(msg);
  if (/^(error|bot\.error|auth\.error)\./.test(s)) return t(s);
  return s;
}

// Minimal Markdown -> HTML for changelog bodies (headings, lists, bold, code).
export function renderMarkdown(md) {
  const inline = (s) =>
    escapeHtml(s)
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
