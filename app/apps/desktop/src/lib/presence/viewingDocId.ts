/**
 * Which id to announce as "the note I'm looking at".
 *
 * It must be the SERVER doc_id. Everyone else in the presence path speaks
 * server ids: the vault channel drops any presence frame whose docId isn't in
 * the receiver's readable set, and FileTree matches dots by
 * `registry.getMapping(path).docId`. A local index id is not merely useless to
 * them — it is indistinguishable from a note they can't read, so it is
 * discarded in silence.
 *
 * The two ids are equal only for notes created on this device, because the
 * server adopts the id we hand it at registration. On a device that JOINED an
 * existing vault, server-only notes are materialized locally with fresh uuids,
 * so announcing the local id made that person invisible on every teammate's
 * sidebar — while they saw everyone else perfectly. That asymmetry is the
 * signature of this bug.
 *
 * @param localId  the note's local index id (null when there's no note open)
 * @param mappedDocId  server doc_id for the note's path, if the registry has
 *   one — absent for a vault that isn't syncing, or a non-markdown file
 */
export function viewingDocId(
  localId: string | null | undefined,
  mappedDocId: string | null | undefined,
): string | null {
  if (!localId) return null;
  // No mapping means nothing is syncing this note, so there is no server id to
  // prefer and the local one is all anyone could match on anyway.
  return mappedDocId || localId;
}
