// Central UI state plus a tiny subscribe/notify bus. Views subscribe and
// re-render themselves when the state changes; actions mutate the state and
// call `notify()`. No DOM here, so it stays easy to reason about.

export const state = {
  accounts: [], // {id, username, uuid, selected, status, connectedAt, error, errorKey, attempt}
  serverAddress: "",
  serverHistory: [], // recently used servers, most-recent first
  showAvatars: true,
  reauthId: null, // account id currently re-authenticating (expired session)
};

const HISTORY_MAX = 8;

/** Move `addr` to the front of the in-session server history (deduped, capped). */
export function rememberServer(addr) {
  addr = (addr || "").trim();
  if (!addr) return;
  state.serverHistory = [addr, ...state.serverHistory.filter((s) => s !== addr)].slice(
    0,
    HISTORY_MAX
  );
}

const listeners = new Set();

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tell every subscriber the state changed. */
export function notify() {
  for (const fn of listeners) fn();
}

export function findAccount(id) {
  return state.accounts.find((a) => a.id === id);
}

export function countConnected() {
  return state.accounts.filter((a) => a.status === "connected").length;
}

/** Map a backend account record into the shape the UI uses. */
export function toAccount(a) {
  return {
    id: a.id,
    username: a.username,
    uuid: a.uuid,
    selected: a.selected,
    status: a.status || "disconnected",
    connectedAt: a.connected_at ? a.connected_at * 1000 : null,
    error: "",
    errorKey: null,
    attempt: null,
  };
}

/** Apply a status change to one account and notify subscribers. */
export function updateStatus(id, status, extra = {}) {
  const acc = findAccount(id);
  if (!acc) return;
  acc.status = status;
  if ("connectedAt" in extra) acc.connectedAt = extra.connectedAt;
  if ("error" in extra) acc.error = extra.error;
  if ("errorKey" in extra) acc.errorKey = extra.errorKey;
  if ("attempt" in extra) acc.attempt = extra.attempt;
  if (status !== "connected") acc.connectedAt = null;
  if (status !== "connecting") acc.attempt = null;
  notify();
}
