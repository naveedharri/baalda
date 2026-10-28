// Skills → Team: a .zip or .skill dragged in from Finder uploads like "Upload
// .zip". OS drops arrive through Tauri (HTML5 drag events never fire in the
// webview). The Skills tab claims every drop from the file tree for as long as
// it is open (`claimFileDrops`), so nothing dropped here lands in the vault.

import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** A skill bundle: Claude's .skill export is a zip under another name. */
export const SKILL_FILE_EXTS = ["zip", "skill"];

export function isSkillFile(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && SKILL_FILE_EXTS.includes(base.slice(dot + 1).toLowerCase());
}

/** What is held over the page: a skill file, something we refuse, or nothing. */
export type SkillDragState = "skill" | "refused" | null;

export function useSkillFileDrop(
  enabled: boolean,
  onDrop: (path: string) => void,
  onRefused: (paths: string[]) => void,
): SkillDragState {
  const [drag, setDrag] = useState<SkillDragState>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;

  useEffect(() => {
    if (!enabled) {
      setDrag(null);
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter") {
          setDrag(p.paths.length === 0 ? null : p.paths.some(isSkillFile) ? "skill" : "refused");
        } else if (p.type === "leave") {
          setDrag(null);
        } else if (p.type === "drop") {
          setDrag(null);
          const file = p.paths.find(isSkillFile);
          if (file) onDropRef.current(file);
          else if (p.paths.length > 0) onRefusedRef.current(p.paths);
        }
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });
    return () => {
      cancelled = true;
      unlisten?.();
      setDrag(null);
    };
  }, [enabled]);

  return drag;
}
