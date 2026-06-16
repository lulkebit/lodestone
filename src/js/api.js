// Thin wrapper around the Tauri bridge. This is the only module that touches
// `window.__TAURI__`, so the rest of the UI talks to the backend through named
// functions instead of stringly-typed `invoke` calls scattered everywhere.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export { invoke };

/** Subscribe to a backend event, receiving just the payload. */
export const on = (event, cb) => listen(event, (e) => cb(e.payload));

// --- State ---
export const getState = () => invoke("get_state");
export const setServer = (address) => invoke("set_server", { address });
export const setLanguage = (language) => invoke("set_language", { language });
export const setShowAvatars = (enabled) => invoke("set_show_avatars", { enabled });
export const getAvatar = (uuid) => invoke("get_avatar", { uuid });
export const setSelected = (id, selected) => invoke("set_selected", { id, selected });
export const setAllSelected = (selected) => invoke("set_all_selected", { selected });
export const reorderAccounts = (ids) => invoke("reorder_accounts", { ids });
export const pingServer = (address) => invoke("ping_server", { address });

// --- Accounts ---
export const addAccount = () => invoke("add_account");
export const cancelAddAccount = () => invoke("cancel_add_account");
export const removeAccount = (id) => invoke("remove_account", { id });
export const startAccount = (id) => invoke("start_account", { id });
export const stopAccount = (id) => invoke("stop_account", { id });
export const startSelected = () => invoke("start_selected");
export const stopAll = () => invoke("stop_all");

// --- Misc ---
export const openUrl = (url) => invoke("open_url", { url });

// --- Version / updates ---
export const getAppVersion = () => invoke("get_app_version");
export const checkForUpdate = () => invoke("check_for_update");
export const installUpdate = () => invoke("install_update");
export const getWhatsNew = () => invoke("get_whats_new");
export const getChangelog = (version = null) => invoke("get_changelog", { version });
