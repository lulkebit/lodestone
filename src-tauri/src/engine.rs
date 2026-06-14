use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::store::{Account, Store};

/// Live (non-persisted) connection state for an account, keyed by account id.
#[derive(Clone, Default)]
pub struct StatusInfo {
    pub status: String,
    pub connected_at: Option<i64>,
}

/// Spawns one Node process per bot (real per-account CPU/RAM) plus a short-lived
/// process per Microsoft login. Bridges each child's stdout to the frontend.
pub struct Engine {
    app: AppHandle,
    store: Arc<Store>,
    statuses: Arc<Mutex<HashMap<String, StatusInfo>>>,
    bots: Arc<Mutex<HashMap<String, Child>>>,
    login: Arc<Mutex<Option<Child>>>,
    node: String,
    login_script: PathBuf,
    worker_script: PathBuf,
    cache_dir: PathBuf,
}

/// Locate a usable `node` binary.
///
/// A bundled GUI app does not inherit the user's shell `PATH` (on macOS launchd
/// hands it only `/usr/bin:/bin:/usr/sbin:/sbin`), so a Homebrew/nvm install is
/// invisible and a bare `node` spawn fails with ENOENT. We therefore probe the
/// usual locations and, as a last resort, ask the user's login shell.
fn resolve_node() -> String {
    // 1. Explicit override always wins.
    if let Ok(p) = std::env::var("LODESTONE_NODE") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            return p;
        }
    }

    // On Windows the system PATH is inherited by GUI apps, so a plain lookup works.
    #[cfg(not(windows))]
    {
        // 2. Common absolute install locations.
        for c in [
            "/opt/homebrew/bin/node", // Apple Silicon Homebrew
            "/usr/local/bin/node",    // Intel Homebrew / nodejs.org pkg
            "/usr/bin/node",          // Linux distro packages
        ] {
            if std::path::Path::new(c).exists() {
                return c.to_string();
            }
        }
        // 3. Ask the user's login shell (covers nvm / fnm / volta / asdf).
        if let Some(p) = node_from_login_shell() {
            return p;
        }
    }

    // 4. Fall back to a PATH lookup.
    "node".to_string()
}

/// Resolve `node` through the user's interactive login shell so version managers
/// that only configure `PATH` in shell rc files (nvm, fnm, …) are picked up.
#[cfg(not(windows))]
fn node_from_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let out = std::process::Command::new(shell)
        .args(["-lic", "command -v node"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let path = stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()?
        .to_string();
    if std::path::Path::new(&path).exists() {
        Some(path)
    } else {
        None
    }
}

impl Engine {
    pub fn new(
        app: AppHandle,
        store: Arc<Store>,
        statuses: Arc<Mutex<HashMap<String, StatusInfo>>>,
        login_script: PathBuf,
        worker_script: PathBuf,
        cache_dir: PathBuf,
    ) -> Arc<Engine> {
        let node = resolve_node();
        Arc::new(Engine {
            app,
            store,
            statuses,
            bots: Arc::new(Mutex::new(HashMap::new())),
            login: Arc::new(Mutex::new(None)),
            node,
            login_script,
            worker_script,
            cache_dir,
        })
    }

    fn spawn_node(&self, script: &PathBuf, args: &[&str]) -> std::io::Result<Child> {
        let mut cmd = Command::new(&self.node);
        cmd.arg(script);
        for a in args {
            cmd.arg(a);
        }
        // stdin stays piped (and is NOT taken): when this process dies the pipe
        // closes and the child exits itself (see exitWithParent in shared.mjs).
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.spawn()
    }

    /// Forward a child's stderr to our stderr for debugging.
    fn pipe_stderr(&self, child: &mut Child, tag: &'static str) {
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    eprintln!("[{tag}] {l}");
                }
            });
        }
    }

    /// Start the device-code login flow for a fresh account id (cache key).
    pub async fn start_login(&self, id: String) {
        let cache = self.cache_dir.to_string_lossy().to_string();
        let mut child = match self.spawn_node(&self.login_script, &[&id, &cache]) {
            Ok(c) => c,
            Err(e) => {
                let _ = self.app.emit("auth:error", format!("Sidecar-Start fehlgeschlagen: {e}"));
                return;
            }
        };
        self.pipe_stderr(&mut child, "login");
        if let Some(stdout) = child.stdout.take() {
            let (app, store, statuses, login) = (
                self.app.clone(),
                self.store.clone(),
                self.statuses.clone(),
                self.login.clone(),
            );
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    forward_event(&app, &store, &statuses, &line);
                }
                *login.lock().unwrap() = None;
            });
        }
        // Storing replaces (and drops → kills) any previous in-flight login.
        *self.login.lock().unwrap() = Some(child);
    }

    pub fn cancel_login(&self) {
        *self.login.lock().unwrap() = None;
    }

    /// Start a bot for `id` connecting to `address`.
    pub async fn start_bot(&self, id: String, address: String) {
        if self.bots.lock().unwrap().contains_key(&id) {
            return;
        }
        let cache = self.cache_dir.to_string_lossy().to_string();
        let mut child = match self.spawn_node(&self.worker_script, &[&id, &cache, &address]) {
            Ok(c) => c,
            Err(e) => {
                self.set_status(&id, "error", None);
                let _ = self.app.emit(
                    "bot:status",
                    json!({ "id": id, "status": "error", "error": format!("Sidecar-Start fehlgeschlagen: {e}") }),
                );
                return;
            }
        };
        self.pipe_stderr(&mut child, "worker");
        if let Some(stdout) = child.stdout.take() {
            let (app, store, statuses, bots) = (
                self.app.clone(),
                self.store.clone(),
                self.statuses.clone(),
                self.bots.clone(),
            );
            let id2 = id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    forward_event(&app, &store, &statuses, &line);
                }
                // Process exited — drop its handle.
                bots.lock().unwrap().remove(&id2);
            });
        }
        self.bots.lock().unwrap().insert(id, child);
    }

    /// Stop one bot: dropping the Child closes its stdin + kills it (kill_on_drop).
    pub fn stop_bot(&self, id: &str) {
        let _ = self.bots.lock().unwrap().remove(id);
        self.set_status(id, "disconnected", None);
        let _ = self.app.emit(
            "bot:status",
            json!({ "id": id, "status": "disconnected", "connected_at": null, "error": "" }),
        );
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = {
            let mut b = self.bots.lock().unwrap();
            b.drain().map(|(k, _)| k).collect()
        };
        for id in ids {
            self.set_status(&id, "disconnected", None);
            let _ = self.app.emit(
                "bot:status",
                json!({ "id": id, "status": "disconnected", "connected_at": null, "error": "" }),
            );
        }
    }

    fn set_status(&self, id: &str, status: &str, connected_at: Option<i64>) {
        self.statuses.lock().unwrap().insert(
            id.to_string(),
            StatusInfo {
                status: status.to_string(),
                connected_at,
            },
        );
    }
}

/// Parse one stdout line from a sidecar and forward it to the frontend.
fn forward_event(
    app: &AppHandle,
    store: &Store,
    statuses: &Mutex<HashMap<String, StatusInfo>>,
    line: &str,
) {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

    match v.get("event").and_then(|e| e.as_str()) {
        Some("auth_code") => {
            let _ = app.emit(
                "auth:code",
                json!({ "user_code": s("user_code"), "verification_uri": s("verification_uri") }),
            );
        }
        Some("auth_success") => {
            let (id, username, uuid) = (s("id"), s("username"), s("uuid"));
            {
                let mut cfg = store.config.lock().unwrap();
                if let Some(acc) = cfg.accounts.iter_mut().find(|a| a.uuid == uuid) {
                    acc.id = id.clone();
                    acc.username = username.clone();
                } else {
                    cfg.accounts.push(Account {
                        id: id.clone(),
                        username: username.clone(),
                        uuid: uuid.clone(),
                        selected: true,
                    });
                }
            }
            store.save();
            let _ = app.emit(
                "auth:success",
                json!({ "id": id, "username": username, "uuid": uuid }),
            );
        }
        Some("auth_error") => {
            let _ = app.emit("auth:error", s("message"));
        }
        Some("status") => {
            let id = s("id");
            let status = s("status");
            let connected_at = v.get("connected_at").and_then(|x| x.as_i64());
            let attempt = v.get("attempt").and_then(|x| x.as_i64());
            statuses.lock().unwrap().insert(
                id.clone(),
                StatusInfo {
                    status: status.clone(),
                    connected_at,
                },
            );
            let _ = app.emit(
                "bot:status",
                json!({ "id": id, "status": status, "connected_at": connected_at, "error": s("error"), "attempt": attempt }),
            );
        }
        Some("metrics") => {
            let _ = app.emit(
                "bot:metrics",
                json!({
                    "id": s("id"),
                    "cpu": v.get("cpu").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    "mem_mb": v.get("mem_mb").and_then(|x| x.as_f64()).unwrap_or(0.0),
                }),
            );
        }
        _ => {}
    }
}
