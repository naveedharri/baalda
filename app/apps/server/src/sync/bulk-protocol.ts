/**
 * Binary page codec for the bootstrap download — the server half of a
 * hand-mirrored pair with `apps/desktop/src/lib/sync/bootstrapCodec.ts`, and the
 * sibling of `vault-protocol.ts encodeWsUpdate`.
 *
 * Binary rather than base64 (which `docs/batch` uses in the other direction)
 * because THIS direction carries the whole vault: base64 is +33 % before gzip
 * and gzip recovers less from it than from raw Yjs, and a `DataView` walk beats
 * `JSON.parse` of 4 MB of very long strings. The desktop already has three
 * `arrayBuffer()` transports to receive it on.
 *
 * Layout, little-endian throughout:
 *
 *   "BLDB" | ver u8 = 1 | flags u8 = 0 | docCount u32 | reserved u16
 *   docCount × ( docIdLen u8 | pathLen u16 | updateLen u32
 *                | docId utf8 | relPath utf8 | update )
 *
 * The updates are Yjs **V1** only. The store is V1 (yjs#687 makes V2 merges
 * unsafe, see `persistence.ts mergeParts`), and `flags` is the reserved seam for
 * ever changing that — a decoder that meets a flag it does not know must refuse
 * the page rather than guess, which is what `decodeBootstrapPage` does.
 */

export const BOOTSTRAP_MAGIC = 0x42444c42; // the ASCII bytes "BLDB", read little-endian
export const BOOTSTRAP_VERSION = 1;
/** Bytes before the first doc record. */
export const BOOTSTRAP_HEADER_BYTES = 12;
/** Fixed bytes of one doc record, before its three variable-length fields. */
export const BOOTSTRAP_RECORD_BYTES = 7;

export interface BootstrapDoc {
  docId: string;
  relPath: string;
  update: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A page that does not parse. Carries no bytes — the caller logs the reason. */
export class BootstrapCodecError extends Error {}

/**
 * Exact encoded size of one doc record, so a page can be packed to a byte budget
 * without building it first. The docId and path are measured as UTF-8, not as
 * JS characters: a non-ASCII path is longer on the wire than `.length` says.
 */
export function encodedDocBytes(doc: BootstrapDoc): number {
  return (
    BOOTSTRAP_RECORD_BYTES +
    enc.encode(doc.docId).length +
    enc.encode(doc.relPath).length +
    doc.update.length
  );
}

export function encodeBootstrapPage(docs: BootstrapDoc[]): Uint8Array {
  // Two passes: measure, allocate once, fill. Concatenating per doc would copy
  // the whole page O(n) times, and this runs with `bootstrapConcurrency` pages
  // in flight against a 512 MB heap.
  const parts = docs.map((d) => ({
    id: enc.encode(d.docId),
    path: enc.encode(d.relPath),
    update: d.update,
  }));
  let total = BOOTSTRAP_HEADER_BYTES;
  for (const p of parts) {
    if (p.id.length > 0xff) throw new BootstrapCodecError("docId too long for the page format");
    if (p.path.length > 0xffff) throw new BootstrapCodecError("relPath too long for the page format");
    total += BOOTSTRAP_RECORD_BYTES + p.id.length + p.path.length + p.update.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, BOOTSTRAP_MAGIC, true);
  out[4] = BOOTSTRAP_VERSION;
  out[5] = 0; // flags
  view.setUint32(6, parts.length, true);
  view.setUint16(10, 0, true); // reserved
  let off = BOOTSTRAP_HEADER_BYTES;
  for (const p of parts) {
    out[off] = p.id.length;
    view.setUint16(off + 1, p.path.length, true);
    view.setUint32(off + 3, p.update.length, true);
    off += BOOTSTRAP_RECORD_BYTES;
    out.set(p.id, off);
    off += p.id.length;
    out.set(p.path, off);
    off += p.path.length;
    out.set(p.update, off);
    off += p.update.length;
  }
  return out;
}

export function decodeBootstrapPage(bytes: Uint8Array): BootstrapDoc[] {
  if (bytes.length < BOOTSTRAP_HEADER_BYTES) throw new BootstrapCodecError("page truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BOOTSTRAP_MAGIC) throw new BootstrapCodecError("bad magic");
  if (bytes[4] !== BOOTSTRAP_VERSION) throw new BootstrapCodecError(`unsupported page version ${bytes[4]}`);
  // An unknown flag means the producer encoded something this reader cannot
  // interpret (a V2 update, say). Refuse rather than hand Yjs bytes it will
  // silently mis-apply.
  if (bytes[5] !== 0) throw new BootstrapCodecError(`unsupported page flags 0x${bytes[5].toString(16)}`);
  const count = view.getUint32(6, true);
  const docs: BootstrapDoc[] = [];
  let off = BOOTSTRAP_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (off + BOOTSTRAP_RECORD_BYTES > bytes.length) throw new BootstrapCodecError("record header truncated");
    const idLen = bytes[off];
    const pathLen = view.getUint16(off + 1, true);
    const updLen = view.getUint32(off + 3, true);
    off += BOOTSTRAP_RECORD_BYTES;
    const end = off + idLen + pathLen + updLen;
    if (end > bytes.length) throw new BootstrapCodecError("record body truncated");
    const docId = dec.decode(bytes.subarray(off, off + idLen));
    const relPath = dec.decode(bytes.subarray(off + idLen, off + idLen + pathLen));
    // `slice`, not `subarray`: the decoded update outlives the page buffer (it
    // is handed to Yjs and, on the desktop, to Rust), and a view would pin the
    // whole 4 MB page in heap for as long as any one doc of it is alive.
    const update = bytes.slice(off + idLen + pathLen, end);
    docs.push({ docId, relPath, update });
    off = end;
  }
  return docs;
}
