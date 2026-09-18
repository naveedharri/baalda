//! Baalda — desktop Rust core (Phase 0).
//! Rust owns all disk I/O; the React UI talks to it through the typed commands
//! registered here and reacts to `files-changed` / `vault-opened` events.

pub mod attachments;
pub mod checks;
// `pub` so the integration tests can drive the batch appliers
// (`apply_bootstrap_entries`, `materialize_notes`) directly: they are the whole
// policy of the bulk sync path — the eligibility table, the path allowlist —
// and the `#[tauri::command]` wrappers around them are only frame decoding.
pub mod commands;
mod error;
pub mod extract;
pub mod extract_worker;
pub mod import_export;
pub mod index;
pub mod keychain;
pub mod notefile;
pub mod oauth;
pub mod parse;
mod state;
pub mod stats;
pub mod tree;
pub mod vault;
mod watcher;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Open the main window at a size that suits the screen it lands on: about
/// 79% × 88% of the monitor's work area, centered, never smaller than the
/// 1200×800 in `tauri.conf.json` unless the screen itself is, and capped so a
/// 5K display does not get a 4,000-pixel-wide editor. The config's fixed
/// 1200×800 was right for a laptop and opened as a small box in the middle of
/// a 27" display. Logical pixels throughout, so Retina scaling is handled.
#[cfg(desktop)]
fn fit_window_to_screen(win: &tauri::WebviewWindow) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => win.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return;
    }
    let area = monitor.work_area();
    let avail_w = area.size.width as f64 / scale;
    let avail_h = area.size.height as f64 / scale;
    let floor_w = 1200.0_f64.min(avail_w);
    let floor_h = 800.0_f64.min(avail_h);
    let w = (avail_w * 0.79).clamp(floor_w, 2000.0_f64.max(floor_w));
    let h = (avail_h * 0.88).clamp(floor_h, 1400.0_f64.max(floor_h));
    if let Err(e) = win.set_size(tauri::LogicalSize::new(w, h)) {
        log::warn!("[window] could not size the window to the screen: {e}");
        return;
    }
    let _ = win.center();
    log::info!("[window] sized to {w:.0}×{h:.0} on a {avail_w:.0}×{avail_h:.0} work area");
}

pub fn run() {
    let builder = tauri::Builder::default();

    // Single-instance FIRST, and only on desktop. Without it, clicking a
    // `baalda://` link on Windows/Linux spawns a SECOND copy of the app with
    // the URL as an argv entry — two windows, two vault locks, one confused
    // user. With it the running instance is handed the URL and the duplicate
    // exits. On macOS the OS already routes links to the running app; the
    // plugin is harmless there and keeps one code path.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));

    // The UI's own log. A `console.log` inside a WKWebView goes to the Web
    // Inspector and nowhere else, so anything the React layer measures about
    // itself is invisible to whoever is reading `tauri dev` — which is how two
    // wrong diagnoses of "the sidebar blinks while it syncs" survived as long as
    // they did. The frontend's `@tauri-apps/plugin-log` calls land next to the
    // Rust ones, so both halves of a symptom read as one timeline.
    //
    // Note `targets()`, not `target()`: the latter APPENDS to the plugin's
    // defaults (Stdout + LogDir), so the old `.target(Stdout)` here was really
    // "stdout twice, plus a file" rather than the stdout-only it reads as.
    //
    // Debug: the terminal, which is where a developer already is.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .targets([tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            )])
            .build(),
    );

    // Release: a rotating FILE, because a shipped app's stdout goes nowhere —
    // on Windows there is no console attached at all. Without it, a user whose
    // vault refused to open (#128) had nothing to send us but a screenshot of
    // the dialog, and the errors that matter most are the ones that happen on
    // machines we cannot reproduce.
    //
    //   macOS   ~/Library/Logs/com.baalda.context/baalda.log
    //   Windows %LOCALAPPDATA%\com.baalda.context\logs\baalda.log
    //   Linux   ~/.local/share/com.baalda.context/logs/baalda.log
    //
    // Bounded on purpose: 2 MB per file, KeepOne (the rotated file replaces the
    // previous one), so the app can never cost more than ~4 MB of disk here. At
    // `Info` this is app lifecycle plus every warn/error — including the
    // `io_ctx` failures from error.rs, which log themselves on the way to the
    // UI, so a failed open is in the file whether or not the user reports it.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .max_file_size(2_000_000)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
            .targets([
                // Kept so `open -a Baalda` / a terminal launch still shows the
                // same lines live; it is a no-op where nothing is attached.
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("baalda".into()),
                }),
            ])
            .build(),
    );

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        // Native clipboard: the webview's navigator.clipboard is tied to
        // WebKit's transient user activation, which an await (e.g. minting a
        // share link) outlives — a native call has no such rule.
        .plugin(tauri_plugin_clipboard_manager::init())
        // `baalda://` links. A teammate pastes one into chat; clicking it hands
        // the URL to this app, which resolves it against the *recipient's* own
        // account and access — the link carries ids, never content or a grant.
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Updater is desktop-only; register it here so mobile builds skip it.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            // Dev/Linux need a runtime registration: on macOS and Windows the
            // scheme comes from the bundle, which `tauri dev` never builds, so
            // without this a link is unopenable in development.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            // The window starts hidden (`visible: false` in tauri.conf.json) so
            // nobody watches an empty frame while the bundle parses; the
            // frontend calls show() on its first paint. This is the dead-man's
            // switch: if the webview never gets that far — a JS crash, a broken
            // bundle — the window still appears, with whatever the webview
            // managed to render, instead of the app running invisibly. Tauri v2
            // window methods are callable off the main thread and show() on a
            // visible window is a no-op, so this needs no coordination.
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                // While it is still hidden, so the first frame is already the
                // right size — resizing after reveal would visibly jump.
                fit_window_to_screen(&win);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    if win.is_visible().unwrap_or(false) {
                        return;
                    }
                    log::warn!(
                        "[window] frontend never revealed the window in 1500ms; showing it anyway"
                    );
                    let _ = win.show();
                    let _ = win.set_focus();
                });
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pick_vault,
            commands::open_vault,
            commands::get_last_vault,
            commands::clear_last_vault,
            commands::get_recent_vaults,
            commands::remove_recent_vault,
            commands::delete_vault,
            commands::create_vault,
            commands::is_vault,
            commands::list_tree,
            commands::list_children,
            commands::read_note,
            commands::note_exists,
            commands::write_trash_copy,
            commands::rebind_note_id,
            commands::write_note,
            commands::write_note_if_missing,
            commands::materialize_notes_batch,
            commands::apply_bootstrap_batch,
            commands::create_note,
            commands::create_folder,
            commands::ensure_folder,
            commands::rename_path,
            commands::delete_path,
            commands::delete_file,
            commands::delete_folder_if_empty,
            commands::trash_note,
            commands::search_notes,
            commands::get_file_text,
            commands::list_file_rows,
            commands::get_backlinks,
            commands::graph_edges,
            commands::graph_edges_for,
            commands::get_note_meta,
            commands::resolve_wikilink,
            commands::list_note_titles,
            commands::append_yjs_update,
            commands::load_yjs_state,
            commands::save_yjs_snapshot,
            commands::save_yjs_state_vectors,
            commands::list_yjs_state_vectors,
            commands::prune_yjs_docs,
            commands::clear_yjs_doc,
            commands::read_binary_file,
            commands::file_stat,
            commands::write_binary_file,
            commands::write_tree_binary,
            commands::list_attachments,
            commands::list_binaries,
            commands::upload_attachment,
            commands::download_attachment,
            commands::vault_stats,
            commands::vault_checks,
            commands::empty_trash,
            commands::rebuild_index,
            commands::read_external_file,
            commands::get_server_url,
            commands::set_server_url,
            commands::get_vaults_root,
            commands::set_vaults_root,
            commands::pick_vaults_root,
            commands::pick_folder,
            commands::pick_files,
            commands::save_file,
            commands::import_paths,
            commands::export_path,
            commands::open_vault_in_root,
            commands::folder_exists,
            commands::peek_vault_stamp,
            commands::list_vaults_root_dirs,
            commands::get_vault_config,
            commands::set_vault_config,
            commands::get_vault_types,
            commands::set_vault_types,
            commands::list_property_keys,
            commands::list_property_values,
            commands::list_tags,
            commands::get_note_ui_state,
            commands::set_note_ui_state,
            commands::get_vault_epoch,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            oauth::google_oauth_listen,
            oauth::google_oauth_await,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
