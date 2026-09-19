// The Vault Settings tab names, as a leaf module.
//
// They live here rather than in `components/VaultSettingsDialog.tsx` because the
// STORE now names one: anything in the app can ask for Settings to open on a
// particular page (`requestSettings("health")`), and the store importing a
// 2,900-line lazy-loaded component — even type-only — is a layering inversion
// waiting to become an import cycle.
//
// The dialog re-exports this type, so its existing importers are unchanged.

export type SettingsTab =
  | "general"
  | "health"
  | "vaults"
  | "members"
  | "billing"
  | "access"
  | "mcp"
  | "versioning"
  | "import-export"
  | "appearance"
  | "updates";

/** Account settings stay separate from vault settings but use the same
 * request-token pattern when another surface links to a particular page. */
export type AccountSettingsTab =
  | "profile"
  | "status"
  | "appearance"
  | "notifications"
  | "connection"
  | "about";
