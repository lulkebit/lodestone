// One headless Minecraft bot in its own process (→ real per-account CPU/RAM),
// with automatic reconnect on unexpected disconnects.
//   argv: <id> <cacheDir> <address>
// Emits: status (connecting|connected|disconnected|error) and metrics (cpu, mem_mb).
//
// The process stays alive across reconnects. It only exits when the parent (Rust)
// closes our stdin (user stopped it) or when initial connection gives up.

import mineflayer from "mineflayer";
import {
  AUTH_OPTS,
  MC_VERSION,
  send,
  parseAddress,
  reasonText,
  exitWithParent,
} from "./shared.mjs";

const id = process.argv[2];
const cacheDir = process.argv[3];
const address = process.argv[4];
const { host, port } = parseAddress(address);

// Give up only if we never managed to connect (likely ban/whitelist/bad config).
// Once connected at least once, reconnect forever (treat drops as transient).
const MAX_INITIAL_ATTEMPTS = 8;

let currentBot = null;
let connectedAt = null;
let lastError = null;
let afk = null;
let attempts = 0;
let everConnected = false;
let stopping = false;
let lastCpu = process.cpuUsage();
let lastTime = Date.now();

exitWithParent(() => {
  stopping = true;
  try {
    currentBot?.quit();
  } catch {}
});

function status(s, extra = {}) {
  send({ event: "status", id, status: s, ...extra });
}

// Metrics run for the whole process lifetime; the UI only shows them while connected.
setInterval(() => {
  const now = Date.now();
  const delta = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const elapsedUs = (now - lastTime) * 1000;
  lastTime = now;
  const cpuPct = elapsedUs > 0 ? ((delta.user + delta.system) / elapsedUs) * 100 : 0;
  send({
    event: "metrics",
    id,
    cpu: Math.round(cpuPct * 10) / 10,
    mem_mb: Math.round(process.memoryUsage().rss / 1048576),
  });
}, 2000);

function stopAfk() {
  if (afk) {
    clearInterval(afk);
    afk = null;
  }
}

function scheduleReconnect() {
  if (stopping) return;
  attempts++;
  if (!everConnected && attempts > MAX_INITIAL_ATTEMPTS) {
    status("error", {
      error: lastError || "Verbindung nach mehreren Versuchen fehlgeschlagen",
    });
    stopping = true;
    setTimeout(() => process.exit(1), 200);
    return;
  }
  const delay = Math.min(5000 * 2 ** Math.min(attempts - 1, 4), 60000); // 5,10,20,40,60…
  status("connecting", { attempt: attempts, error: lastError || "" });
  setTimeout(connect, delay);
}

function connect() {
  if (stopping) return;
  status("connecting", attempts > 0 ? { attempt: attempts } : {});

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      username: id, // prismarine-auth cache key (matches login.mjs)
      auth: "microsoft",
      profilesFolder: cacheDir,
      version: MC_VERSION,
      ...AUTH_OPTS,
      onMsaCode: (r) =>
        send({
          event: "auth_code",
          user_code: r.user_code,
          verification_uri: r.verification_uri,
        }),
      ...(port ? { port } : {}),
    });
  } catch (e) {
    lastError = e?.message || String(e);
    return scheduleReconnect();
  }
  currentBot = bot;

  bot.once("login", () => {
    everConnected = true;
    attempts = 0;
    connectedAt = Math.floor(Date.now() / 1000);
    lastError = null;
    status("connected", { connected_at: connectedAt });
    stopAfk();
    // Gentle anti-AFK so idle-kick timers keep resetting.
    afk = setInterval(() => {
      try {
        if (!bot.entity) return;
        bot.swingArm();
        bot.look(bot.entity.yaw + (Math.random() - 0.5) * 0.4, bot.entity.pitch, false);
      } catch {}
    }, 45000);
  });

  bot.on("kicked", (reason) => {
    lastError = reasonText(reason) || "Vom Server gekickt";
  });
  bot.on("error", (err) => {
    lastError = err?.message || String(err);
  });

  bot.on("end", (reason) => {
    stopAfk();
    currentBot = null;
    if (stopping) return; // killed by parent → no reconnect
    if (!lastError) lastError = reasonText(reason);
    scheduleReconnect();
  });
}

process.on("uncaughtException", (e) =>
  process.stderr.write("[worker] uncaught " + (e?.stack || e) + "\n")
);

connect();
