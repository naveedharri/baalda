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

use crate::error::{AppError, AppResult};

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

/// Real OS keychain backed by the `keyring` crate.
pub struct OsKeychain;

impl OsKeychain {
    fn entry(key: &str) -> AppResult<keyring::Entry> {
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
