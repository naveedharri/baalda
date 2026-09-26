// Keep a silent update's restart behind whatever app the user is in.
//
// Just before an update restarts the app we record whether Baalda was in the
// background; the new process reads that in Rust `setup` and, on macOS, hides
// itself again so it never jumps in front (see `src-tauri/src/relaunch.rs`).
// The What's New modal is simply waiting when the user comes back.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Record for the next launch whether the window is focused now. Never throws. */
export async function recordRelaunchFocus(): Promise<void> {
  try {
    const focused = await getCurrentWindow().isFocused();
    await invoke("set_background_relaunch", { background: !focused });
  } catch (e) {
    console.warn("[update] could not record focus for the relaunch", e);
  }
}

/** Forget the record: the restart did not happen. Never throws. */
export async function clearRelaunchFocus(): Promise<void> {
  try {
    await invoke("set_background_relaunch", { background: false });
  } catch {
    // Harmless: a stale marker expires on its own.
  }
}

/** Was this process started by a background relaunch? False outside Tauri. */
export async function launchedInBackground(): Promise<boolean> {
  try {
    return await invoke<boolean>("launched_in_background");
  } catch {
    return false;
  }
}
