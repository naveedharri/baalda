// The one shape every viewer leaf takes.
//
// `FilePreview` resolves the vault root once and hands each leaf both forms of
// the location, because they need different ones: the IPC readers are
// vault-relative and epoch-pinned (`path`), the media elements stream over the
// asset protocol from an absolute path (`src`), and the OS "open externally"
// buttons want the absolute path itself (`abs`). Resolving it here rather than
// in six leaves is also what lets the routing test mount any of them without a
// store.

export interface ViewerProps {
  /** Vault-relative path — what every `ipc.*` call takes. */
  path: string;
  /** Absolute on-disk path, for the opener plugin. */
  abs: string;
  /** `convertFileSrc(abs)` — an `asset:` URL the webview can stream. */
  src: string;
}
