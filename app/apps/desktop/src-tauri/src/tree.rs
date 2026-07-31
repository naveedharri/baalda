//! Recursive vault tree walk → nested JSON for the react-arborist sidebar.

use crate::error::AppResult;
use crate::vault::{is_allowed_file, is_ignored_name};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    /// react-arborist needs a stable string id; we use the vault-relative path.
    pub id: String,
    pub name: String,
    /// Vault-relative, forward-slash path ("" for the root).
    pub path: String,
    pub is_dir: bool,
    /// Present (possibly empty) for directories; None for files (arborist leaf).
    pub children: Option<Vec<TreeNode>>,
}

/// Walk the vault into a nested tree. Skips dotfolders, `.git`, `.context/`,
/// heavy build/dependency dirs (`node_modules`, …), and any file whose extension
/// isn't on the allowlist (`ALLOWED_EXTS`) — so importing a real project folder
/// surfaces only notes/images/PDFs, never source code or `node_modules` junk.
pub fn list_tree(vault: &Path) -> AppResult<TreeNode> {
    let name = vault
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("vault")
        .to_string();
    let children = walk_dir(vault, "")?;
    Ok(TreeNode {
        id: "".to_string(),
        name,
        path: "".to_string(),
        is_dir: true,
        children: Some(children),
    })
}

/// List one directory's immediate children for lazy sidebar loading.
///
/// Unlike [`list_tree`], this does NOT recurse: sub-directories come back with
/// an empty `children` vec — a "not yet loaded" marker that still renders as an
/// expandable folder in react-arborist — and files come back as leaves. The
/// front-end fetches each folder's children on first expand, so switching a
/// huge vault costs O(top-level entries) instead of O(all notes). `rel` is the
/// vault-relative directory ("" for the root).
pub fn list_children(vault: &Path, rel: &str) -> AppResult<Vec<TreeNode>> {
    let dir = if rel.is_empty() {
        vault.to_path_buf()
    } else {
        vault.join(rel)
    };
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        // Root-level attachments/ is the binary-sync store — hidden (see walk_dir).
        if rel.is_empty()
            && name == "attachments"
            && entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
        {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            dirs.push(TreeNode {
                id: child_rel.clone(),
                name,
                path: child_rel,
                is_dir: true,
                children: Some(Vec::new()), // lazy marker: expandable, not yet loaded
            });
        } else if file_type.is_file() {
            if !is_allowed_file(&name) {
                continue;
            }
            files.push(TreeNode {
                id: child_rel.clone(),
                name,
                path: child_rel,
                is_dir: false,
                children: None,
            });
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

fn walk_dir(dir: &Path, rel_prefix: &str) -> AppResult<Vec<TreeNode>> {
    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()), // unreadable dir → empty, don't fail the whole tree
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&name) {
            continue;
        }
        // The vault-root `attachments/` folder is the binary-sync store for
        // images/PDFs embedded in notes — plumbing, not browsable content — so
        // it's hidden from the sidebar (notes render their attachments inline).
        // Only hidden at the root; a user's own nested "attachments" dir shows.
        if rel_prefix.is_empty() && name == "attachments" && entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let children = walk_dir(&entry.path(), &rel)?;
            dirs.push(TreeNode {
                id: rel.clone(),
                name,
                path: rel,
                is_dir: true,
                children: Some(children),
            });
        } else if file_type.is_file() {
            // Only surface allowed file types (notes/images/PDFs); skip code,
            // lockfiles, binaries, etc. so imports can't flood the vault.
            if !is_allowed_file(&name) {
                continue;
            }
            files.push(TreeNode {
                id: rel.clone(),
                name,
                path: rel,
                is_dir: false,
                children: None,
            });
        }
    }

    // Folders first, then files; each alphabetically (case-insensitive).
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn walk_skips_context_dirs_and_dotfolders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".context")).unwrap();
        fs::write(root.join(".context/index.sqlite"), b"x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), b"x").unwrap();
        fs::create_dir_all(root.join("Notes/Sub")).unwrap();
        fs::write(root.join("Notes/a.md"), b"# A").unwrap();
        fs::write(root.join("Notes/Sub/b.md"), b"# B").unwrap();
        fs::write(root.join("script.js"), b"code").unwrap();
        fs::write(root.join("diagram.png"), b"\x89PNG").unwrap();
        // A stray node_modules must never be walked/surfaced.
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), b"x").unwrap();

        let tree = list_tree(root).unwrap();
        let children = tree.children.unwrap();
        // ".context"/".git"/"node_modules" hidden; "script.js" filtered out by the
        // extension allowlist; "Notes" dir + allowed "diagram.png" surface.
        let names: Vec<&str> = children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["Notes", "diagram.png"]);

        let notes = children[0].children.as_ref().unwrap();
        let inner: Vec<&str> = notes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(inner, vec!["Sub", "a.md"]);
    }

    #[test]
    fn hides_root_attachments_folder_but_not_nested_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Root-level attachments/ is the sync store — hidden from the sidebar.
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("attachments/a1b2.pdf"), b"%PDF").unwrap();
        // A user's own nested "attachments" dir is normal content — kept.
        fs::create_dir_all(root.join("Notes/attachments")).unwrap();
        fs::write(root.join("Notes/attachments/keep.md"), b"# keep").unwrap();
        fs::write(root.join("Notes/a.md"), b"# A").unwrap();

        let tree = list_tree(root).unwrap();
        let children = tree.children.unwrap();
        let names: Vec<&str> = children.iter().map(|n| n.name.as_str()).collect();
        assert!(!names.contains(&"attachments"), "root attachments/ must be hidden");
        assert!(names.contains(&"Notes"));

        // The nested attachments dir under Notes/ survives.
        let notes_dir = children.iter().find(|n| n.name == "Notes").unwrap();
        let inner: Vec<&str> = notes_dir
            .children
            .as_ref()
            .unwrap()
            .iter()
            .map(|n| n.name.as_str())
            .collect();
        assert!(inner.contains(&"attachments"));
    }
}
