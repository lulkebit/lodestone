mod avatar;
mod commands;
mod engine;
mod secrets;
mod store;
mod tray;
mod updater;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use engine::{Engine, StatusInfo};
use parking_lot::Mutex;
use secrets::SecretStore;
use store::Store;
use tauri::menu::MenuItem;
use tauri::plugin::PermissionState;
use tauri::{Manager, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;

pub struct AppState {
    pub(crate) store: Arc<Store>,
    pub(crate) engine: Arc<Engine>,
    pub(crate) statuses: Arc<Mutex<HashMap<String, StatusInfo>>>,
    /// Secure storage for each account's Microsoft refresh token (OS keychain,
    /// with an owner-only file fallback).
    pub(crate) secrets: Arc<SecretStore>,
    /// Where locally cached skin-head avatars live (`<uuid>.png`).
    pub(crate) avatar_dir: PathBuf,
    /// Shared HTTP client for avatar fetches. Built with a timeout so a slow
    /// avatar host can't hang the `get_avatar` command.
    pub(crate) http: reqwest::Client,
}

/// Holds the tray's status menu item so we can update its text as bots connect.
pub struct TrayState {
    pub(crate) status_item: Mutex<Option<MenuItem<Wry>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
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
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
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
                http,
            });

            // Ask the OS for notification permission up front, so a disconnect
            // alert can show later even with the window hidden to the tray.
            if matches!(
                app.notification().permission_state(),
                Ok(PermissionState::Prompt)
            ) {
                let _ = app.notification().request_permission();
            }

            tray::build(app.handle())?;

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
            commands::get_state,
            commands::set_server,
            commands::set_language,
            commands::set_show_avatars,
            commands::get_avatar,
            commands::set_selected,
            commands::set_all_selected,
            commands::reorder_accounts,
            commands::add_account,
            commands::cancel_add_account,
            commands::remove_account,
            commands::start_account,
            commands::stop_account,
            commands::start_selected,
            commands::stop_all,
            commands::ping_server,
            commands::open_url,
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
                tray::show_main(_app);
            }
        });
}
