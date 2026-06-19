//! Tauri command handlers (the updater's live in `updater.rs`).
//!
//! Each command is a thin wrapper: validate input, then delegate to the `Store`
//! (persistent config), the `Engine` (live bots), or `avatar`. The config-lock
//! plumbing now lives behind `Store` methods, so these stay one-liners.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::avatar;
use crate::engine::{self, Status};
use crate::AppState;

#[derive(Serialize)]
pub struct AccountView {
    id: String,
    username: String,
    uuid: String,
    selected: bool,
    status: Status,
    connected_at: Option<i64>,
}

#[derive(Serialize)]
pub struct StateView {
    server_address: String,
    accounts: Vec<AccountView>,
    language: Option<String>,
    show_avatars: bool,
    server_history: Vec<String>,
}

/// Result of a Server List Ping, surfaced under the server field so the user can
/// see a server is reachable (and on the right version) before connecting.
#[derive(Serialize, Default)]
pub struct ServerStatus {
    online: bool,
    players_online: Option<i64>,
    players_max: Option<i64>,
    version: Option<String>,
    motd: Option<String>,
    /// The server's icon as a `data:` URL, exactly as it sends it (may be absent).
    favicon: Option<String>,
    /// An i18n key describing why the ping failed, when `online` is false.
    error: Option<String>,
}

#[tauri::command]
pub fn get_state(state: State<AppState>) -> StateView {
    let cfg = state.store.config.lock();
    let statuses = state.statuses.lock();
    let accounts = cfg
        .accounts
        .iter()
        .map(|a| {
            let st = statuses.get(&a.id);
            AccountView {
                id: a.id.clone(),
                username: a.username.clone(),
                uuid: a.uuid.clone(),
                selected: a.selected,
                status: st.map(|s| s.status).unwrap_or(Status::Disconnected),
                connected_at: st.and_then(|s| s.connected_at),
            }
        })
        .collect();
    StateView {
        server_address: cfg.server_address.clone(),
        accounts,
        language: cfg.language.clone(),
        show_avatars: cfg.show_avatars,
        server_history: cfg.server_history.clone(),
    }
}

/// Ping a Minecraft server (Server List Ping) and report its status. Resolves
/// SRV records and the default port via azalea, and times out so an unreachable
/// host can't hang the call. Never errors: failures come back as `online: false`
/// with an i18n `error` key, which keeps the UI simple.
#[tauri::command]
pub async fn ping_server(address: String) -> ServerStatus {
    let address = engine::clean_address(&address);
    if address.is_empty() {
        return ServerStatus {
            error: Some("error.noServer".into()),
            ..Default::default()
        };
    }
    let ping = azalea::ping::ping_server(address.as_str());
    match tokio::time::timeout(Duration::from_secs(6), ping).await {
        Ok(Ok(r)) => {
            let motd = r.description.to_string();
            let motd = motd.trim();
            ServerStatus {
                online: true,
                players_online: Some(r.players.online as i64),
                players_max: Some(r.players.max as i64),
                version: Some(r.version.name.clone()),
                motd: (!motd.is_empty()).then(|| motd.to_string()),
                favicon: r.favicon.clone(),
                error: None,
            }
        }
        Ok(Err(_)) => ServerStatus {
            error: Some("server.ping.offline".into()),
            ..Default::default()
        },
        Err(_) => ServerStatus {
            error: Some("server.ping.timeout".into()),
            ..Default::default()
        },
    }
}

#[tauri::command]
pub fn set_language(state: State<AppState>, language: String) {
    state.store.set_language(language);
}

#[tauri::command]
pub fn set_server(state: State<AppState>, address: String) {
    state.store.set_server(address);
}

#[tauri::command]
pub fn set_show_avatars(state: State<AppState>, enabled: bool) {
    state.store.set_show_avatars(enabled);
}

/// Return a Minecraft head for `uuid` as a `data:` URL. The PNG is fetched from
/// mc-heads.net once and cached on disk, so each UUID leaves this machine at
/// most once and avatars keep working offline afterwards.
#[tauri::command]
pub async fn get_avatar(state: State<'_, AppState>, uuid: String) -> Result<String, String> {
    let dir = state.avatar_dir.clone();
    let http = state.http.clone();
    avatar::fetch(&http, dir, uuid).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_selected(state: State<AppState>, id: String, selected: bool) {
    state.store.set_selected(&id, selected);
}

#[tauri::command]
pub fn set_all_selected(state: State<AppState>, selected: bool) {
    state.store.set_all_selected(selected);
}

#[tauri::command]
pub fn reorder_accounts(state: State<AppState>, ids: Vec<String>) {
    state.store.reorder(&ids);
}

#[tauri::command]
pub async fn add_account(state: State<'_, AppState>) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    state.engine.start_login(id);
    Ok(())
}

#[tauri::command]
pub async fn cancel_add_account(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.cancel_login();
    Ok(())
}

#[tauri::command]
pub async fn remove_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.stop_bot(&id);
    let uuid = state.store.remove_account(&id);
    state.statuses.lock().remove(&id);
    // Drop the account's cached sign-in token (keychain + any fallback file)...
    state.secrets.delete(&id);
    // ...and its locally cached avatar.
    if let Some(uuid) = uuid {
        avatar::remove(&state.avatar_dir, &uuid);
    }
    Ok(())
}

#[tauri::command]
pub async fn start_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if !state.store.account_exists(&id) {
        return Err("error.accountNotFound".into());
    }
    let address = state.store.server_address();
    if address.trim().is_empty() {
        return Err("error.noServer".into());
    }
    state.store.push_history(&address);
    state.engine.start_bot(id, address);
    Ok(())
}

#[tauri::command]
pub async fn stop_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.stop_bot(&id);
    Ok(())
}

/// Start every selected account. Shared by the command and the tray menu, so it
/// takes an `AppHandle` rather than a `State` extractor.
pub(crate) async fn start_selected_internal(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let address = state.store.server_address();
    if address.trim().is_empty() {
        return Err("error.noServer".into());
    }
    let ids = state.store.selected_ids();
    state.store.push_history(&address);
    state.engine.start_many(ids, address);
    Ok(())
}

#[tauri::command]
pub async fn start_selected(app: AppHandle) -> Result<(), String> {
    start_selected_internal(&app).await
}

#[tauri::command]
pub async fn stop_all(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop_all();
    Ok(())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
