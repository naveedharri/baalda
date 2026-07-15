//! Baalda — desktop Rust core (Phase 0).
//! Rust owns all disk I/O; the React UI talks to it through the typed commands
//! registered here and reacts to `file-changed` / `vault-opened` events.

pub mod attachments;
mod commands;
mod error;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Updater is desktop-only; register it here so mobile builds skip it.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pick_vault,
            commands::open_vault,
            commands::get_last_vault,
            commands::list_tree,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::rename_path,
            commands::delete_path,
            commands::search_notes,
            commands::get_backlinks,
            commands::get_note_meta,
            commands::resolve_wikilink,
            commands::list_note_titles,
            commands::append_yjs_update,
            commands::load_yjs_state,
            commands::save_yjs_snapshot,
            commands::read_binary_file,
            commands::write_binary_file,
            commands::list_attachments,
            commands::get_server_url,
            commands::set_server_url,
            commands::get_workspace_root,
            commands::set_workspace_root,
            commands::pick_workspace_root,
            commands::pick_folder,
            commands::open_workspace_folder,
            commands::get_vault_config,
            commands::set_vault_config,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            oauth::google_oauth_listen,
            oauth::google_oauth_await,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
