//! Headless Minecraft engine, powered by [azalea] (pure Rust, no Node).
//!
//! All bots run inside this process. azalea drives each client through a Bevy
//! ECS app whose runner uses `tokio::task::spawn_local`, so every bot — and the
//! Microsoft logins — must live on a single thread that owns a `LocalSet`. We
//! spawn that thread once and talk to it over a command channel; the bots emit
//! the same `bot:status` / `auth:*` events the frontend already listens for.
//!
//! Because the bots share one process we can no longer report CPU/RAM per
//! account; a small task samples the whole process instead (`app:metrics`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use azalea::auto_reconnect::AutoReconnectDelay;
use azalea::prelude::*;
use azalea_auth::cache::ExpiringValue;
use azalea_auth::{
    get_minecraft_token, get_ms_auth_token, get_ms_link_code, get_profile, refresh_ms_auth_token,
    AccessTokenResponse, ProfileResponse,
};
use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::time::{interval, sleep};
use tokio_util::sync::CancellationToken;

use crate::secrets::SecretStore;
use crate::store::{Account as StoredAccount, Store};

/// Live (non-persisted) connection state for an account, keyed by account id.
#[derive(Clone, Default)]
pub struct StatusInfo {
    pub status: String,
    pub connected_at: Option<i64>,
}

type Statuses = Arc<Mutex<HashMap<String, StatusInfo>>>;

/// Give up only if we never managed to connect (likely ban/whitelist/bad
/// config). Once connected at least once, reconnect forever.
const MAX_INITIAL_ATTEMPTS: u32 = 8;

/// A connection that lasts at least this long counts as "stable" and resets the
/// unstable-drop counter.
const STABLE_SECS: u64 = 20;

/// If the bot spawns but gets dropped again within `STABLE_SECS` this many times
/// in a row, stop reconnecting and surface an error. This catches servers we can
/// reach but can't stay on (e.g. a protocol/version mismatch that makes azalea
/// disconnect right after joining) instead of looping forever.
const MAX_UNSTABLE_DROPS: u32 = 4;

/// Messages from the Tauri (UI) side to the single Minecraft thread.
enum Cmd {
    StartBot { id: String, address: String },
    StopBot { id: String },
    StopAll,
    StartLogin { id: String },
    CancelLogin,
    /// A bot task finished on its own (gave up / errored). `token` guards against
    /// removing a freshly restarted bot that reuses the same id.
    BotExited { id: String, token: u64 },
}

/// Owns the channel to the Minecraft thread. Cloning is cheap (just the sender).
pub struct Engine {
    cmd_tx: UnboundedSender<Cmd>,
}

impl Engine {
    pub fn new(
        app: AppHandle,
        store: Arc<Store>,
        statuses: Statuses,
        secrets: Arc<SecretStore>,
    ) -> Arc<Engine> {
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        spawn_metrics(app.clone());

        // azalea's ECS runner relies on `spawn_local`, so the whole engine runs
        // on a dedicated current-thread runtime with a LocalSet.
        let tx_for_thread = cmd_tx.clone();
        std::thread::Builder::new()
            .name("lodestone-mc".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build minecraft runtime");
                let local = tokio::task::LocalSet::new();
                local.block_on(
                    &rt,
                    manager(app, store, statuses, secrets, tx_for_thread, cmd_rx),
                );
            })
            .expect("spawn minecraft thread");

        Arc::new(Engine { cmd_tx })
    }

    pub fn start_bot(&self, id: String, address: String) {
        let _ = self.cmd_tx.send(Cmd::StartBot { id, address });
    }

    pub fn stop_bot(&self, id: &str) {
        let _ = self.cmd_tx.send(Cmd::StopBot { id: id.to_string() });
    }

    pub fn stop_all(&self) {
        let _ = self.cmd_tx.send(Cmd::StopAll);
    }

    pub fn start_login(&self, id: String) {
        let _ = self.cmd_tx.send(Cmd::StartLogin { id });
    }

    pub fn cancel_login(&self) {
        let _ = self.cmd_tx.send(Cmd::CancelLogin);
    }
}

/// Per-bot control handle held by the manager.
struct BotHandle {
    stop: CancellationToken,
    token: u64,
}

/// The Minecraft thread's event loop: spawns/stops bot and login tasks.
async fn manager(
    app: AppHandle,
    store: Arc<Store>,
    statuses: Statuses,
    secrets: Arc<SecretStore>,
    cmd_tx: UnboundedSender<Cmd>,
    mut cmd_rx: UnboundedReceiver<Cmd>,
) {
    let mut bots: HashMap<String, BotHandle> = HashMap::new();
    let mut login: Option<tokio::task::JoinHandle<()>> = None;
    let mut next_token: u64 = 0;

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            Cmd::StartBot { id, address } => {
                if bots.contains_key(&id) {
                    continue;
                }
                next_token += 1;
                let token = next_token;
                let stop = CancellationToken::new();
                let secrets2 = secrets.clone();
                let (app2, statuses2, stop2, tx2, id2) = (
                    app.clone(),
                    statuses.clone(),
                    stop.clone(),
                    cmd_tx.clone(),
                    id.clone(),
                );
                tokio::task::spawn_local(async move {
                    run_bot(&app2, &statuses2, &id2, &address, &secrets2, &stop2).await;
                    let _ = tx2.send(Cmd::BotExited { id: id2, token });
                });
                bots.insert(id, BotHandle { stop, token });
            }
            Cmd::StopBot { id } => {
                if let Some(b) = bots.remove(&id) {
                    b.stop.cancel();
                }
                emit_status(&app, &statuses, &id, "disconnected", None, None, None, None);
            }
            Cmd::StopAll => {
                let ids: Vec<String> = bots.keys().cloned().collect();
                for (_, b) in bots.drain() {
                    b.stop.cancel();
                }
                for id in ids {
                    emit_status(&app, &statuses, &id, "disconnected", None, None, None, None);
                }
            }
            Cmd::StartLogin { id } => {
                // Storing replaces (and aborts) any previous in-flight login.
                if let Some(h) = login.take() {
                    h.abort();
                }
                let secrets2 = secrets.clone();
                let (app2, store2) = (app.clone(), store.clone());
                login = Some(tokio::task::spawn_local(async move {
                    run_login(&app2, &store2, &secrets2, &id).await;
                }));
            }
            Cmd::CancelLogin => {
                if let Some(h) = login.take() {
                    h.abort();
                }
            }
            Cmd::BotExited { id, token } => {
                // Only forget it if the entry is still this exact task.
                if bots.get(&id).map(|b| b.token) == Some(token) {
                    bots.remove(&id);
                }
            }
        }
    }
}

/// Run one bot until stopped: authenticate, connect, keep alive with gentle
/// anti-AFK, and reconnect with backoff on drops. Returns when the user stops it
/// or when the initial connection gives up.
async fn run_bot(
    app: &AppHandle,
    statuses: &Statuses,
    id: &str,
    address: &str,
    secrets: &SecretStore,
    stop: &CancellationToken,
) {
    let http = reqwest::Client::new();
    let addr = clean_address(address);
    let mut attempts: u32 = 0;
    let mut ever_connected = false;
    let mut unstable_drops: u32 = 0;
    let mut last_error: Option<String> = None;

    loop {
        let attempt_n = if attempts > 0 { Some(attempts as i64) } else { None };
        emit_status(
            app,
            statuses,
            id,
            "connecting",
            None,
            last_error.as_deref(),
            None,
            attempt_n,
        );

        // 1. Authenticate (refresh the token or show a re-auth dialog as needed)
        //    and build the account azalea will connect with.
        let account = tokio::select! {
            r = ensure_account(&http, secrets, id, app) => r,
            _ = stop.cancelled() => return,
        };
        let account = match account {
            Ok(a) => a,
            Err(e) => {
                last_error = Some(e.to_string());
                if give_up(app, statuses, id, &mut attempts, ever_connected, &last_error) {
                    return;
                }
                if wait_with_stop(stop, backoff_delay(attempts)).await {
                    return;
                }
                continue;
            }
        };

        // 2. Connect.
        let joined = tokio::select! {
            r = Client::join(account, addr.as_str()) => r,
            _ = stop.cancelled() => return,
        };
        let (client, mut rx) = match joined {
            Ok(v) => v,
            Err(e) => {
                last_error = Some(e.to_string());
                if give_up(app, statuses, id, &mut attempts, ever_connected, &last_error) {
                    return;
                }
                if wait_with_stop(stop, backoff_delay(attempts)).await {
                    return;
                }
                continue;
            }
        };

        // lodestone drives reconnection itself (this loop), so switch off azalea's
        // built-in auto-reconnect. Without this, stopping a bot would let azalea
        // silently rejoin the server a few seconds later, behind our back and with
        // no UI status — and it would also fight our own reconnect logic.
        client
            .ecs
            .lock()
            .insert_resource(AutoReconnectDelay::new(Duration::MAX));

        // 3. Stay connected: forward status, run gentle anti-AFK, watch for drops.
        let mut afk = interval(Duration::from_secs(45));
        afk.tick().await; // discard the immediate first tick
        let mut yaw: f32 = 0.0;
        let mut spawned = false;
        let mut spawned_at: Option<Instant> = None;
        let mut reason: Option<String> = None;

        loop {
            tokio::select! {
                _ = stop.cancelled() => {
                    client.disconnect();
                    return;
                }
                _ = afk.tick() => {
                    // A small look turn resets idle-kick timers without moving the
                    // bot off its spot (unlike walking, which could be dangerous).
                    if spawned {
                        yaw = (yaw + 31.0) % 360.0;
                        client.set_direction(yaw, 0.0);
                    }
                }
                ev = rx.recv() => {
                    match ev {
                        None => break, // engine closed the channel: treat as a drop
                        Some(Event::Login) | Some(Event::Spawn) => {
                            if !spawned {
                                spawned = true;
                                spawned_at = Some(Instant::now());
                                ever_connected = true;
                                attempts = 0;
                                last_error = None;
                                emit_status(
                                    app, statuses, id, "connected",
                                    Some(now_secs()), None, None, None,
                                );
                            }
                        }
                        Some(Event::Disconnect(r)) => {
                            reason = r.map(|f| f.to_string()).filter(|s| !s.is_empty());
                            break;
                        }
                        Some(_) => {}
                    }
                }
            }
        }

        client.disconnect();
        if let Some(r) = reason {
            last_error = Some(r);
        }

        // We spawned but got dropped again. If that keeps happening almost
        // immediately, the server is one we can reach but not stay on (often a
        // protocol/version mismatch). Give up with a clear error instead of
        // reconnecting forever; a connection that held for a while resets this.
        if spawned {
            let stable = spawned_at
                .map(|t| t.elapsed().as_secs() >= STABLE_SECS)
                .unwrap_or(false);
            if stable {
                unstable_drops = 0;
            } else {
                unstable_drops += 1;
                if unstable_drops >= MAX_UNSTABLE_DROPS {
                    let err = last_error.as_deref().filter(|s| !s.is_empty());
                    emit_status(
                        app,
                        statuses,
                        id,
                        "error",
                        None,
                        err,
                        Some("bot.error.unstable"),
                        None,
                    );
                    return;
                }
            }
        }

        if give_up(app, statuses, id, &mut attempts, ever_connected, &last_error) {
            return;
        }
        if wait_with_stop(stop, backoff_delay(attempts)).await {
            return;
        }
    }
}

/// Count a failed attempt. If we never connected and have exhausted the initial
/// budget, emit a terminal `error` status and tell the caller to stop.
fn give_up(
    app: &AppHandle,
    statuses: &Statuses,
    id: &str,
    attempts: &mut u32,
    ever_connected: bool,
    last_error: &Option<String>,
) -> bool {
    *attempts += 1;
    if !ever_connected && *attempts > MAX_INITIAL_ATTEMPTS {
        match last_error.as_deref() {
            Some(e) if !e.is_empty() => {
                emit_status(app, statuses, id, "error", None, Some(e), None, None)
            }
            _ => emit_status(
                app,
                statuses,
                id,
                "error",
                None,
                None,
                Some("bot.error.connectFailed"),
                None,
            ),
        }
        true
    } else {
        false
    }
}

/// We cache only the Microsoft refresh token (an `ExpiringValue`). azalea turns
/// it into a Minecraft session and refreshes it as needed; persisting it lets
/// the bot reconnect across restarts without a fresh login. The token lives in
/// the OS keychain via [`SecretStore`], not in a plaintext file.
type CachedMsa = ExpiringValue<AccessTokenResponse>;

fn load_msa(secrets: &SecretStore, id: &str) -> Option<CachedMsa> {
    serde_json::from_str(&secrets.load(id)?).ok()
}

fn save_msa(secrets: &SecretStore, id: &str, msa: &CachedMsa) -> anyhow::Result<()> {
    secrets.save(id, &serde_json::to_string(msa)?)
}

/// Resolve a connectable [`Account`] for `id`: load the cached Microsoft token,
/// refresh it if expired, or (as a last resort) prompt a re-login in the UI.
async fn ensure_account(
    http: &reqwest::Client,
    secrets: &SecretStore,
    id: &str,
    app: &AppHandle,
) -> anyhow::Result<Account> {
    let mut msa = match load_msa(secrets, id) {
        Some(m) => m,
        None => interactive_login(http, secrets, id, app, true).await?,
    };

    // Refresh ourselves (rather than letting azalea do it) so we can persist the
    // rotated token and fall back to a UI re-login when the refresh token died.
    if msa.is_expired() {
        msa = match refresh_ms_auth_token(http, &msa.data.refresh_token, None, None).await {
            Ok(m) => {
                save_msa(secrets, id, &m)?;
                m
            }
            Err(_) => interactive_login(http, secrets, id, app, true).await?,
        };
    }

    Ok(Account::with_microsoft_access_token(msa).await?)
}

/// Run a Microsoft device-code login, surfacing the code in the UI, and cache
/// the Microsoft token so the bot can connect (and later refresh) on its own.
/// Returns the freshly obtained token.
async fn interactive_login(
    http: &reqwest::Client,
    secrets: &SecretStore,
    id: &str,
    app: &AppHandle,
    reauth: bool,
) -> anyhow::Result<CachedMsa> {
    let code = get_ms_link_code(http, None, None).await?;
    // An id on the event marks a re-auth of an existing account (the frontend
    // reopens that account's dialog); the add-account flow sends none.
    let event_id = if reauth { id } else { "" };
    let _ = app.emit(
        "auth:code",
        json!({
            "id": event_id,
            "user_code": code.user_code.clone(),
            "verification_uri": code.verification_uri.clone(),
        }),
    );
    if reauth {
        crate::show_main(app);
    }
    let msa = get_ms_auth_token(http, code, None).await?;
    save_msa(secrets, id, &msa)?;
    Ok(msa)
}

/// Fetch the account's display name and UUID from a Microsoft token.
async fn fetch_profile(http: &reqwest::Client, msa: &CachedMsa) -> anyhow::Result<ProfileResponse> {
    let mc = get_minecraft_token(http, &msa.data.access_token).await?;
    Ok(get_profile(http, &mc.minecraft_access_token).await?)
}

/// Handle "add account": log in interactively, then persist the new account.
async fn run_login(app: &AppHandle, store: &Arc<Store>, secrets: &SecretStore, id: &str) {
    let http = reqwest::Client::new();
    let result = async {
        let msa = interactive_login(&http, secrets, id, app, false).await?;
        fetch_profile(&http, &msa).await
    }
    .await;
    match result {
        Ok(profile) => {
            let uuid = profile.id.simple().to_string();
            let username = profile.name.clone();
            {
                let mut cfg = store.config.lock();
                if let Some(acc) = cfg.accounts.iter_mut().find(|a| a.uuid == uuid) {
                    acc.id = id.to_string();
                    acc.username = username.clone();
                } else {
                    cfg.accounts.push(StoredAccount {
                        id: id.to_string(),
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
        Err(e) => {
            let _ = app.emit("auth:error", e.to_string());
        }
    }
}

/// Update the shared status map, push a `bot:status` event, and refresh the tray.
fn emit_status(
    app: &AppHandle,
    statuses: &Statuses,
    id: &str,
    status: &str,
    connected_at: Option<i64>,
    error: Option<&str>,
    error_key: Option<&str>,
    attempt: Option<i64>,
) {
    statuses.lock().insert(
        id.to_string(),
        StatusInfo {
            status: status.to_string(),
            connected_at,
        },
    );
    let _ = app.emit(
        "bot:status",
        json!({
            "id": id,
            "status": status,
            "connected_at": connected_at,
            "error": error.unwrap_or(""),
            "error_key": error_key.unwrap_or(""),
            "attempt": attempt,
        }),
    );
    crate::update_tray(app);
}

/// Sample whole-process CPU/RAM every 2s and emit it as `app:metrics`.
fn spawn_metrics(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use sysinfo::{get_current_pid, ProcessesToUpdate, System};
        let pid = match get_current_pid() {
            Ok(p) => p,
            Err(_) => return,
        };
        let mut sys = System::new();
        let mut tick = interval(Duration::from_secs(2));
        loop {
            tick.tick().await;
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(proc) = sys.process(pid) {
                let cpu = (proc.cpu_usage() as f64 * 10.0).round() / 10.0;
                let mem_mb = (proc.memory() as f64 / 1_048_576.0).round();
                let _ = app.emit("app:metrics", json!({ "cpu": cpu, "mem_mb": mem_mb }));
            }
        }
    });
}

/// Strip a leading scheme (e.g. `tcp://`) so azalea can resolve `host[:port]`.
fn clean_address(a: &str) -> String {
    let a = a.trim();
    match a.find("://") {
        Some(i) => a[i + 3..].to_string(),
        None => a.to_string(),
    }
}

/// Reconnect backoff: 5, 10, 20, 40, 60… seconds (capped at 60s).
fn backoff_delay(attempts: u32) -> Duration {
    let exp = attempts.saturating_sub(1).min(4);
    let ms = (5000u64 * 2u64.pow(exp)).min(60_000);
    Duration::from_millis(ms)
}

/// Sleep for `dur`, returning early with `true` if the bot was asked to stop.
async fn wait_with_stop(stop: &CancellationToken, dur: Duration) -> bool {
    tokio::select! {
        _ = sleep(dur) => false,
        _ = stop.cancelled() => true,
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
