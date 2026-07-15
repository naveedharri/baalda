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
}

#[derive(Default)]
pub struct Inner {
    pub vault: Option<PathBuf>,
    pub index: Option<Arc<Mutex<Index>>>,
    pub watcher: Option<VaultWatcher>,
}
