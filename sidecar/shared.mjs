// Shared helpers for the lodestone Node sidecars (login.mjs + bot-worker.mjs).

import prismarineAuth from "prismarine-auth";
const { Titles } = prismarineAuth;

// Keep stdout pure protocol JSON — redirect stray console.log to stderr.
console.log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");

export const MC_VERSION = "1.21.11";

// Matches mineflayer's own defaults for Minecraft Java device-code auth.
// The Java title does NOT permit the device-code flow (→ 403); the Nintendo
// Switch title is the standard, working approach.
export const AUTH_OPTS = {
  authTitle: Titles.MinecraftNintendoSwitch,
  flow: "live",
  deviceType: "Nintendo",
};

/** Write one newline-delimited protocol JSON object to stdout. */
export function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Exit when the parent (Rust) closes our stdin pipe — avoids orphan processes. */
export function exitWithParent(onExit) {
  const quit = () => {
    try {
      onExit?.();
    } catch {}
    process.exit(0);
  };
  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  process.stdin.resume();
}

export function parseAddress(addr) {
  addr = String(addr || "")
    .trim()
    .replace(/^\w+:\/\//, "");
  const v6 = addr.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : undefined };
  const idx = addr.lastIndexOf(":");
  if (idx !== -1) {
    const portStr = addr.slice(idx + 1);
    if (/^\d+$/.test(portStr)) {
      return { host: addr.slice(0, idx), port: Number(portStr) };
    }
  }
  return { host: addr, port: undefined };
}

export function reasonText(r) {
  if (r == null) return "";
  if (typeof r === "string") {
    try {
      return reasonText(JSON.parse(r));
    } catch {
      return r;
    }
  }
  let out = r.text || "";
  if (r.translate) out += r.translate;
  if (Array.isArray(r.extra)) out += r.extra.map(reasonText).join("");
  if (Array.isArray(r.with)) out += " " + r.with.map(reasonText).join(" ");
  return out.trim();
}
