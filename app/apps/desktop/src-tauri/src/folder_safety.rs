//! Which folders Baalda refuses to use as a VAULT folder or as the vaults ROOT.
//!
//! Two real failures motivated this: a vaults root that ended up as the
//! Desktop's parent chain, and a vault bound to the home folder after macOS
//! denied Documents access and the user picked "any folder". Indexing and
//! syncing the whole home folder is never what anyone meant.
//!
//! Pure path logic with an injected home, so every rule is unit-testable.
//! Comparison is case-insensitive (macOS and Windows file systems usually
//! are) and resolves symlinks when the path exists.

use std::path::{Component, Path, PathBuf};

use crate::error::AppError;

/// Error-message prefix the UI recognises (`lib/vault/folderErrors.ts`) when
/// macOS refused to let Baalda create its default root under Documents.
pub const DOCUMENTS_DENIED: &str = "documents_denied: ";

/// The home sub-folders refused as a vault THEMSELVES (anything inside is fine).
const PROTECTED_HOME_CHILDREN: [&str; 3] = ["Desktop", "Documents", "Downloads"];

/// Resolve symlinks when possible, drop `.`/trailing separators, and fold case.
fn norm(p: &Path) -> PathBuf {
    let p = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str().to_string_lossy().to_lowercase()),
        }
    }
    out
}

/// Why `path` may not be a vault folder, or `None` when it is fine.
pub fn vault_folder_refusal(path: &Path, home: Option<&Path>) -> Option<String> {
    let p = norm(path);
    if p.parent().is_none() {
        return Some("Baalda cannot use the top of your disk as a vault. Choose a folder inside your home folder.".into());
    }
    let home = home?;
    let h = norm(home);
    if p == h {
        return Some("Baalda cannot use your home folder as a vault. Choose a folder inside it, or let Baalda create one in Documents/Baalda Vaults.".into());
    }
    if h.starts_with(&p) {
        return Some("Baalda cannot use a folder that contains your home folder as a vault. Choose a folder inside your home folder.".into());
    }
    for child in PROTECTED_HOME_CHILDREN {
        if p == norm(&home.join(child)) {
            return Some(format!(
                "Baalda cannot use your {child} folder itself as a vault. Choose or create a folder inside it."
            ));
        }
    }
    None
}

/// Why `path` may not be the vaults root, or `None` when it is fine.
pub fn vaults_root_refusal(path: &Path, home: Option<&Path>) -> Option<String> {
    let p = norm(path);
    if p.parent().is_none() {
        return Some("Baalda cannot keep vaults at the top of your disk. Choose a folder inside your home folder.".into());
    }
    let h = norm(home?);
    if p == h {
        return Some("Baalda cannot keep vaults directly in your home folder. Choose a folder inside it, such as Documents/Baalda Vaults.".into());
    }
    if h.starts_with(&p) {
        return Some("Baalda cannot keep vaults in a folder that contains your home folder. Choose a folder inside your home folder.".into());
    }
    None
}

/// `Err` with the refusal sentence when `path` may not be a vault folder.
pub fn check_vault_folder(path: &Path, home: Option<&Path>) -> Result<(), AppError> {
    match vault_folder_refusal(path, home) {
        Some(why) => Err(AppError::new(why)),
        None => Ok(()),
    }
}

/// `Err` with the refusal sentence when `path` may not be the vaults root.
pub fn check_vaults_root(path: &Path, home: Option<&Path>) -> Result<(), AppError> {
    match vaults_root_refusal(path, home) {
        Some(why) => Err(AppError::new(why)),
        None => Ok(()),
    }
}

/// Turn a failed `create_dir_all` of the vaults root into an error. A
/// permission refusal under `<home>/Documents` is macOS privacy (TCC) saying
/// no, and gets the `documents_denied` prefix so the UI can explain it and
/// offer System Settings instead of asking for any folder.
pub fn root_create_error(err: &std::io::Error, root: &Path, home: Option<&Path>) -> AppError {
    let denied = err.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(err.raw_os_error(), Some(1) | Some(13));
    let under_documents = home.is_some_and(|h| norm(root).starts_with(norm(&h.join("Documents"))));
    let msg = if denied && under_documents {
        format!(
            "{DOCUMENTS_DENIED}macOS blocked Baalda from using your Documents folder, so it couldn't create {}.",
            root.display()
        )
    } else {
        format!("Couldn't create the vaults folder {}: {err}", root.display())
    };
    log::error!("[vaults_root] {msg}");
    AppError::new(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/someone")
    }

    #[test]
    fn vault_refuses_home_and_its_ancestors() {
        let h = home();
        assert!(vault_folder_refusal(Path::new("/Users/someone"), Some(&h)).unwrap().contains("home folder as a vault"));
        assert!(vault_folder_refusal(Path::new("/Users/someone/"), Some(&h)).is_some());
        assert!(vault_folder_refusal(Path::new("/Users/SOMEONE"), Some(&h)).is_some());
        assert!(vault_folder_refusal(Path::new("/Users"), Some(&h)).unwrap().contains("contains your home"));
        assert!(vault_folder_refusal(Path::new("/"), Some(&h)).is_some());
        assert!(vault_folder_refusal(Path::new("/"), None).is_some());
    }

    #[test]
    fn vault_refuses_desktop_documents_downloads_themselves_only() {
        let h = home();
        for child in ["Desktop", "Documents", "Downloads", "documents"] {
            let p = h.join(child);
            assert!(vault_folder_refusal(&p, Some(&h)).is_some(), "{child}");
            assert!(vault_folder_refusal(&p.join("Notes"), Some(&h)).is_none(), "{child}/Notes");
        }
        assert!(vault_folder_refusal(&h.join("Documents/Baalda Vaults/team"), Some(&h)).is_none());
        assert!(vault_folder_refusal(&h.join("Projects"), Some(&h)).is_none());
        assert!(vault_folder_refusal(&h.join("Desktop/../Desktop"), Some(&h)).is_some());
    }

    #[test]
    fn vault_allows_folders_outside_home() {
        let h = home();
        assert!(vault_folder_refusal(Path::new("/Volumes/Drive/vault"), Some(&h)).is_none());
        assert!(vault_folder_refusal(Path::new("/Users/other"), Some(&h)).is_none());
    }

    #[test]
    fn root_refuses_home_ancestors_and_disk_top_but_allows_desktop() {
        let h = home();
        assert!(vaults_root_refusal(&h, Some(&h)).is_some());
        assert!(vaults_root_refusal(Path::new("/Users"), Some(&h)).is_some());
        assert!(vaults_root_refusal(Path::new("/"), Some(&h)).is_some());
        assert!(vaults_root_refusal(Path::new("/"), None).is_some());
        assert!(vaults_root_refusal(&h.join("Desktop"), Some(&h)).is_none());
        assert!(vaults_root_refusal(&h.join("Documents/Baalda Vaults"), Some(&h)).is_none());
        assert!(vaults_root_refusal(Path::new("/Volumes/Drive"), Some(&h)).is_none());
    }

    #[test]
    fn real_symlink_to_home_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let h = tmp.path().join("home");
        std::fs::create_dir_all(&h).unwrap();
        #[cfg(unix)]
        {
            let link = tmp.path().join("link");
            std::os::unix::fs::symlink(&h, &link).unwrap();
            assert!(vault_folder_refusal(&link, Some(&h)).is_some());
            assert!(vaults_root_refusal(&link, Some(&h)).is_some());
        }
    }

    #[test]
    fn permission_denied_under_documents_is_documents_denied() {
        let h = home();
        let root = h.join("Documents/Baalda Vaults");
        let eperm = std::io::Error::from_raw_os_error(1);
        let eacces = std::io::Error::from_raw_os_error(13);
        assert!(root_create_error(&eperm, &root, Some(&h)).to_string().starts_with(DOCUMENTS_DENIED));
        assert!(root_create_error(&eacces, &root, Some(&h)).to_string().starts_with(DOCUMENTS_DENIED));
        let other = std::io::Error::from_raw_os_error(2);
        assert!(!root_create_error(&other, &root, Some(&h)).to_string().starts_with(DOCUMENTS_DENIED));
        let elsewhere = h.join("Desktop/Vaults");
        assert!(!root_create_error(&eperm, &elsewhere, Some(&h)).to_string().starts_with(DOCUMENTS_DENIED));
    }
}
