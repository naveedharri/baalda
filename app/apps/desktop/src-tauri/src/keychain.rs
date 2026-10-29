//! OS keychain access for session tokens (spec 04 §7).
//!
//! Better Auth session tokens are the keys to a user's vault, so they must
//! never live in `localStorage` or any plaintext file. They live in the OS
//! keychain under the service `com.baalda.context`, keyed by a caller-supplied
//! `service_key` (e.g. `session:<serverUrl>`). The `keyring` crate maps this to
//! the macOS Keychain (Security framework) / Windows Credential Manager / the
//! Secret Service on Linux.
//!
//! The `SecretStore` trait keeps the logic testable: unit tests run against an
//! in-memory store so they never trigger a real-keychain permission prompt.
//!
//! **Each backend must be named as a `keyring` feature in `Cargo.toml`** —
//! keyring 3 has no default store and silently falls back to its in-memory
//! `mock` on any platform whose feature is missing. That fallback accepts every
//! write and loses it at exit, so the app starts signed out on every launch with
//! nothing in the log to say why (#136 on Windows, #129 on Linux). The features
//! belong to `keyring`, not to this crate, so `cfg!` cannot check them here;
//! `warn_if_ephemeral` asks the built store at runtime instead, and
//! `os_store_persists` pins it in the test suite.

use crate::error::{AppError, AppResult};
use keyring::credential::CredentialPersistence;

/// Keychain "service" namespace for all Baalda secrets.
///
/// FROZEN (Layer 3): set once, never changed on a future rebrand — changing it
/// would orphan every user's already-stored keychain entries (precedent: Slack
/// still ships under `com.tinyspeck.*`).
pub const SERVICE: &str = "com.baalda.context";

/// A minimal secret store, abstracted so tests can swap in an in-memory fake.
pub trait SecretStore {
    fn set(&self, key: &str, value: &str) -> AppResult<()>;
    fn get(&self, key: &str) -> AppResult<Option<String>>;
    fn delete(&self, key: &str) -> AppResult<()>;
}

/// Does this build's `keyring` resolve to a store that outlives the process?
///
/// The `mock` fallback reports `EntryOnly` (the secret lives in the `Entry`
/// object itself); every real OS store reports `UntilDelete`. Cheap to ask —
/// building a credential *builder* neither opens the store nor prompts.
fn store_persists() -> bool {
    matches!(
        keyring::default::default_credential_builder().persistence(),
        CredentialPersistence::UntilDelete | CredentialPersistence::UntilReboot
    )
}

/// Say so, loudly and once, if this build has no real credential store. Without
/// this the failure is invisible: every call succeeds and the secret is simply
/// gone next launch.
fn warn_if_ephemeral() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if !store_persists() {
            log::error!(
                "keychain: this build has no OS credential store (keyring fell back to its \
                 in-memory mock) — session tokens will not survive a restart"
            );
        }
    });
}

/// Real OS keychain backed by the `keyring` crate.
pub struct OsKeychain;

impl OsKeychain {
    /// A fresh `Entry` per call is deliberate and correct: an `Entry` is just
    /// the (service, key) address, and every real backend reads/writes the OS
    /// store on each call. Only the `mock` store keeps its values inside the
    /// `Entry`, which is why a mock build looks like it "never sees" what it
    /// wrote (#129).
    fn entry(key: &str) -> AppResult<keyring::Entry> {
        warn_if_ephemeral();
        keyring::Entry::new(SERVICE, key)
            .map_err(|e| AppError::new(format!("keychain entry ({key}): {e}")))
    }
}

impl SecretStore for OsKeychain {
    fn set(&self, key: &str, value: &str) -> AppResult<()> {
        Self::entry(key)?
            .set_password(value)
            .map_err(|e| AppError::new(format!("keychain set ({key}): {e}")))
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        match Self::entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::new(format!("keychain get ({key}): {e}"))),
        }
    }

    fn delete(&self, key: &str) -> AppResult<()> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) => Ok(()),
            // Deleting a missing secret is a no-op (idempotent sign-out).
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::new(format!("keychain delete ({key}): {e}"))),
        }
    }
}

// ---- Tauri commands -------------------------------------------------------
// The TS auth layer calls these through `ipc.ts`; the session token never
// crosses into JS-owned persistent storage.

#[tauri::command]
pub async fn keychain_set(service_key: String, value: String) -> AppResult<()> {
    OsKeychain.set(&service_key, &value)
}

#[tauri::command]
pub async fn keychain_get(service_key: String) -> AppResult<Option<String>> {
    OsKeychain.get(&service_key)
}

#[tauri::command]
pub async fn keychain_delete(service_key: String) -> AppResult<()> {
    OsKeychain.delete(&service_key)
}

// ---- Vault key secrets (client-held vault keys, W3) ----------------------
// Account private keys and per-vault keys get their own commands, scoped to
// two prefixes validated HERE (never trusted from the webview) and gated on
// the trusted main window, so a dashboard or remote view can never read them.

/// Account X25519 private key: `baalda.keys:<serverUrl>|<userId>`.
pub const ACCOUNT_KEY_PREFIX: &str = "baalda.keys:";
/// Per-vault key: `vk:<serverUrl>:<vaultId>`.
pub const VAULT_KEY_PREFIX: &str = "vk:";
const MAX_SECRET_KEY_LEN: usize = 1024;
const MAX_SECRET_VALUE_LEN: usize = 8192;

/// Accept only a `baalda.keys:` or `vk:` key with a non-empty, control-free
/// remainder of bounded length.
pub fn validate_vault_secret_key(key: &str) -> AppResult<()> {
    let rest = key
        .strip_prefix(ACCOUNT_KEY_PREFIX)
        .or_else(|| key.strip_prefix(VAULT_KEY_PREFIX));
    match rest {
        Some(r)
            if !r.is_empty()
                && key.len() <= MAX_SECRET_KEY_LEN
                && !key.chars().any(|c| c.is_control()) =>
        {
            Ok(())
        }
        _ => Err(AppError::new("vault secret key must start with baalda.keys: or vk:")),
    }
}

pub fn vault_secret_set_in(store: &dyn SecretStore, key: &str, value: &str) -> AppResult<()> {
    validate_vault_secret_key(key)?;
    if value.is_empty() || value.len() > MAX_SECRET_VALUE_LEN {
        return Err(AppError::new("vault secret value has an invalid length"));
    }
    store.set(key, value)
}

pub fn vault_secret_get_in(store: &dyn SecretStore, key: &str) -> AppResult<Option<String>> {
    validate_vault_secret_key(key)?;
    store.get(key)
}

pub fn vault_secret_delete_in(store: &dyn SecretStore, key: &str) -> AppResult<()> {
    validate_vault_secret_key(key)?;
    store.delete(key)
}

#[tauri::command]
pub async fn vault_secret_set(window: tauri::Webview, key: String, value: String) -> AppResult<()> {
    crate::agent_runner::trusted_window(&window)?;
    vault_secret_set_in(&OsKeychain, &key, &value)
}

#[tauri::command]
pub async fn vault_secret_get(window: tauri::Webview, key: String) -> AppResult<Option<String>> {
    crate::agent_runner::trusted_window(&window)?;
    vault_secret_get_in(&OsKeychain, &key)
}

#[tauri::command]
pub async fn vault_secret_delete(window: tauri::Webview, key: String) -> AppResult<()> {
    crate::agent_runner::trusted_window(&window)?;
    vault_secret_delete_in(&OsKeychain, &key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory store — never touches the real keychain, so tests can't hang on
    /// a macOS permission prompt.
    #[derive(Default)]
    struct MemStore(Mutex<HashMap<String, String>>);

    impl SecretStore for MemStore {
        fn set(&self, key: &str, value: &str) -> AppResult<()> {
            self.0.lock().unwrap().insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn get(&self, key: &str) -> AppResult<Option<String>> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn delete(&self, key: &str) -> AppResult<()> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[test]
    fn set_get_delete_roundtrip() {
        let store = MemStore::default();
        assert_eq!(store.get("session").unwrap(), None);

        store.set("session", "tok-123").unwrap();
        assert_eq!(store.get("session").unwrap(), Some("tok-123".to_string()));

        // Overwrite replaces the value.
        store.set("session", "tok-456").unwrap();
        assert_eq!(store.get("session").unwrap(), Some("tok-456".to_string()));

        store.delete("session").unwrap();
        assert_eq!(store.get("session").unwrap(), None);
    }

    #[test]
    fn vault_secret_prefixes_are_enforced() {
        let store = MemStore::default();
        let acct = "baalda.keys:https://api.example.com|user-1";
        let vk = "vk:https://api.example.com:vault-1";
        vault_secret_set_in(&store, acct, "priv").unwrap();
        vault_secret_set_in(&store, vk, "key").unwrap();
        assert_eq!(vault_secret_get_in(&store, acct).unwrap(), Some("priv".into()));
        assert_eq!(vault_secret_get_in(&store, vk).unwrap(), Some("key".into()));
        vault_secret_delete_in(&store, vk).unwrap();
        assert_eq!(vault_secret_get_in(&store, vk).unwrap(), None);

        // Session tokens and anything else stay out of reach.
        store.set("session:https://api.example.com", "tok").unwrap();
        for bad in [
            "session:https://api.example.com",
            "",
            "vk:",
            "baalda.keys:",
            "VK:x",
            "xvk:a",
            "vk:a\nb",
        ] {
            assert!(vault_secret_get_in(&store, bad).is_err(), "{bad:?} must be refused");
            assert!(vault_secret_set_in(&store, bad, "v").is_err(), "{bad:?} must be refused");
            assert!(vault_secret_delete_in(&store, bad).is_err(), "{bad:?} must be refused");
        }
        assert_eq!(store.get("session:https://api.example.com").unwrap(), Some("tok".into()));
        let long = format!("vk:{}", "a".repeat(2000));
        assert!(vault_secret_get_in(&store, &long).is_err());
        assert!(vault_secret_set_in(&store, vk, "").is_err());
    }

    #[test]
    fn delete_missing_is_ok() {
        let store = MemStore::default();
        // Idempotent sign-out: deleting a key that isn't there must not error.
        assert!(store.delete("nope").is_ok());
    }

    #[test]
    fn keys_are_isolated() {
        let store = MemStore::default();
        store.set("session:http://a", "A").unwrap();
        store.set("session:http://b", "B").unwrap();
        assert_eq!(store.get("session:http://a").unwrap(), Some("A".into()));
        assert_eq!(store.get("session:http://b").unwrap(), Some("B".into()));
        store.delete("session:http://a").unwrap();
        assert_eq!(store.get("session:http://a").unwrap(), None);
        assert_eq!(store.get("session:http://b").unwrap(), Some("B".into()));
    }

    /// The shipped platforms must all resolve to a persistent store — this is
    /// the regression guard on the `keyring` feature list in `Cargo.toml`
    /// (drop one and this build silently gets the in-memory mock). Constructing
    /// the builder touches no store, so there is no permission prompt.
    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    fn os_store_persists() {
        assert!(
            store_persists(),
            "keyring resolved to a non-persistent store — is this platform's backend \
             feature missing from Cargo.toml?"
        );
    }

    /// Real macOS keychain round-trip. Ignored by default because on an unsigned
    /// test binary it can pop a permission dialog; run explicitly with
    /// `cargo test -- --ignored real_keychain` on a machine where that's fine.
    #[test]
    #[ignore]
    fn real_keychain_roundtrip() {
        let store = OsKeychain;
        let key = "test:ci-roundtrip";
        store.set(key, "secret").unwrap();
        assert_eq!(store.get(key).unwrap(), Some("secret".into()));
        store.delete(key).unwrap();
        assert_eq!(store.get(key).unwrap(), None);
    }
}
