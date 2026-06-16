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

    pub fn save(&self) {
        let cfg = self.config.lock();
        if let Ok(json) = serde_json::to_string_pretty(&*cfg) {
            let _ = std::fs::write(&self.path, json);
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
}
