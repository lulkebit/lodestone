mod engine;
mod store;
mod updater;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use engine::{Engine, StatusInfo};
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
        let statuses = st.statuses.lock().unwrap();
        statuses.values().filter(|s| s.status == "connected").count()
    };
    let label = format!("{online} online");
    if let Some(item) = app
        .try_state::<TrayState>()
        .and_then(|ts| ts.status_item.lock().unwrap().clone())
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
}

#[tauri::command]
fn get_state(state: State<AppState>) -> StateView {
    let cfg = state.store.config.lock().unwrap();
    let statuses = state.statuses.lock().unwrap();
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
    }
}

#[tauri::command]
fn set_language(state: State<AppState>, language: String) {
    state.store.config.lock().unwrap().language = Some(language);
    state.store.save();
}

#[tauri::command]
fn set_server(state: State<AppState>, address: String) {
    state.store.config.lock().unwrap().server_address = address;
    state.store.save();
}

#[tauri::command]
fn set_selected(state: State<AppState>, id: String, selected: bool) {
    if let Some(a) = state
        .store
        .config
        .lock()
        .unwrap()
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
    for a in state.store.config.lock().unwrap().accounts.iter_mut() {
        a.selected = selected;
    }
    state.store.save();
}

#[tauri::command]
async fn add_account(state: State<'_, AppState>) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    state.engine.start_login(id).await;
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
    {
        let mut cfg = state.store.config.lock().unwrap();
        cfg.accounts.retain(|a| a.id != id);
    }
    state.statuses.lock().unwrap().remove(&id);
    state.store.save();
    Ok(())
}

#[tauri::command]
async fn start_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let address = {
        let cfg = state.store.config.lock().unwrap();
        if !cfg.accounts.iter().any(|a| a.id == id) {
            return Err("error.accountNotFound".into());
        }
        cfg.server_address.clone()
    };
    if address.trim().is_empty() {
        return Err("error.noServer".into());
    }
    state.engine.start_bot(id, address).await;
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
        let cfg = state.store.config.lock().unwrap();
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
        state.engine.start_bot(id, address.clone()).await;
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

/// In a bundled app the sidecar ships as a resource; in dev it lives next to
/// the crate. Prefer the resource, fall back to the source tree.
fn resolve_sidecar_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("sidecar");
        if p.join("bot-worker.mjs").exists() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
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

            let store = Arc::new(Store::load(dir.join("config.json")));
            let statuses = Arc::new(Mutex::new(HashMap::new()));
            let sidecar = resolve_sidecar_dir(&handle);
            let engine = Engine::new(
                handle.clone(),
                store.clone(),
                statuses.clone(),
                sidecar.join("login.mjs"),
                sidecar.join("bot-worker.mjs"),
                cache_dir,
            );

            app.manage(AppState {
                store,
                engine,
                statuses,
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
