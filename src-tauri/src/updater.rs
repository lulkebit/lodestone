//! Auto-update + changelog support.
//!
//! Update checking/installation runs entirely in Rust (the frontend has no
//! bundler, so we can't import the JS updater guest bindings). The webview just
//! `invoke`s these commands and listens for `update:*` events.
//!
//! The changelog is compiled straight into the binary with `include_str!`, so
//! the "What's new" screen works offline and always matches the running build.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::AppState;

/// The project changelog, baked in at build time. Path is relative to this file
/// (`src-tauri/src/updater.rs` → repository root).
const CHANGELOG: &str = include_str!("../../CHANGELOG.md");

#[derive(Serialize)]
pub struct UpdateMeta {
    /// Whether a newer version than the running one is available.
    pub available: bool,
    /// The version offered by the update server (or the current one if none).
    pub version: String,
    /// The currently running version.
    pub current_version: String,
    /// Release notes for the offered version, as provided by the update server.
    pub notes: String,
}

#[derive(Serialize)]
pub struct WhatsNew {
    pub version: String,
    /// The changelog section (Markdown) for `version`.
    pub notes: String,
}

/// Extract the changelog body for a single version from `CHANGELOG.md`.
///
/// Looks for a `## [<version>] …` heading and returns everything up to the next
/// `## [` heading, trimmed. Returns `None` if the version has no section.
fn changelog_for(version: &str) -> Option<String> {
    let header_prefix = format!("## [{version}]");
    let mut collecting = false;
    let mut out: Vec<&str> = Vec::new();

    for line in CHANGELOG.lines() {
        if line.starts_with("## [") {
            if collecting {
                break; // reached the next version's section
            }
            if line.starts_with(&header_prefix) {
                collecting = true; // skip the heading line itself
            }
        } else if collecting {
            out.push(line);
        }
    }

    let body = out.join("\n").trim().to_string();
    if collecting && !body.is_empty() {
        Some(body)
    } else {
        None
    }
}

/// The version this build identifies as (from `tauri.conf.json`).
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Check the update endpoint for a newer release without installing anything.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateMeta, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateMeta {
            available: true,
            version: update.version.clone(),
            current_version: current,
            notes: update.body.clone().unwrap_or_default(),
        }),
        Ok(None) => Ok(UpdateMeta {
            available: false,
            current_version: current.clone(),
            version: current,
            notes: String::new(),
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Download and install the available update, emitting progress, then restart.
///
/// Emits `update:progress` (`{ downloaded, total }`) per chunk and
/// `update:downloaded` once the bytes are in. The process restarts into the new
/// version on success, so this command does not return `Ok` in the happy path.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => return Err("Kein Update verfügbar.".into()),
    };

    let downloaded = Arc::new(AtomicU64::new(0));
    let dl = downloaded.clone();
    let app_progress = app.clone();
    let app_done = app.clone();

    update
        .download_and_install(
            move |chunk: usize, content_len: Option<u64>| {
                let total = dl.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                let _ = app_progress.emit(
                    "update:progress",
                    serde_json::json!({ "downloaded": total, "total": content_len }),
                );
            },
            move || {
                let _ = app_done.emit("update:downloaded", ());
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // Relaunch into the freshly installed version. `restart` diverges.
    app.restart();
}

/// Called once on startup: if the running version differs from the last one the
/// user saw a changelog for, return that changelog so the app can surface it.
/// Records the current version as seen either way.
#[tauri::command]
pub fn get_whats_new(app: AppHandle, state: State<AppState>) -> Option<WhatsNew> {
    let current = app.package_info().version.to_string();
    let show = {
        let mut cfg = state.store.config.lock().unwrap();
        let show = matches!(&cfg.last_seen_version, Some(v) if v != &current);
        cfg.last_seen_version = Some(current.clone());
        show
    };
    state.store.save();

    if show {
        changelog_for(&current).map(|notes| WhatsNew {
            version: current,
            notes,
        })
    } else {
        None
    }
}

/// Return the changelog for a specific version (defaults to the running one).
/// Lets the user re-open "What's new" on demand.
#[tauri::command]
pub fn get_changelog(app: AppHandle, version: Option<String>) -> Option<WhatsNew> {
    let v = version.unwrap_or_else(|| app.package_info().version.to_string());
    changelog_for(&v).map(|notes| WhatsNew { version: v, notes })
}
