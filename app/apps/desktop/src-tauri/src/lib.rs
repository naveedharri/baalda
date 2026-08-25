//! Baalda — desktop Rust core (Phase 0).
//! Rust owns all disk I/O; the React UI talks to it through the typed commands
//! registered here and reacts to `file-changed` / `vault-opened` events.

pub mod attachments;
mod commands;
mod error;
pub mod import_export;
pub mod index;
pub mod keychain;
pub mod notefile;
pub mod oauth;
pub mod parse;
mod state;
pub mod tree;
pub mod vault;
mod watcher;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
            commands::write_note,
            commands::write_note_if_missing,
            commands::create_note,
            commands::create_folder,
            commands::ensure_folder,
            commands::rename_path,
            commands::delete_path,
            commands::delete_folder_if_empty,
            commands::trash_note,
            commands::search_notes,
            commands::get_backlinks,
            commands::graph_edges,
            commands::get_note_meta,
            commands::resolve_wikilink,
            commands::list_note_titles,
            commands::append_yjs_update,
            commands::load_yjs_state,
            commands::save_yjs_snapshot,
            commands::save_yjs_state_vectors,
            commands::list_yjs_state_vectors,
            commands::read_binary_file,
            commands::write_binary_file,
            commands::list_attachments,
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
            commands::peek_vault_config,
            commands::list_vaults_root_dirs,
            commands::get_vault_config,
            commands::set_vault_config,
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
