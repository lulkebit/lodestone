//! Secure at-rest storage for each account's Microsoft refresh token.
//!
//! Tokens are kept in the operating system's credential store (Keychain on
//! macOS, Credential Manager on Windows, the Secret Service on Linux) through
//! the `keyring` crate, instead of sitting in a plaintext JSON file. Builds
//! before this change wrote `<id>.json` files into the auth-cache directory; the
//! first time an account is read we migrate that file into the keychain and
//! delete it.
//!
//! If the platform keychain is unavailable (for example a headless Linux box
//! with no Secret Service running), we fall back to a file in the same auth-cache
//! directory with owner-only permissions, so the app keeps working instead of
//! locking the user out of their accounts.

use std::path::{Path, PathBuf};

use keyring::Entry;

/// Keychain service name. Each account's id is the per-entry key.
const SERVICE: &str = "com.lodestone.app";

pub struct SecretStore {
    /// Auth-cache directory: home of legacy plaintext files and of the
    /// owner-only fallback used when no keychain is reachable.
    dir: PathBuf,
}

impl SecretStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn entry(id: &str) -> keyring::Result<Entry> {
        Entry::new(SERVICE, id)
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Read the stored secret for `id`. Tries the keychain first; if the only
    /// copy is a legacy plaintext file, migrates it into the keychain.
    pub fn load(&self, id: &str) -> Option<String> {
        match Self::entry(id).and_then(|e| e.get_password()) {
            Ok(s) => Some(s),
            Err(keyring::Error::NoEntry) => self.migrate_file(id),
            // Keychain unreachable: fall back to a plaintext file if present.
            Err(_) => self.read_file(id),
        }
    }

    /// Persist the secret for `id`. Prefers the keychain; on failure writes an
    /// owner-only file so headless setups still work.
    pub fn save(&self, id: &str, secret: &str) -> anyhow::Result<()> {
        match Self::entry(id).and_then(|e| e.set_password(secret)) {
            Ok(()) => {
                // The keychain is now authoritative; drop any leftover file.
                let _ = std::fs::remove_file(self.file(id));
                Ok(())
            }
            Err(_) => write_private(&self.file(id), secret),
        }
    }

    /// Forget the secret for `id`, in both the keychain and on disk.
    pub fn delete(&self, id: &str) {
        if let Ok(e) = Self::entry(id) {
            let _ = e.delete_credential();
        }
        let _ = std::fs::remove_file(self.file(id));
    }

    fn read_file(&self, id: &str) -> Option<String> {
        std::fs::read_to_string(self.file(id)).ok()
    }

    /// Move a legacy plaintext file into the keychain, returning its contents.
    /// The file is removed only once the keychain write succeeds.
    fn migrate_file(&self, id: &str) -> Option<String> {
        let secret = self.read_file(id)?;
        if Self::entry(id).and_then(|e| e.set_password(&secret)).is_ok() {
            let _ = std::fs::remove_file(self.file(id));
        }
        Some(secret)
    }
}

/// Write `contents` to `path` with owner-only permissions (0600 on Unix).
fn write_private(path: &Path, contents: &str) -> anyhow::Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
