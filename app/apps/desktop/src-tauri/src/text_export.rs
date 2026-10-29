//! Save a small text file at a path the person picked in the save dialog
//! (the owner's "Save vault key to file"). Deliberately narrow: trusted main
//! window only, absolute `.txt` paths only, never through a symlink, bounded
//! size. The contents are never logged.
//!
//! Red team 3 hardening:
//! - Never inside a vault folder (the open one, or any folder whose ancestor
//!   holds a `.context` directory): `.txt` is a synced note format, so a key
//!   file saved there would be uploaded to the server and shared with the team.
//! - Written owner-only (0600 on unix) to a fresh temp file beside the target,
//!   then renamed over it: a failed write never truncates the file the person
//!   chose to replace, and a link swapped in after the check is replaced, not
//!   followed.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_TEXT_BYTES: usize = 64 * 1024;

pub fn validate_text_export(path: &Path, contents: &str) -> AppResult<()> {
    if !path.is_absolute() {
        return Err(AppError::new("save path must be absolute"));
    }
    let is_txt = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("txt"))
        .unwrap_or(false);
    if !is_txt {
        return Err(AppError::new("only .txt files can be saved here"));
    }
    if contents.len() > MAX_TEXT_BYTES {
        return Err(AppError::new("text is too large"));
    }
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() || meta.is_dir() {
            return Err(AppError::new("refusing to write through a link or folder"));
        }
    }
    Ok(())
}

/// Refuse a destination inside the open vault or any folder that is a vault
/// (an ancestor holding `.context/`): files there sync to the team.
pub fn refuse_inside_vault(path: &Path, open_vault: Option<&Path>) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("save path has no folder"))?;
    let parent: PathBuf = std::fs::canonicalize(parent)
        .map_err(|_| AppError::new("the chosen folder does not exist"))?;
    let inside = |root: &Path| -> bool {
        std::fs::canonicalize(root)
            .map(|r| parent.starts_with(r))
            .unwrap_or(false)
    };
    let in_open = open_vault.map(inside).unwrap_or(false);
    // A Baalda vault's `.context/` always holds its index; a bare `.context`
    // folder some other tool made (say in the home folder) does not count.
    let in_any = parent
        .ancestors()
        .any(|a| a.join(".context").join("index.sqlite").is_file());
    if in_open || in_any {
        return Err(AppError::new(
            "Save the vault key outside your vault folder: files there sync to your team.",
        ));
    }
    Ok(())
}

/// Owner-only temp file beside `path`, then rename over it.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::new("save path has no folder"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export.txt");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{name}.{}-{nonce}.baalda-tmp", std::process::id()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new(format!("save failed: {e}")));
    }
    Ok(())
}

#[tauri::command]
pub async fn save_text_file(
    window: tauri::Webview,
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> AppResult<()> {
    crate::agent_runner::trusted_window(&window)?;
    let p = Path::new(&path);
    validate_text_export(p, &contents)?;
    let open_vault = state.inner.lock().unwrap().vault.clone();
    refuse_inside_vault(p, open_vault.as_deref())?;
    write_private_atomic(p, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_txt_paths() {
        let dir = std::env::temp_dir();
        assert!(validate_text_export(&dir.join("vault-key.txt"), "words").is_ok());
        assert!(validate_text_export(&dir.join("vault-key.TXT"), "words").is_ok());
        assert!(validate_text_export(Path::new("vault-key.txt"), "words").is_err());
        assert!(validate_text_export(&dir.join("vault-key.md"), "words").is_err());
        assert!(validate_text_export(&dir.join("vault-key"), "words").is_err());
        assert!(validate_text_export(&dir.join("big.txt"), &"a".repeat(MAX_TEXT_BYTES + 1)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks() {
        let dir = std::env::temp_dir().join(format!("baalda-text-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.txt");
        std::fs::write(&target, "x").unwrap();
        let link = dir.join("link.txt");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(validate_text_export(&link, "words").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn red_team_never_saves_inside_a_vault_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("Team");
        std::fs::create_dir_all(vault.join(".context")).unwrap();
        std::fs::write(vault.join(".context/index.sqlite"), b"").unwrap();
        std::fs::create_dir_all(vault.join("notes/deep")).unwrap();
        // Another tool's bare `.context` folder is not a vault.
        std::fs::create_dir_all(tmp.path().join("Plain/.context")).unwrap();
        // The open vault, a nested folder of it, and a vault that is not open.
        assert!(refuse_inside_vault(&vault.join("key.txt"), Some(&vault)).is_err());
        assert!(refuse_inside_vault(&vault.join("notes/deep/key.txt"), None).is_err());
        let other = tmp.path().join("Plain");
        std::fs::create_dir_all(&other).unwrap();
        assert!(refuse_inside_vault(&other.join("key.txt"), Some(&vault)).is_ok());
        // A path that climbs back into the vault is judged where it lands.
        assert!(refuse_inside_vault(&other.join("../Team/key.txt"), None).is_err());
    }

    #[test]
    fn red_team_write_replaces_whole_file_and_leaves_no_temp() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("vault key.txt");
        std::fs::write(&target, "older words").unwrap();
        write_private_atomic(&target, b"new words").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new words");
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".baalda-tmp"))
            .collect();
        assert!(leftovers.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "a vault key file must be owner-only");
        }
    }

    #[cfg(unix)]
    #[test]
    fn red_team_failed_write_keeps_the_original() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ro = tmp.path().join("ro");
        std::fs::create_dir_all(&ro).unwrap();
        let target = ro.join("vault key.txt");
        std::fs::write(&target, "keep me").unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = write_private_atomic(&target, b"new");
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(r.is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");
    }
}
