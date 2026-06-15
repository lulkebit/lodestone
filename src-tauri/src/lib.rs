mod engine;
mod secrets;
mod store;
mod updater;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use engine::{Engine, StatusInfo};
use parking_lot::Mutex;
use secrets::SecretStore;
use serde::Serialize;
use store::Store;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent, Wry};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

pub struct AppState {
    store: Arc<Store>,
    engine: Arc<Engine>,
    statuses: Arc<Mutex<HashMap<String, StatusInfo>>>,
    /// Secure storage for each account's Microsoft refresh token (OS keychain,
    /// with an owner-only file fallback).
    secrets: Arc<SecretStore>,
    /// Where locally cached skin-head avatars live (`<uuid>.png`).
    avatar_dir: PathBuf,
}

/// Holds the tray's status menu item so we can update its text as bots connect.
pub struct TrayState {
    status_item: Mutex<Option<MenuItem<Wry>>>,
}

/// Bring the main window back to the foreground (from the tray).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Refresh the tray tooltip and status line with the live online-bot count.
pub fn update_tray(app: &AppHandle) {
    let online = {
        let st = app.state::<AppState>();
        let statuses = st.statuses.lock();
        statuses.values().filter(|s| s.status == "connected").count()
    };
    let label = format!("{online} online");
    if let Some(item) = app
        .try_state::<TrayState>()
        .and_then(|ts| ts.status_item.lock().clone())
    {
        let _ = item.set_text(&label);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("lodestone: {label}")));
    }
}

#[derive(Serialize)]
struct AccountView {
    id: String,
    username: String,
    uuid: String,
    selected: bool,
    status: String,
    connected_at: Option<i64>,
}

#[derive(Serialize)]
struct StateView {
    server_address: String,
    accounts: Vec<AccountView>,
    language: Option<String>,
    show_avatars: bool,
}

#[tauri::command]
fn get_state(state: State<AppState>) -> StateView {
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
                status: st
                    .map(|s| s.status.clone())
                    .unwrap_or_else(|| "disconnected".into()),
                connected_at: st.and_then(|s| s.connected_at),
            }
        })
        .collect();
    StateView {
        server_address: cfg.server_address.clone(),
        accounts,
        language: cfg.language.clone(),
        show_avatars: cfg.show_avatars,
    }
}

#[tauri::command]
fn set_language(state: State<AppState>, language: String) {
    state.store.config.lock().language = Some(language);
    state.store.save();
}

#[tauri::command]
fn set_server(state: State<AppState>, address: String) {
    state.store.config.lock().server_address = address;
    state.store.save();
}

#[tauri::command]
fn set_show_avatars(state: State<AppState>, enabled: bool) {
    state.store.config.lock().show_avatars = enabled;
    state.store.save();
}

/// Return a Minecraft head for `uuid` as a `data:` URL. The PNG is fetched from
/// mc-heads.net once and cached on disk, so each UUID leaves this machine at
/// most once and avatars keep working offline afterwards.
#[tauri::command]
async fn get_avatar(state: State<'_, AppState>, uuid: String) -> Result<String, String> {
    let dir = state.avatar_dir.clone();
    fetch_avatar(dir, uuid).await.map_err(|e| e.to_string())
}

async fn fetch_avatar(dir: PathBuf, uuid: String) -> anyhow::Result<String> {
    // UUIDs are hex; refuse anything else so it can't escape the cache dir.
    let safe: String = uuid.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if safe.is_empty() {
        anyhow::bail!("invalid uuid");
    }
    let file = dir.join(format!("{safe}.png"));
    let bytes = match std::fs::read(&file) {
        Ok(b) if !b.is_empty() => b,
        _ => {
            let url = format!("https://mc-heads.net/avatar/{safe}/64");
            let bytes = reqwest::get(&url).await?.error_for_status()?.bytes().await?;
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

#[tauri::command]
fn set_selected(state: State<AppState>, id: String, selected: bool) {
    if let Some(a) = state
        .store
        .config
        .lock()
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
    {
        a.selected = selected;
    }
    state.store.save();
}

#[tauri::command]
fn set_all_selected(state: State<AppState>, selected: bool) {
    for a in state.store.config.lock().accounts.iter_mut() {
        a.selected = selected;
    }
    state.store.save();
}

#[tauri::command]
async fn add_account(state: State<'_, AppState>) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    state.engine.start_login(id);
    Ok(())
}

#[tauri::command]
async fn cancel_add_account(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.cancel_login();
    Ok(())
}

#[tauri::command]
async fn remove_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.stop_bot(&id);
    let uuid = {
        let mut cfg = state.store.config.lock();
        let uuid = cfg.accounts.iter().find(|a| a.id == id).map(|a| a.uuid.clone());
        cfg.accounts.retain(|a| a.id != id);
        uuid
    };
    state.statuses.lock().remove(&id);
    // Drop the account's cached sign-in token (keychain + any fallback file).
    state.secrets.delete(&id);
    // ...and its locally cached avatar.
    if let Some(uuid) = uuid {
        let safe: String = uuid.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if !safe.is_empty() {
            let _ = std::fs::remove_file(state.avatar_dir.join(format!("{safe}.png")));
        }
    }
    state.store.save();
    Ok(())
}

#[tauri::command]
async fn start_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let address = {
        let cfg = state.store.config.lock();
        if !cfg.accounts.iter().any(|a| a.id == id) {
            return Err("error.accountNotFound".into());
        }
        cfg.server_address.clone()
    };
    if address.trim().is_empty() {
        return Err("error.noServer".into());
    }
    state.engine.start_bot(id, address);
    Ok(())
}

#[tauri::command]
async fn stop_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.stop_bot(&id);
    Ok(())
}

/// Start every selected account. Shared by the command and the tray menu, so it
/// takes an `AppHandle` rather than a `State` extractor.
async fn start_selected_internal(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (address, ids) = {
        let cfg = state.store.config.lock();
        let ids: Vec<String> = cfg
            .accounts
            .iter()
            .filter(|a| a.selected)
            .map(|a| a.id.clone())
            .collect();
        (cfg.server_address.clone(), ids)
    };
    if address.trim().is_empty() {
        return Err("error.noServer".into());
    }
    for id in ids {
        state.engine.start_bot(id, address.clone());
    }
    Ok(())
}

#[tauri::command]
async fn start_selected(app: AppHandle) -> Result<(), String> {
    start_selected_internal(&app).await
}

#[tauri::command]
async fn stop_all(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop_all();
    Ok(())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = handle
                .path()
                .app_config_dir()
                .expect("could not resolve app config dir");
            std::fs::create_dir_all(&dir).ok();
            let cache_dir = dir.join("auth-cache");
            std::fs::create_dir_all(&cache_dir).ok();
            let avatar_dir = dir.join("avatars");
            std::fs::create_dir_all(&avatar_dir).ok();

            let store = Arc::new(Store::load(dir.join("config.json")));
            let statuses = Arc::new(Mutex::new(HashMap::new()));
            let secrets = Arc::new(SecretStore::new(cache_dir));
            let engine = Engine::new(
                handle.clone(),
                store.clone(),
                statuses.clone(),
                secrets.clone(),
            );

            app.manage(AppState {
                store,
                engine,
                statuses,
                secrets,
                avatar_dir,
            });

            // --- System tray: keep bots reachable while the window is hidden ---
            let status_item = MenuItemBuilder::with_id("status", "0 online")
                .enabled(false)
                .build(app)?;
            let show_item = MenuItemBuilder::with_id("show", "Show lodestone").build(app)?;
            let start_item =
                MenuItemBuilder::with_id("start_selected", "Start selected").build(app)?;
            let stop_item =
                MenuItemBuilder::with_id("stop_all", "Disconnect all").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit lodestone").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&status_item)
                .separator()
                .item(&show_item)
                .item(&start_item)
                .item(&stop_item)
                .separator()
                .item(&quit_item)
                .build()?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("lodestone")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "start_selected" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = start_selected_internal(&app).await;
                        });
                    }
                    "stop_all" => app.state::<AppState>().engine.stop_all(),
                    "quit" => {
                        app.state::<AppState>().engine.stop_all();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            app.manage(TrayState {
                status_item: Mutex::new(Some(status_item)),
            });

            // Closing the window hides it to the tray instead of quitting, so the
            // bots keep running. Use the tray's "Quit" entry to exit fully.
            if let Some(win) = app.get_webview_window("main") {
                let win_for_event = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_for_event.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_server,
            set_language,
            set_show_avatars,
            get_avatar,
            set_selected,
            set_all_selected,
            add_account,
            cancel_add_account,
            remove_account,
            start_account,
            stop_account,
            start_selected,
            stop_all,
            open_url,
            updater::get_app_version,
            updater::check_for_update,
            updater::install_update,
            updater::get_whats_new,
            updater::get_changelog
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // macOS: clicking the dock icon should restore the hidden window.
            // `RunEvent::Reopen` only exists on macOS, so gate it per-platform.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
