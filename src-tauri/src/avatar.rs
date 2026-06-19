//! Locally cached Minecraft head avatars.
//!
//! Each skin head is fetched from mc-heads.net once and cached on disk as
//! `<uuid>.png`, so a UUID leaves this machine at most once and avatars keep
//! working offline afterwards. The fetch uses the app's shared HTTP client,
//! which carries a timeout so a slow (or unresponsive) avatar host can't hang
//! the `get_avatar` command forever.

use std::path::{Path, PathBuf};

use base64::Engine as _;

/// UUIDs are hex; keep only alphanumerics so a crafted value can't escape `dir`.
fn safe_name(uuid: &str) -> String {
    uuid.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Return the head for `uuid` as a `data:` URL, fetching and caching it on first
/// use. Subsequent calls read the cached PNG straight off disk.
pub async fn fetch(http: &reqwest::Client, dir: PathBuf, uuid: String) -> anyhow::Result<String> {
    let safe = safe_name(&uuid);
    if safe.is_empty() {
        anyhow::bail!("invalid uuid");
    }
    let file = dir.join(format!("{safe}.png"));
    let bytes = match std::fs::read(&file) {
        Ok(b) if !b.is_empty() => b,
        _ => {
            let url = format!("https://mc-heads.net/avatar/{safe}/64");
            let bytes = http.get(&url).send().await?.error_for_status()?.bytes().await?;
            std::fs::create_dir_all(&dir).ok();
            let _ = std::fs::write(&file, &bytes);
            bytes.to_vec()
        }
    };
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Drop the cached avatar for `uuid` (called when an account is removed).
pub fn remove(dir: &Path, uuid: &str) {
    let safe = safe_name(uuid);
    if !safe.is_empty() {
        let _ = std::fs::remove_file(dir.join(format!("{safe}.png")));
    }
}
