//! Save a small text file at a path the person picked in the save dialog
//! (the owner's "Save vault key to file"). Deliberately narrow: trusted main
//! window only, absolute `.txt` paths only, never through a symlink, bounded
//! size. The contents are never logged.

use crate::error::{AppError, AppResult};
use std::path::Path;

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

#[tauri::command]
pub async fn save_text_file(window: tauri::Webview, path: String, contents: String) -> AppResult<()> {
    crate::agent_runner::trusted_window(&window)?;
    let p = Path::new(&path);
    validate_text_export(p, &contents)?;
    std::fs::write(p, contents.as_bytes()).map_err(|e| AppError::new(format!("save failed: {e}")))
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
}
