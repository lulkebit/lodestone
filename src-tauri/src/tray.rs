//! System tray: keeps bots reachable while the window is hidden, mirrors the
//! live online-bot count, and offers start/stop/quit without showing the window.

use parking_lot::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::commands::start_selected_internal;
use crate::engine::Status;
use crate::{AppState, TrayState};

/// Bring the main window back to the foreground (from the tray or the dock).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Refresh the tray tooltip and status line with the live online-bot count.
pub fn update(app: &AppHandle) {
    let online = {
        let st = app.state::<AppState>();
        let statuses = st.statuses.lock();
        statuses
            .values()
            .filter(|s| s.status == Status::Connected)
            .count()
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

/// Build the tray icon and menu. Called once during setup.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status_item = MenuItemBuilder::with_id("status", "0 online")
        .enabled(false)
        .build(app)?;
    let show_item = MenuItemBuilder::with_id("show", "Show lodestone").build(app)?;
    let start_item = MenuItemBuilder::with_id("start_selected", "Start selected").build(app)?;
    let stop_item = MenuItemBuilder::with_id("stop_all", "Disconnect all").build(app)?;
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

    Ok(())
}
