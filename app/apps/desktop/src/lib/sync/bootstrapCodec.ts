// The bootstrap page format — the client half of `server/src/sync/bulk-protocol.ts`.
//
// A bootstrap page carries the WHOLE vault's CRDT in one direction (hundreds of
// MB on a real vault), which is why it is binary rather than base64 JSON:
// base64 is +33 % BEFORE gzip and gzip recovers less from it than from raw Yjs,
// and a `DataView` walk beats `JSON.parse` of 4 MB of long strings by an order
// of magnitude on the webview's single thread. The `docs/batch` direction, which
// carries only what the server is missing, stays ordinary JSON.
//
//   "BLDB" | ver u8 = 1 | flags u8 = 0 | docCount u32 | reserved u16      (12 B)
//   docCount × ( docIdLen u8 | pathLen u16 | updateLen u32                 (7 B)
//                | docId utf8 | relPath utf8 | update )
//
// LITTLE-endian throughout — unlike the vault channel's `[docIdLen u16 BE]`
// update frame, which predates this and is left alone. Every length is
// bounds-checked against the buffer before it is used: a page is network input,
// and a truncated one must fail loudly here rather than hand a half-read update
// to `Y.applyUpdate`.
//
// Yjs V1 updates only. The store is V1 (yjs#687 makes V2 merges unsafe) and
// `flags` is what reserves the room to change that.
//
// Pure and dependency-free, so both the fixtures in `bootstrapCodec.test.ts` and
// the server's own encoder can be checked against it byte for byte.

/** Magic: "BLDB", as the four bytes it is on the wire. */
export const BOOTSTRAP_MAGIC = [0x42, 0x4c, 0x44, 0x42] as const; // B L D B
export const BOOTSTRAP_VERSION = 1;
/** Bytes before the first doc record. */
export const BOOTSTRAP_HEADER_BYTES = 12;
/** Bytes of per-doc header (docIdLen u8 + pathLen u16 + updateLen u32). */
export const BOOTSTRAP_DOC_HEADER_BYTES = 7;

export interface BootstrapDoc {
  docId: string;
  relPath: string;
  /** The doc's merged Yjs V1 update, as a view INTO the page buffer. */
  update: Uint8Array;
}

/** A page that could not be read. Never retried blind: a malformed page is a
 *  protocol disagreement, not a flaky link. */
export class BootstrapDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapDecodeError";
  }
}

const utf8Decode = new TextDecoder();
const utf8Encode = new TextEncoder();

/**
 * Decode one page. Throws {@link BootstrapDecodeError} on anything unexpected —
 * bad magic, an unknown version, an unknown flag, a length that runs off the
 * end, or trailing bytes after the last doc.
 *
 * The returned `update` arrays are SUBARRAYS of `bytes`: no copy is made, so a
 * 4 MiB page costs 4 MiB and not 8. They stay valid as long as the page buffer
 * does, which for the runner is "until the batch IPC has returned".
 */
export function decodeBootstrapPage(bytes: Uint8Array): BootstrapDoc[] {
  if (bytes.byteLength < BOOTSTRAP_HEADER_BYTES) {
    throw new BootstrapDecodeError(
      `page too short (${bytes.byteLength} bytes, need ${BOOTSTRAP_HEADER_BYTES})`,
    );
  }
  for (let i = 0; i < BOOTSTRAP_MAGIC.length; i++) {
    if (bytes[i] !== BOOTSTRAP_MAGIC[i]) {
      throw new BootstrapDecodeError("not a bootstrap page (bad magic)");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== BOOTSTRAP_VERSION) {
    throw new BootstrapDecodeError(`unsupported bootstrap page version ${version}`);
  }
  const flags = view.getUint8(5);
  // No flag is defined yet, so ANY set bit means the server is speaking a
  // dialect this build does not know — e.g. V2 updates. Refusing is the whole
  // point of reserving the byte; applying the payload anyway would corrupt docs.
  if (flags !== 0) {
    throw new BootstrapDecodeError(`unsupported bootstrap page flags 0x${flags.toString(16)}`);
  }
  const docCount = view.getUint32(6, true);
  // bytes 10..11 reserved (u16), deliberately unread.

  const docs: BootstrapDoc[] = [];
  let off = BOOTSTRAP_HEADER_BYTES;
  for (let i = 0; i < docCount; i++) {
    if (off + BOOTSTRAP_DOC_HEADER_BYTES > bytes.byteLength) {
      throw new BootstrapDecodeError(`truncated page: doc ${i} header runs past the end`);
    }
    const docIdLen = view.getUint8(off);
    const pathLen = view.getUint16(off + 1, true);
    const updateLen = view.getUint32(off + 3, true);
    off += BOOTSTRAP_DOC_HEADER_BYTES;
    const end = off + docIdLen + pathLen + updateLen;
    if (end > bytes.byteLength) {
      throw new BootstrapDecodeError(`truncated page: doc ${i} body runs past the end`);
    }
    const docId = utf8Decode.decode(bytes.subarray(off, off + docIdLen));
    const relPath = utf8Decode.decode(
      bytes.subarray(off + docIdLen, off + docIdLen + pathLen),
    );
    const update = bytes.subarray(off + docIdLen + pathLen, end);
    off = end;
    if (!docId) throw new BootstrapDecodeError(`page doc ${i} has an empty docId`);
    if (!relPath) throw new BootstrapDecodeError(`page doc ${i} has an empty relPath`);
    docs.push({ docId, relPath, update });
  }
  if (off !== bytes.byteLength) {
    // Trailing bytes mean the two sides disagree about the layout. Applying the
    // docs we DID read would be applying half a protocol.
    throw new BootstrapDecodeError(
      `page has ${bytes.byteLength - off} trailing bytes after ${docCount} docs`,
    );
  }
  return docs;
}

/**
 * Encode a page — the inverse, kept beside the decoder so the fixtures in the
 * tests (and the server's own codec test) can be generated from one place
 * rather than from two hand-written byte strings that drift.
 *
 * Production never calls this: the desktop only ever RECEIVES pages.
 */
export function encodeBootstrapPage(
  docs: ReadonlyArray<{ docId: string; relPath: string; update: Uint8Array }>,
): Uint8Array {
  const parts = docs.map((d) => ({
    docId: utf8Encode.encode(d.docId),
    relPath: utf8Encode.encode(d.relPath),
    update: d.update,
  }));
  for (const p of parts) {
    if (p.docId.byteLength > 0xff) throw new Error("docId too long for a page record");
    if (p.relPath.byteLength > 0xffff) throw new Error("relPath too long for a page record");
  }
  const total =
    BOOTSTRAP_HEADER_BYTES +
    parts.reduce(
      (n, p) =>
        n +
        BOOTSTRAP_DOC_HEADER_BYTES +
        p.docId.byteLength +
        p.relPath.byteLength +
        p.update.byteLength,
      0,
    );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(BOOTSTRAP_MAGIC, 0);
  view.setUint8(4, BOOTSTRAP_VERSION);
  view.setUint8(5, 0);
  view.setUint32(6, parts.length, true);
  view.setUint16(10, 0, true);
  let off = BOOTSTRAP_HEADER_BYTES;
  for (const p of parts) {
    view.setUint8(off, p.docId.byteLength);
    view.setUint16(off + 1, p.relPath.byteLength, true);
    view.setUint32(off + 3, p.update.byteLength, true);
    off += BOOTSTRAP_DOC_HEADER_BYTES;
    out.set(p.docId, off);
    off += p.docId.byteLength;
    out.set(p.relPath, off);
    off += p.relPath.byteLength;
    out.set(p.update, off);
    off += p.update.byteLength;
  }
  return out;
}
