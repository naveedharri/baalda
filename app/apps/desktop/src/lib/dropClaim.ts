// OS file drops reach every `onDragDropEvent` listener in the window. The file
// tree imports anything dropped on the main area, so a page that takes drops
// of its own (Skills takes a .zip or .skill) claims them while it is showing.

let claims = 0;

/** Take OS file drops away from the file tree; returns the release. */
export function claimFileDrops(): () => void {
  claims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims--;
  };
}

export function fileDropsClaimed(): boolean {
  return claims > 0;
}
