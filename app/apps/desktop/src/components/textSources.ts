/* Load the text behind a virtual tab's source: a recovery copy (Rust, confined
   to .context/trash), a server-Trash note (API), or a live note — the OPEN
   editor's text when it is mounted, else the file on disk. */
import * as ipc from "../lib/ipc";
import { authManager } from "../lib/auth/authManager";
import { ApiError } from "../lib/api";
import { liveView } from "./liveEditorViews";
import type { TextSource } from "./virtualTabs";

export async function loadSource(source: TextSource, epoch?: ipc.VaultEpoch): Promise<string> {
  switch (source.type) {
    case "copy":
      return ipc.readTrashCopy(source.stamp, source.relPath, epoch);
    case "trash":
      return (await authManager.api.trashContent(source.docId)).text;
    case "version":
      return (await authManager.api.getNoteVersion(source.docId, source.versionId)).content;
    case "note": {
      const view = liveView(source.path);
      if (view) return view.state.doc.toString();
      return ipc.readNote(source.path, epoch);
    }
  }
}

export function sourceErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This note is no longer in Trash.";
    if (e.status === 410) return "This note was purged from Trash.";
    if (e.status === 403) return "You don't have access to this note.";
    return e.message || `The server refused (${e.status}).`;
  }
  return e instanceof Error ? e.message : String(e);
}
