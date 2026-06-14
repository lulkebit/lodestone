// File-driven internationalization.
//
// Translations live in /locales as plain JSON:
//   - index.json      maps a language code to its display name, e.g. {"de":"Deutsch"}
//   - <code>.json     flat map of key -> translated string
//
// Adding a language = drop a new <code>.json next to the others and add one line
// to index.json. No code changes needed.
//
// In markup, tag elements with:
//   data-i18n="key"              -> sets textContent
//   data-i18n-placeholder="key"  -> sets the placeholder attribute
//   data-i18n-title="key"        -> sets the title attribute
//
// In code, use t("key", { var: value }) for dynamic strings. Placeholders in a
// translation use {var} syntax.

const FALLBACK = "en";

let dict = {};
let current = FALLBACK;
let available = {};

/** Load the list of available languages (code -> display name). */
export async function loadAvailable() {
  try {
    const res = await fetch("locales/index.json");
    available = await res.json();
  } catch {
    available = { en: "English" };
  }
  return available;
}

export function getAvailable() {
  return available;
}

export function getLanguage() {
  return current;
}

/** Pick a sensible starting language: a preferred code, else the OS locale. */
export function pickDefault(preferred) {
  const codes = Object.keys(available);
  if (preferred && codes.includes(preferred)) return preferred;
  const sys = (navigator.language || "").slice(0, 2).toLowerCase();
  if (codes.includes(sys)) return sys;
  return codes.includes(FALLBACK) ? FALLBACK : codes[0] || FALLBACK;
}

/** Switch the active language: loads its file and re-applies static markup. */
export async function setLanguage(code) {
  try {
    const res = await fetch(`locales/${code}.json`);
    if (!res.ok) throw new Error(`locale ${code} not found`);
    dict = await res.json();
    current = code;
    document.documentElement.lang = code;
    applyTranslations();
    return true;
  } catch {
    return false;
  }
}

/** Translate a key, substituting {var} placeholders from `vars`. */
export function t(key, vars) {
  let s = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

/** Apply translations to every tagged element under `root`. */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  }
}
