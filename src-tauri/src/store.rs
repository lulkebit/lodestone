use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A single Microsoft/Minecraft account. `id` doubles as the prismarine-auth
/// cache key, so the bot can reuse the cached token without re-prompting.
#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub uuid: String,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server_address: String,
    #[serde(default)]
    pub accounts: Vec<Account>,
    /// Selected UI language code (e.g. "de", "en"). `None` lets the frontend
    /// pick a sensible default (OS locale, falling back to English).
    #[serde(default)]
    pub language: Option<String>,
    /// The app version the user last saw the changelog for. Used to decide
    /// whether to surface the "What's new" screen after an update. `None` on a
    /// fresh install (no changelog is shown for a first run).
    #[serde(default)]
    pub last_seen_version: Option<String>,
    /// Whether to load (and locally cache) Minecraft head avatars from
    /// mc-heads.net. Turning it off keeps every UUID on this machine. Defaults
    /// to on, including for configs written before this field existed.
    #[serde(default = "default_true")]
    pub show_avatars: bool,
    /// Recently used server addresses, most-recent first, for the quick-pick
    /// list under the server field. Capped at [`HISTORY_MAX`].
    #[serde(default)]
    pub server_history: Vec<String>,
}

/// How many recent servers to keep in [`Config::server_history`].
const HISTORY_MAX: usize = 8;

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_address: String::new(),
            accounts: Vec::new(),
            language: None,
            last_seen_version: None,
            show_avatars: true,
            server_history: Vec::new(),
        }
    }
}

/// Persists the account list + server address as JSON in the app config dir.
pub struct Store {
    path: PathBuf,
    pub config: Mutex<Config>,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let config = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            config: Mutex::new(config),
        }
    }

    /// Persist the config atomically: serialize, write a sibling temp file, then
    /// rename it over the real one. The rename is atomic on the same filesystem,
    /// so a crash mid-write leaves the previous config intact instead of a
    /// half-written (corrupt) `config.json`.
    pub fn save(&self) {
        let json = {
            let cfg = self.config.lock();
            match serde_json::to_string_pretty(&*cfg) {
                Ok(j) => j,
                Err(_) => return,
            }
        };
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    /// Record `address` as the most-recently-used server: move it to the front,
    /// drop duplicates, and cap the list. A no-op for blank input. Persists.
    pub fn push_history(&self, address: &str) {
        let address = address.trim();
        if address.is_empty() {
            return;
        }
        {
            let mut cfg = self.config.lock();
            cfg.server_history.retain(|s| s != address);
            cfg.server_history.insert(0, address.to_string());
            cfg.server_history.truncate(HISTORY_MAX);
        }
        self.save();
    }

    // --- Reads ---------------------------------------------------------------

    pub fn server_address(&self) -> String {
        self.config.lock().server_address.clone()
    }

    /// The selected UI language code, if the user has chosen one.
    pub fn language(&self) -> Option<String> {
        self.config.lock().language.clone()
    }

    pub fn account_exists(&self, id: &str) -> bool {
        self.config.lock().accounts.iter().any(|a| a.id == id)
    }

    pub fn account_username(&self, id: &str) -> Option<String> {
        self.config
            .lock()
            .accounts
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.username.clone())
    }

    pub fn selected_ids(&self) -> Vec<String> {
        self.config
            .lock()
            .accounts
            .iter()
            .filter(|a| a.selected)
            .map(|a| a.id.clone())
            .collect()
    }

    // --- Mutations (each persists) ------------------------------------------
    //
    // Command handlers call these instead of locking `config` and saving by
    // hand, so the lock-then-save dance lives in one place. Each mutation drops
    // its lock guard before `save()` re-acquires it (parking_lot is not
    // reentrant), which is why the multi-statement ones use an inner block.

    pub fn set_server(&self, address: String) {
        self.config.lock().server_address = address;
        self.save();
    }

    pub fn set_language(&self, language: String) {
        self.config.lock().language = Some(language);
        self.save();
    }

    pub fn set_show_avatars(&self, enabled: bool) {
        self.config.lock().show_avatars = enabled;
        self.save();
    }

    pub fn set_selected(&self, id: &str, selected: bool) {
        if let Some(a) = self.config.lock().accounts.iter_mut().find(|a| a.id == id) {
            a.selected = selected;
        }
        self.save();
    }

    pub fn set_all_selected(&self, selected: bool) {
        for a in self.config.lock().accounts.iter_mut() {
            a.selected = selected;
        }
        self.save();
    }

    /// Reorder accounts to match `ids` (new top-to-bottom order). Ids missing
    /// from `ids` keep their relative order at the end, so a stale list from the
    /// UI can't drop accounts.
    pub fn reorder(&self, ids: &[String]) {
        self.config
            .lock()
            .accounts
            .sort_by_key(|a| ids.iter().position(|id| id == &a.id).unwrap_or(usize::MAX));
        self.save();
    }

    /// Remove the account with `id`, returning its uuid (so the caller can drop
    /// the matching cached avatar). `None` if there was no such account.
    pub fn remove_account(&self, id: &str) -> Option<String> {
        let uuid = {
            let mut cfg = self.config.lock();
            let uuid = cfg.accounts.iter().find(|a| a.id == id).map(|a| a.uuid.clone());
            cfg.accounts.retain(|a| a.id != id);
            uuid
        };
        self.save();
        uuid
    }

    /// Insert a freshly signed-in account, or, if one with the same `uuid`
    /// already exists, update its id and username in place.
    pub fn upsert_account(&self, id: &str, username: &str, uuid: &str) {
        {
            let mut cfg = self.config.lock();
            if let Some(acc) = cfg.accounts.iter_mut().find(|a| a.uuid == uuid) {
                acc.id = id.to_string();
                acc.username = username.to_string();
            } else {
                cfg.accounts.push(Account {
                    id: id.to_string(),
                    username: username.to_string(),
                    uuid: uuid.to_string(),
                    selected: true,
                });
            }
        }
        self.save();
    }

    /// Record `current` as the version whose changelog the user has now seen.
    /// Returns whether it differs from the previously seen one, i.e. whether the
    /// "What's new" screen should be shown.
    pub fn mark_version_seen(&self, current: &str) -> bool {
        let show = {
            let mut cfg = self.config.lock();
            let show = matches!(&cfg.last_seen_version, Some(v) if v != current);
            cfg.last_seen_version = Some(current.to_string());
            show
        };
        self.save();
        show
    }
}
