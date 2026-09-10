// May this note be opened right now, or must we wait for sync to prime?
//
// The boot paints the sidebar before the session restore and the sync prime have
// finished, so a note can be clicked while the registry still holds no doc-id
// map. Opening a MAPPED note in that state means opening it with no provider and
// seeding its CRDT from the file — the split-brain reversal `decideSeed` exists
// to prevent (spec 03 §5), and the shape of the note-doubling incident.
//
// So: a folder we know is a synced vault waits (briefly, and with the
// `openingNotePath` indicator already up, so the click is acknowledged); a
// folder we know is local, or one whose sync we know is not coming, opens at
// once. Pure, like `landing.ts` / `turnOnSync.ts` / `startup.ts`, so the rule can
// be read and tested without the store.

export type OpenDecision = { action: "open" } | { action: "wait" };

export function planOpen(input: {
  /** The sync layer is primed or enabled — `syncManager.isSyncable()`. */
  syncReady: boolean;
  /**
   * Is the open folder stamped for a vault? From the identity peek
   * (`ipc.peekVaultStamp`), and null while that answer is still in flight.
   */
  folderIsSynced: boolean | null;
  /** `store.authStatus`. */
  authStatus: "unknown" | "signed-in" | "signed-out";
}): OpenDecision {
  // Already mappable: the open path will find the note's doc id.
  if (input.syncReady) return { action: "open" };
  // No session ⇒ no provider for any note, so there is nothing to pull first.
  if (input.authStatus === "signed-out") return { action: "open" };
  // A folder with no vault stamp has no mapped notes to fork.
  if (input.folderIsSynced === false) return { action: "open" };
  // Known-synced, or not yet known. Both must wait: guessing "local" here is
  // exactly the guess that seeds a mapped doc from disk.
  return { action: "wait" };
}
