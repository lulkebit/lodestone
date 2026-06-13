mod engine;
mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use engine::{Engine, StatusInfo};
use serde::Serialize;
use store::Store;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

pub struct AppState {
    store: Arc<Store>,
    engine: Arc<Engine>,
    statuses: Arc<Mutex<HashMap<String, StatusInfo>>>,
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
    }
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
            return Err("Account nicht gefunden".into());
        }
        cfg.server_address.clone()
    };
    if address.trim().is_empty() {
        return Err("Keine Server-Adresse gesetzt".into());
    }
    state.engine.start_bot(id, address).await;
    Ok(())
}

#[tauri::command]
async fn stop_account(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.engine.stop_bot(&id);
    Ok(())
}

#[tauri::command]
async fn start_selected(state: State<'_, AppState>) -> Result<(), String> {
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
        return Err("Keine Server-Adresse gesetzt".into());
    }
    for id in ids {
        state.engine.start_bot(id, address.clone()).await;
    }
    Ok(())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            set_server,
            set_selected,
            set_all_selected,
            add_account,
            cancel_add_account,
            remove_account,
            start_account,
            stop_account,
            start_selected,
            stop_all,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
