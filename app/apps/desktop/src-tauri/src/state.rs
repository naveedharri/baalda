//! Shared application state: the currently-open vault, its live index, and the
//! watcher handle. Guarded by a single mutex; commands clone out the pieces
//! they need and release the lock quickly.

use crate::index::Index;
use crate::oauth::OauthResult;
use crate::watcher::VaultWatcher;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct AppState {
    pub inner: Mutex<Inner>,
    /// Pending Google-OAuth loopback handoff: `google_oauth_listen` parks the
    /// receiver here; `google_oauth_await` takes it out and blocks on it. Its
    /// own mutex so it never contends with the vault/index lock.
    pub oauth_rx: Mutex<Option<Receiver<OauthResult>>>,
    /// The parsed app `config.json`, cached after its first read.
    ///
    /// Its OWN mutex, deliberately: a config read must never queue behind the
    /// vault/index lock, which the background rebuild holds for the whole of a
    /// vault open. `None` means "not loaded yet"; `write_config` replaces the
    /// cached value rather than invalidating it, so the next read never touches
    /// the disk. Correct only while this process is the sole writer of the file,
    /// which it is (single-instance plugin) — a future "reload settings from
    /// disk" would have to clear this.
    pub config: Mutex<Option<crate::commands::AppConfig>>,
}

#[derive(Default)]
pub struct Inner {
    pub vault: Option<PathBuf>,
    pub index: Option<Arc<Mutex<Index>>>,
    pub watcher: Option<VaultWatcher>,
    /// Monotonic counter bumped on EVERY vault open. There is one global vault
    /// slot, so a vault-relative command resolves against whatever vault is open
    /// when it *lands* — not the vault its caller intended. Callers that write
    /// (or read in order to write) pass the epoch they started under; a mismatch
    /// is rejected instead of writing vault A's data into vault B's folder.
    /// An epoch is unambiguous where a path can repeat (reopen, rebind, rename).
    pub vault_epoch: u64,
}
