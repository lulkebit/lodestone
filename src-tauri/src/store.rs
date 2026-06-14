use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

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

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub server_address: String,
    #[serde(default)]
    pub accounts: Vec<Account>,
    /// The app version the user last saw the changelog for. Used to decide
    /// whether to surface the "What's new" screen after an update. `None` on a
    /// fresh install (no changelog is shown for a first run).
    #[serde(default)]
    pub last_seen_version: Option<String>,
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
        let cfg = self.config.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*cfg) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}
