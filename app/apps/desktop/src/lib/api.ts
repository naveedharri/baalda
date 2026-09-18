// Type-only import: `bulkTypes.ts` is the hand-mirrored copy of the server's
// wire contract, and importing the TYPES keeps this module a runtime leaf.
import type {
  BootstrapSession,
  DocPushItem,
  DocPushResult,
  FileBatchItem,
  FileBatchResult,
  FolderBatchItem,
  FolderBatchResult,
  NoteBatchItem,
  NoteBatchResult,
  NoteDeleteResult,
} from "./sync/bulkTypes";

// The ONE typed HTTP boundary to the Baalda server. Every `fetch`
// to the server lives here — auth, organizations, registry, shares, sync-token.
// Components and managers call these methods; they never call `fetch` directly.
// (Tauri `invoke` lives in `ipc.ts`; these two are the only I/O boundaries.)
//
// Auth: Better Auth issues an opaque session token via the `set-auth-token`
// response header on sign-in/up (bearer plugin). We capture it, then send it as
// `Authorization: Bearer <token>` on every authenticated call. The token is
// persisted in the OS keychain by the auth manager — never here.

// ⚠️ Every call below is a WEBVIEW `fetch`, not Rust — we deliberately do not use
// tauri-plugin-http. So the `connect-src` in tauri.conf.json's CSP has to permit
// whatever server URL the user configures, or WebKit blocks the request before it
// leaves the app and reports only `TypeError: Load failed` (no CORS hint, nothing
// in the network tab). It bit us once: a CSP of `connect-src 'self' ipc: …` broke
// ALL remote traffic in packaged builds while dev kept working, which surfaced as
// a missing "Continue with Google" button (the capability probe below fails
// closed) plus "Load failed" on sign-in. Since self-hosting means the server URL
// is not knowable at build time, connect-src allows `https:`/`wss:` broadly;
// `script-src 'self'` stays the actual XSS boundary.
// The server a build points at before the user picks one in Settings. Dev talks
// to the local stack; a RELEASE build has to default to a server that actually
// exists for the person who just installed it — defaulting release builds to
// localhost:3010 meant a fresh install could only ever report "Load failed"
// until the user found Server settings on their own. Self-hosters override it
// there; nothing here is pinned at build time beyond this default.
/** The managed instance. Named so the dev guard below can recognise it. */
export const PRODUCTION_SERVER_URL = "https://api.baalda.com";
export const LOCAL_SERVER_URL = "http://localhost:3010";

/** Explicit opt-out of everything below: `VITE_SERVER_URL=… pnpm dev:desktop`. */
const ENV_SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim() || null;

export const DEFAULT_SERVER_URL =
  ENV_SERVER_URL ?? (import.meta.env.DEV ? LOCAL_SERVER_URL : PRODUCTION_SERVER_URL);

/**
 * The server to actually talk to, given whatever URL was persisted in the app
 * config (Settings → Connection writes it, and it survives across launches).
 *
 * A dev build IGNORES a persisted production URL. That combination is not a
 * preference, it's an accident with real consequences: `pnpm dev:desktop`
 * pointed at the managed instance reads and WRITES real users' vaults, and
 * because the URL is persisted per-device it silently stays that way across
 * every later launch — you only notice when local changes fail to appear in
 * a local Postgres that was never being used.
 *
 * Any OTHER persisted URL is honoured, so switching a dev build to a staging or
 * LAN server from Settings still works; only "dev build → production" is
 * refused, and `VITE_SERVER_URL=https://api.baalda.com` re-enables even that.
 */
export function resolveServerUrl(persisted: string | null | undefined): string {
  const clean = stripTrailingSlash((persisted ?? "").trim());
  if (!clean) return DEFAULT_SERVER_URL;
  if (import.meta.env.DEV && !ENV_SERVER_URL && clean === PRODUCTION_SERVER_URL) {
    return DEFAULT_SERVER_URL;
  }
  return clean;
}

// ---- Types (mirror the server's JSON) -------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  image?: string | null;
}

export interface SessionInfo {
  user: AuthUser;
  activeOrganizationId: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt?: string;
}

export interface Member {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt?: string;
  user?: { id: string; email: string; name: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
  inviterId?: string;
  expiresAt?: string;
  /** Present on our own `/api/invitations/*` routes, absent on Better Auth's —
   *  which is why every consumer treats both as optional and falls back. */
  organizationName?: string;
  inviterName?: string;
}

/**
 * What an invitation id resolves to for someone who is not (yet) signed in as
 * the invitee — the public shoulder-tap an invite deep link lands on.
 *
 * Public because the id IS the capability: an unguessable UUID that only ever
 * reaches the invitee's inbox. It carries the vault name and who invited them
 * so the sign-in card can say what the person is joining instead of asking for
 * a password against an unexplained modal.
 */
export interface InvitationPreview {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  organizationId: string;
  organizationName: string;
  inviterName: string | null;
  expiresAt?: string;
}

/**
 * Which sign-in routes the server actually offers. Every field is a capability,
 * so every field fails CLOSED — see {@link ApiClient.getAuthMethods}.
 */
export interface AuthMethods {
  emailPassword: boolean;
  google: boolean;
  /** Server can send a "choose a new password" email. */
  passwordReset: boolean;
  /** Server delivers invitations by email (otherwise the admin shares a link). */
  invitationEmail: boolean;
}

export interface Vault {
  id: string;
  organizationId?: string;
  organization_id?: string;
  name: string;
  /** True when nothing new may be created at the vault root (see the General
   *  settings toggle). Absent on an older server — treat that as false. */
  rootFrozen?: boolean;
  root_frozen?: boolean;
}

export interface RegisteredNote {
  id: string;
  docId?: string;
  doc_id?: string;
  vaultId?: string;
  vault_id?: string;
  folderId?: string | null;
  folder_id?: string | null;
  title: string | null;
  relPath?: string;
  rel_path?: string;
  /** Who last *edited* the note's content (never a rename/move), server-stamped
   *  from the authenticated editor — a teammate or an AI over MCP. Null until
   *  the note has been edited at least once since versioning shipped. */
  lastEditedBy?: string | null;
  last_edited_by?: string | null;
  lastEditedByName?: string | null;
  last_edited_by_name?: string | null;
  lastEditedAt?: string | null;
  last_edited_at?: string | null;
  /** Palette id (see `lib/appearance`), shared by the whole team. */
  color?: string | null;
  /** Who created the note. Read by the inbound reconciler: a note the LOCAL user
   *  authored keeps a recoverable `.context/trash` copy when access to it is
   *  revoked, instead of being removed outright. */
  createdBy?: string | null;
  created_by?: string | null;
}

/** The normalized "last edited by" fact for one note (see {@link noteLastEdited}). */
export interface NoteLastEdited {
  userId: string | null;
  name: string | null;
  /** ISO timestamp from the server. */
  at: string;
}

/** Flat structure listing that powers the Access panel (see `listAccessTree`). */
export interface AccessTreeResponse {
  folders: Array<{ id: string; path: string; color: string | null }>;
  notes: Array<{ id: string; relPath: string }>;
  /**
   * The vault's `files` rows — the tree binaries (pdf/docx/xlsx/mp4/…).
   *
   * A separate array rather than a `kind` on `notes`, because they are separate
   * tables with different path columns; they become one leaf class in the
   * panel's list, not in the wire shape. Empty from a server too old to send
   * them, which simply lists no file rows.
   */
  files: Array<{ id: string; path: string }>;
}

export interface RegisteredFolder {
  id: string;
  vaultId?: string;
  vault_id?: string;
  parentId?: string | null;
  parent_id?: string | null;
  name: string;
  path: string;
  /** Palette id (see `lib/appearance`), shared by the whole team. */
  color?: string | null;
}

/**
 * A `files` row — the server's generic "this vault path is a doc" record, the
 * binary twin of {@link RegisteredNote}.
 *
 * It exists so a tree binary has a doc_id the ACL can resolve: `shares`,
 * `effectivePermission` and `listReadableDocsInVault` all already walk these
 * rows, so registering one is what makes a `.docx` in a shared folder obey the
 * folder's grant instead of the blob store's path heuristic.
 */
export interface RegisteredFile {
  id: string;
  docId?: string;
  vaultId?: string;
  folderId?: string | null;
  path: string;
}

export interface Share {
  id: string;
  // `vault` appears on exactly one row: the whole-vault Read-only posture that
  // `GET /vaults/:id/locks` reports as a synthetic lock. Item shares are only
  // ever folder/file.
  resourceType?: "folder" | "file" | "vault";
  resource_type?: "folder" | "file" | "vault";
  resourceId?: string;
  resource_id?: string;
  principalType?: "user" | "org";
  principal_type?: "user" | "org";
  principalId?: string;
  principal_id?: string;
  permission: "view" | "edit" | "locked" | "denied";
  createdBy?: string;
  created_by?: string;
}

export type Permission = "view" | "edit";

/** The vault-wide access mode (see {@link ContextApi.getTeamAccess}). */
export type TeamAccessMode = "open" | "readonly" | "private";

/** One org-principal share row sitting on a folder or note *inside* the vault. */
export interface TeamAccessOverride {
  id: string;
  vaultId: string;
  resourceType: "folder" | "file";
  resourceId: string;
  permission: "edit" | "view" | "locked" | "denied";
}

/**
 * The vault's team access as one answer: the mode, the grant row backing it,
 * and every per-item org row a whole-vault change would replace.
 *
 * One request rather than "list the vault's shares, then work the rest out"
 * because the Access panel has to say how many settings it is about to clear
 * *before* the user confirms, and a count assembled from several round trips
 * is a count that can be wrong.
 */
export interface TeamAccess {
  mode: TeamAccessMode;
  grantId: string | null;
  overrides: TeamAccessOverride[];
}

/** What a whole-vault mode change actually did. */
export interface TeamAccessResult {
  mode: TeamAccessMode;
  /** Per-item org rows deleted. */
  cleared: number;
  /** Live sync sockets force-closed because the new mode revoked their access. */
  disconnectedDocs: number;
  /** False when the mode was already this and only the per-item rows went. */
  postureChanged: boolean;
}

/** One member's effective access to a resource, as resolved server-side. */
export interface ResolvedMemberAccess {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  permission: "edit" | "view" | "none";
  /** True when a lock reduced an otherwise-`edit` member down to `view`. */
  capped: boolean;
  /** True when the `none` is an explicit per-member block, not a missing grant. */
  denied?: boolean;
}

export interface AccessResolution {
  members: ResolvedMemberAccess[];
}

/** An MCP access token (metadata only; the plaintext is shown once at creation). */
/** A note's public browser link (server-rendered read-only page). */
export interface PublicLink {
  id: string;
  docId: string;
  /** The full shareable url — built by the server, so it names the right origin. */
  url: string;
  createdAt: string;
}

export interface McpTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Tool calls made with this connection so far. */
  useCount: number;
  /** The client on the other end (its User-Agent), if it has ever connected. */
  lastClient: string | null;
}

/** One MCP tool a connection can reach, classified for a compact access badge. */
export interface McpToolInfo {
  name: string;
  description: string;
  access: "read" | "write" | "destructive";
}

/** The MCP connections view for a vault: each token plus the shared tool catalog. */
export interface McpConnections {
  tokens: McpTokenRow[];
  tools: McpToolInfo[];
}

/** Attachment blob metadata returned by the server (camelCase). */
export interface BlobMeta {
  id: string;
  sha256: string;
  size: number;
  mime: string | null;
  relPath: string | null;
  filename?: string | null;
  /** True when the upload deduped to an existing row (server-set). */
  deduped?: boolean;
  /** `pending` until the bytes land (intent → PUT → complete); `ready` after.
   *  Absent on servers that predate the transport. */
  status?: "pending" | "ready";
  /** Which store holds the bytes — `postgres` or `s3`. Informational: every
   *  read path asks the SERVER, never this field, which store to talk to. */
  storageProvider?: string | null;
  /** The `files` row these bytes are, or null for an `attachments/` drop. The
   *  server has always sent it; the desktop records it on download so a
   *  teammate's binary gets a doc id here too (`attachments.ts ServerBlob`). */
  docId?: string | null;
}

/**
 * The upload an intent hands back — the one shape both storage providers speak.
 *
 * `direct` is the whole security story: `true` means the URL is a third-party
 * presign (S3/R2/MinIO) and MUST NOT carry our bearer; `false` means it is our
 * own server and the `?t=` query IS the auth, so it must not carry the bearer
 * either. Nothing in this flow ever sends `Authorization` to an upload URL —
 * see {@link ApiClient.uploadBytesTo}.
 */
export interface BlobUploadSingle {
  kind: "single";
  method: string;
  url: string;
  /** Sent VERBATIM (content-type + content-length); the presign signs them. */
  headers: Record<string, string>;
  /** Epoch millis after which the URL is dead. */
  expiresAt: number;
  direct: boolean;
}

/** One presigned `UploadPart` URL. `partNumber` is 1-based, like S3's. */
export interface BlobUploadPart {
  partNumber: number;
  url: string;
}

export interface BlobUploadMultipart {
  kind: "multipart";
  method: string;
  uploadId: string;
  /** Slice size: part n covers `[(n-1)*partBytes, n*partBytes)`. */
  partBytes: number;
  parts: BlobUploadPart[];
  headers: Record<string, string>;
  expiresAt: number;
  direct: boolean;
  /** Carried inside `partsUrl` too; kept for callers that rebuild the URL. */
  token?: string;
  /** Absolute; POST `{partNumbers}` here for fresh URLs when one expires. */
  partsUrl: string;
}

export type BlobUpload = BlobUploadSingle | BlobUploadMultipart;

/** The server already holds these bytes — send nothing. */
export interface BlobIntentDeduped {
  deduped: true;
  blob: BlobMeta;
}

/** The server wants the bytes, and this is where to PUT them. */
export interface BlobIntentUpload {
  deduped?: false;
  blobId: string;
  upload: BlobUpload;
  /** Absolute URL to POST once every byte is in (bearer REQUIRED — ours). */
  completeUrl: string;
}

export type BlobIntent = BlobIntentDeduped | BlobIntentUpload;

/** Body of `POST {completeUrl}`: `{}` for single, parts + id for multipart. */
export interface BlobCompleteBody {
  uploadId?: string;
  parts?: Array<{ partNumber: number; etag: string }>;
}

/** Where to GET an attachment's bytes right now. */
export interface BlobDownloadTarget {
  url: string;
  /** Epoch millis, or null when the URL does not expire (our own route). */
  expiresAt: number | null;
  /** `true` = a third-party presign: fetch it with NO `Authorization` at all. */
  direct: boolean;
}

// ---- Versioning (per-note history + vault checkpoints) --------------------

/**
 * One stored state of a note. Content is deliberately absent — the list is
 * fetched constantly (every panel open) and a version is the full markdown, so
 * the body only travels when someone actually previews or reverts
 * ({@link NoteVersionDetail}).
 *
 * `id` is a JS number (the server narrows its BIGSERIAL), `size` is bytes.
 */
export interface NoteVersion {
  id: number;
  createdAt: string;
  /** `idle` = captured at the end of an edit session; `pre-revert` = the state
   *  that was replaced, captured so a revert is itself undoable. */
  cause: "idle" | "pre-revert";
  authorId: string | null;
  authorName: string | null;
  sha256: string;
  size: number;
}

export interface NoteVersionDetail extends NoteVersion {
  content: string;
}

/** A vault-wide snapshot (structure + content of every note at one moment). */
export interface VaultCheckpoint {
  id: string;
  kind: "auto" | "manual";
  label: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  noteCount: number;
}

/** What a whole-vault revert did. Attachments/blobs are never touched. */
export interface VaultRevertResult {
  ok: true;
  docsChanged: number;
  docsRestored: number;
  docsDeleted: number;
  foldersCreated: number;
  /** Notes kept as-is because the snapshot was empty while the live note had
   *  text — the revert's data-loss firewall refusing to bulldoze content. */
  docsKeptOverEmpty?: number;
  /** The auto checkpoint taken just before the revert — this is the undo. */
  preRevertCheckpointId: string;
}

export interface SyncTokenResponse {
  token: string;
  docId: string;
  vaultId: string;
  readOnly: boolean;
  permission: Permission;
}

/** Vault-scoped token for the background replication channel (spec 05 §7). */
export interface VaultSyncTokenResponse {
  token: string;
  vaultId: string;
}

// ---- Billing (subscription) ----------------------------------------------

/** One purchasable plan variant (e.g. Pro monthly / yearly). Amount is in the
 *  currency's minor units (cents). */
export interface BillingPlan {
  id: string;
  label: string;
  amount: number;
  currency: string;
  interval: "month" | "year";
}

/** Server-wide billing capability (public; no auth). `enabled: false` means the
 *  server has no billing configured — a self-host runs with unlimited limits. */
export interface BillingConfig {
  enabled: boolean;
  plans?: BillingPlan[];
  freeLimits?: { vaultsPerUser: number; membersPerVault: number };
}

/** A single vault's subscription state + seat usage. */
export interface OrgBilling {
  plan: "free" | "pro";
  status: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Cadence + price of the live subscription, straight from the provider's
   *  snapshot — so a row can be priced without matching it back to a
   *  `BillingPlan`. All three are null on a vault with no subscription
   *  (#109). `amount` is minor units, like {@link BillingPlan.amount}. */
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
  /** `limit: null` = unlimited (paid). */
  seats: { members: number; pendingInvitations: number; limit: number | null };
}

/** One row of the Subscriptions list: a vault the caller belongs to. */
export interface MyBillingVault {
  orgId: string;
  name: string;
  role: "owner" | "admin" | "member";
  plan: "free" | "pro";
  status: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
  seats: { members: number; pendingInvitations: number; limit: number | null };
  /** The vault's owner — who to point a member at when they can't act. */
  billingOwner: { userId: string; name: string; email: string } | null;
  /** Owner or admin: may upgrade this vault or open its portal. */
  canManage: boolean;
  /** Owner AND the subscription is live: may move it to another vault. */
  canTransfer: boolean;
}

/**
 * A subscription whose vault is gone. Deleting a vault cancels its
 * subscription at the period end rather than instantly, so the paid time the
 * user already bought survives the vault — and has to be reachable from
 * somewhere (#109/#111). The server keeps the row as a tombstone; this is it.
 */
export interface OrphanedSubscription {
  orgId: string;
  orgName: string | null;
  deletedAt: string;
  status: "active" | "past_due";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
}

/**
 * Every subscription the caller can see or act on, in one shot. The per-vault
 * `GET /api/billing/orgs/:orgId` can't answer this: role is only known for the
 * active org and plan is only known one org at a time.
 */
export interface MyBilling {
  vaults: MyBillingVault[];
  orphaned: OrphanedSubscription[];
  freeLimits: {
    vaultsPerUser: number;
    membersPerVault: number;
    /** Owned vaults with no subscription — what counts against the cap. */
    freeVaultsUsed: number;
  };
}

/** What `DELETE /api/orgs/:orgId` reports back. */
export interface VaultDeleteResult {
  deleted: boolean;
  vaults: number;
  docs: number;
  /** Set when the deleted vault carried a live subscription: the server told
   *  the provider to stop at the period end, and this is when that is. */
  subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
}

/**
 * What `GET /api/orgs/:orgId/unsync-preview` reports: everything the server
 * would destroy if this vault were made local only.
 *
 * `members` EXCLUDES the owner — it is the number of people who lose access,
 * which is the sentence the confirm dialog has to say out loud.
 */
export interface UnsyncPreview {
  orgName: string;
  notes: number;
  files: number;
  folders: number;
  attachmentBytes: number;
  members: number;
  publicLinks: number;
  mcpTokens: number;
  checkpoints: number;
  /** The vault's live subscription, when it has one — the period-end sentence. */
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

/** What `POST /api/orgs/:orgId/unsync` reports back once the server copy is gone. */
export interface UnsyncResult {
  unsynced: boolean;
  notes: number;
  files: number;
  members: number;
  /** Set when the vault carried a live subscription: cancelled at the period end. */
  subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
}

/**
 * `GET /api/orgs/:orgId/status`, as a VALUE rather than an exception.
 *
 * The three answers mean three different things to the folder on disk, and the
 * caller has to tell them apart: `vault-not-found` is "this vault was made local
 * only (or deleted) — offer the fix", `not-a-member` is "it is somebody else's
 * folder — keep refusing", and `unknown` is "we could not ask", which must stay
 * silent (fail closed). Returning them instead of throwing is what keeps that
 * distinction from collapsing into one `catch`.
 */
export type OrgStatus =
  | { kind: "member"; orgId: string; name: string; role: string }
  | { kind: "not-a-member" }
  | { kind: "vault-not-found" }
  | { kind: "unknown" };

/** A rejected server response — carries the HTTP status for callers to branch on. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A blob-transport call the server refused, carrying the machine-readable
 * `code` the flow branches on (`storage_limit_reached`, `attachment_too_large`,
 * `upload_incomplete`, …) next to the status.
 *
 * An `ApiError` subclass so every existing `catch (e) { if (e instanceof
 * ApiError) }` keeps working — the code is the only thing added, and it is read
 * through {@link blobErrorCode} so a plain `ApiError` from an older path still
 * answers.
 */
export class BlobTransportError extends ApiError {
  constructor(
    status: number,
    public code: string | null,
    message: string,
    body?: unknown,
  ) {
    super(status, message, body);
    this.name = "BlobTransportError";
  }
}

/**
 * The server's error code for a failed blob call, or null when it named none.
 * Reads `code` first and `error` second, which is how the server's JSON bodies
 * spell it in the two generations of these routes.
 */
export function blobErrorCode(e: unknown): string | null {
  if (e instanceof BlobTransportError) return e.code;
  if (e instanceof ApiError) return errorCodeOf(e.body);
  return null;
}

function errorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { code?: unknown; error?: unknown };
  if (typeof b.code === "string") return b.code;
  if (typeof b.error === "string") return b.error;
  return null;
}

/**
 * A refused bulk-sync call, carrying the machine-readable `code` the engine
 * branches on next to the status.
 *
 * An {@link ApiError} subclass, like {@link BlobTransportError}, so every
 * existing `catch (e) { if (e instanceof ApiError) }` keeps working.
 * `retryAfterMs` is set only for a 503 `bootstrap_busy`, where the server told
 * us when to come back.
 */
export class BulkApiError extends ApiError {
  constructor(
    status: number,
    public code: string | null,
    message: string,
    body?: unknown,
    public retryAfterMs: number | null = null,
  ) {
    super(status, message, body);
    this.name = "BulkApiError";
  }
}

/**
 * The error code for a failed bulk call.
 *
 * The server's own `code` wins; the three statuses below are what a bare status
 * MEANS on these routes. `server_too_old` in particular is never sent by anyone
 * — it is what a 404 on a route this build requires means, and it is terminal.
 */
function bulkCodeFor(status: number, body: unknown): string | null {
  const code = errorCodeOf(body);
  if (code) return code;
  if (status === 404) return "server_too_old";
  if (status === 410) return "session_expired";
  if (status === 503) return "bootstrap_busy";
  return null;
}

/** Re-type a failed bulk call so callers can branch on the server's `code`. */
function asBulkError(e: unknown): unknown {
  if (e instanceof BulkApiError) return e;
  if (e instanceof ApiError) {
    return new BulkApiError(e.status, bulkCodeFor(e.status, e.body), e.message, e.body);
  }
  return e;
}

/**
 * The bulk `code` an error carries, or null (a network failure names none).
 *
 * Also reads a plain `code` property off anything else thrown, because the
 * engine's own modules (`bootstrap.ts`, `docBatchPush.ts`) branch on exactly
 * that field and their injected transports are not required to be an
 * {@link ApiError} — the code is the contract, not the class.
 */
export function bulkErrorCode(e: unknown): string | null {
  if (e instanceof BulkApiError) return e.code;
  if (e instanceof ApiError) return bulkCodeFor(e.status, e.body);
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : null;
}

/** "This server does not have the bulk engine" — the one terminal verdict. */
export function isServerTooOld(e: unknown): boolean {
  return bulkErrorCode(e) === "server_too_old";
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date, or null. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

function numHeader(v: string | null): number {
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** One `GET …/bootstrap/:sessionId` page: bytes plus the three headers. */
export interface BootstrapPageResponse {
  /** The page, already un-gzipped by the fetch stack. Decode with
   *  `sync/bootstrapCodec.ts`. */
  bytes: Uint8Array;
  /** Cursor for the NEXT page; `null` (header absent) ⇒ drained. */
  nextCursor: number | null;
  /** Docs in this page, as the server counted them. */
  docs: number;
  /** Uncompressed payload bytes, for the progress subtitle. */
  uncompressedBytes: number;
}

/**
 * Notes per page in {@link ApiClient.listNoteRegistryPaged}.
 *
 * 1000 rows is a body of a few hundred KB — small enough that a page parses in
 * one frame, large enough that a 6,000-note vault is six round trips rather
 * than sixty. Omitting `limit` entirely is what an OLD server does with it, and
 * that is exactly today's unpaged behaviour.
 */
export const REGISTRY_PAGE_LIMIT = 1000;

/**
 * A server address didn't check out. Thrown by {@link ApiClient.health}, which
 * is the one probe in this file that must NOT fail closed.
 *
 * The two kinds are worth telling apart because they send the user to different
 * places: `unreachable` means look at the URL, the DNS and whether the box is
 * up; `not-baalda` means the address is fine and something else is answering on
 * it (a proxy's default page, a different app, the wrong port).
 */
export class ServerCheckError extends Error {
  constructor(
    public kind: "unreachable" | "not-baalda",
    message: string,
  ) {
    super(message);
    this.name = "ServerCheckError";
  }
}

/** How long a server gets to answer `/health` before we call it unreachable. */
export const HEALTH_TIMEOUT_MS = 6000;

/**
 * Most doc ids one {@link ContextApi.accessCheck} call may carry.
 *
 * MIRRORS the server's `ACCESS_CHECK_MAX` (`http/routes/registry.ts`), which
 * answers 400 above it. The two cannot import from each other — separate
 * packages — so the equality is pinned by a test that reads the server source
 * (`__tests__/accessCheckBound.test.ts`). Drift here is not cosmetic: the client
 * treats a 400 as "no answer", so one oversized request turns every revocation
 * on a vault this large into a permanent, repeating failure.
 */
export const ACCESS_CHECK_MAX = 2000;

/**
 * Abort an access-check that has not answered in this long.
 *
 * The server resolves each id through `effectivePermission`, so its work grows
 * with the list. Generous enough for a full 2000-id slice on a remote database,
 * short enough that a wedged proxy does not hold up the pull that decides
 * whether files leave the disk. A timeout reads as "no answer", which removes
 * nothing.
 */
export const ACCESS_CHECK_TIMEOUT_MS = 30_000;

// The two things a person can actually act on. Kept as constants so the dialog
// and Settings → Connection say the same words for the same failure.
const UNREACHABLE_MESSAGE =
  "Couldn't reach that server. Check the URL and that it's online.";
const NOT_BAALDA_MESSAGE = "That address answered, but it isn't a Baalda server.";

type FetchLike = typeof fetch;

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string | null;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Override the generated client instance id (tests). See `getClientId`. */
  clientId?: string;
}

/** Header carrying `ApiClient.getClientId()`; mirrors the server's ORIGIN_HEADER. */
export const ORIGIN_HEADER = "x-baalda-origin";

/** A random opaque id for one app instance. */
function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

/**
 * Stateful client: holds the base URL + bearer token in memory. The auth
 * manager owns persistence (keychain) and calls `setToken`.
 */
export class ApiClient {
  private baseUrl: string;
  private token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly clientId: string;
  /**
   * Does THIS server speak the intent → PUT → complete upload flow?
   *
   * Tri-state on purpose: `null` = not asked yet (try it), `true` = yes,
   * `false` = it answered 404, so every later upload goes straight to the
   * legacy `POST /api/vaults/:id/blobs` without paying for a 404 first. The
   * answer belongs to ONE server, so {@link setBaseUrl} clears it — a user who
   * switches from the managed instance to a self-host they run from last
   * spring must not inherit the managed instance's capabilities.
   */
  private blobIntentSupported: boolean | null = null;
  /** Same tri-state for `GET /api/blobs/:id/url` (presigned download). */
  private blobUrlSupported: boolean | null = null;
  /** Same tri-state for `PUT /api/vaults/:id/blobs/:id/text` (extracted text).
   *  A 404 here means the server predates the route OR has forgotten the blob;
   *  either way there is nothing to retry, so the whole session stops asking. */
  private blobTextSupported: boolean | null = null;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_SERVER_URL);
    this.token = opts.token ?? null;
    // Bind so a destructured fetch keeps its `this` (window/globalThis).
    const f = opts.fetchImpl ?? fetch;
    this.fetchImpl = f === fetch ? f.bind(globalThis) : f;
    this.clientId = opts.clientId ?? newClientId();
  }

  /**
   * This app instance's opaque id. Sent on every HTTP call as `x-baalda-origin`
   * and in the vault channel's `hello`, so the server can tell "this structural
   * change came from the client I'm about to notify" and skip the round trip —
   * a reconcile no longer makes the server tell its author to re-pull its own
   * writes (one full ACL recompute per notification). Stable for the process,
   * meaningless across restarts, and never used for authorization.
   */
  getClientId(): string {
    return this.clientId;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
  setBaseUrl(url: string): void {
    const next = stripTrailingSlash(url);
    if (next !== this.baseUrl) {
      // Capabilities are per server (see `blobIntentSupported`).
      this.blobIntentSupported = null;
      this.blobUrlSupported = null;
      this.blobTextSupported = null;
    }
    this.baseUrl = next;
  }
  getToken(): string | null {
    return this.token;
  }
  setToken(token: string | null): void {
    this.token = token;
  }

  // ---- low-level request --------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      captureAuthToken?: boolean;
      query?: Record<string, string | undefined>;
      /**
       * Abort the request after this many ms.
       *
       * Off by default — most calls are small and the caller has nothing better
       * to do than wait. Set it where the SERVER's work is proportional to what
       * we asked for, so a slow answer is a real possibility rather than a
       * pathology: a host that accepts the connection and then takes minutes
       * leaves the caller hanging, and for the access-check that means a pull
       * that never finishes deciding whether to delete files.
       */
      timeoutMs?: number;
    } = {},
  ): Promise<{ data: T; authToken: string | null; status: number }> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      [ORIGIN_HEADER]: this.clientId,
    };
    // Better Auth requires an Origin (CSRF). In the Tauri webview the browser
    // sets the real webview origin (the server trusts it via trustedOrigins);
    // in Node (tests) fetch sends none, so we supply the server's own origin,
    // which Better Auth trusts by default. Browsers ignore this forbidden header.
    try {
      headers.Origin = new URL(this.baseUrl).origin;
    } catch {
      /* leave unset */
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let bodyInit: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs !== undefined) {
      controller = new AbortController();
      timer = setTimeout(() => controller?.abort(), opts.timeoutMs);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: bodyInit,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Better Auth returns the opaque session token in this header on sign-in/up.
    const authToken = opts.captureAuthToken ? res.headers.get("set-auth-token") : null;

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : undefined) ??
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : undefined) ??
        `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, parsed);
    }

    // The status rides along because a couple of routes say something in it that
    // the body does not: `POST /api/notes` answers 201 for a row it created and
    // 200 for one it adopted, and only the first is provably empty on the
    // server. Every other caller destructures `data` and never sees this.
    return { data: parsed as T, authToken, status: res.status };
  }

  // ---- Reachability -------------------------------------------------------

  /**
   * Is there a Baalda server at this address? Resolves if yes, throws a
   * {@link ServerCheckError} if no.
   *
   * The ONE probe in this file that fails OPEN, and it exists precisely because
   * the other two don't. `getAuthMethods` and `getBillingConfig` are capability
   * probes: they swallow every failure and answer "not configured", which is
   * right for deciding whether to draw a button and useless for telling someone
   * their server URL is wrong. Building the onboarding check on either of them
   * would report "connected" for a typo'd hostname.
   *
   * Takes an explicit `baseUrl` because it runs BEFORE the URL is adopted —
   * validating a candidate must not disturb the client's current base or its
   * token. It also sends no `Authorization`: `/health` is public, and the point
   * is to test the address, not the session.
   *
   * `AbortController` rather than a bare `fetch`: a host that accepts the TCP
   * connection and then says nothing (a firewall, a hung proxy) would otherwise
   * leave the Connect button spinning indefinitely.
   */
  async health(baseUrl?: string): Promise<void> {
    const base = stripTrailingSlash((baseUrl ?? this.baseUrl).trim());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/health`, {
        method: "GET",
        headers: { Accept: "application/json", [ORIGIN_HEADER]: this.clientId },
        signal: controller.signal,
      });
    } catch {
      // A timeout, DNS failure, refused connection and a CSP block all land
      // here, and the webview reports the last one as a bare `TypeError: Load
      // failed` — so the message stays about the address rather than guessing.
      throw new ServerCheckError("unreachable", UNREACHABLE_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
    // A 5xx is the server's own, or a proxy in front of it saying the app is
    // down — "check it's online" is the useful thing to say, not "wrong app".
    if (res.status >= 500) throw new ServerCheckError("unreachable", UNREACHABLE_MESSAGE);
    if (!res.ok) throw new ServerCheckError("not-baalda", NOT_BAALDA_MESSAGE);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 200 with HTML: something is there, it just isn't us.
      throw new ServerCheckError("not-baalda", NOT_BAALDA_MESSAGE);
    }
    const ok =
      !!parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === true;
    if (!ok) throw new ServerCheckError("not-baalda", NOT_BAALDA_MESSAGE);
  }

  // ---- Auth (Better Auth) -------------------------------------------------

  /** Sign up with email+password. Returns the session token to persist. */
  async signUp(input: { email: string; password: string; name: string }): Promise<{
    user: AuthUser;
    token: string | null;
  }> {
    const { data, authToken } = await this.request<{ user: AuthUser; token?: string }>(
      "POST",
      "/api/auth/sign-up/email",
      { body: input, captureAuthToken: true },
    );
    const token = authToken ?? data.token ?? null;
    if (token) this.token = token;
    return { user: data.user, token };
  }

  /** Sign in with email+password. Returns the session token to persist. */
  async signIn(input: { email: string; password: string }): Promise<{
    user: AuthUser;
    token: string | null;
  }> {
    const { data, authToken } = await this.request<{ user: AuthUser; token?: string }>(
      "POST",
      "/api/auth/sign-in/email",
      { body: input, captureAuthToken: true },
    );
    const token = authToken ?? data.token ?? null;
    if (token) this.token = token;
    return { user: data.user, token };
  }

  async signOut(): Promise<void> {
    try {
      await this.request<unknown>("POST", "/api/auth/sign-out", { body: {} });
    } finally {
      this.token = null;
    }
  }

  /**
   * Update the signed-in user's profile. Better Auth stores `name` and `image`
   * (avatar URL) on the user, so these follow the account across devices and
   * every vault. Callers re-fetch the session afterward to pick up the
   * updated user object.
   */
  async updateUser(input: { name?: string; image?: string | null }): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/update-user", { body: input });
  }

  // ---- Google sign-in (social, via desktop loopback) ----------------------

  /**
   * Which sign-in methods the server offers (Google, password reset and invite
   * email are all config-gated).
   *
   * Every field beyond `emailPassword` is read with `!!`, so an OLDER server
   * that answers only `{ emailPassword, google }` reports the new capabilities
   * as absent — which is the right answer for it, and the reason the UI hides
   * "Forgot password?" rather than offering a route that silently does nothing.
   */
  async getAuthMethods(): Promise<AuthMethods> {
    try {
      const { data } = await this.request<Partial<AuthMethods>>("GET", "/api/auth-methods");
      return {
        emailPassword: data.emailPassword !== false,
        google: !!data.google,
        passwordReset: !!data.passwordReset,
        invitationEmail: !!data.invitationEmail,
      };
    } catch {
      // Fails CLOSED, and deliberately so: an older/self-hosted server without
      // this endpoint should hide the Google button rather than offer a route
      // that cannot work. Note the cost of that choice — a plain network failure
      // (server down, wrong URL, CSP blocking us) is indistinguishable here from
      // "Google not configured", so a hidden Google button is not proof the
      // server lacks it. Check /api/auth-methods with curl before believing it.
      return {
        emailPassword: true,
        google: false,
        passwordReset: false,
        invitationEmail: false,
      };
    }
  }

  /**
   * Ask the server to email a password-reset link — and learn what happened.
   *
   * Our own route, not Better Auth's `request-password-reset`: that one answers
   * the same neutral sentence whether the address is unknown, the send failed
   * or the mail went out. This one resolves only when the provider accepted the
   * message, and otherwise throws an `ApiError` whose body carries `error`:
   * `no_account` (404), `send_failed` (502), `too_many_requests` (429) or
   * `email_not_configured` (400). `lib/resetFlow.ts` turns those into copy.
   */
  async requestPasswordReset(email: string): Promise<void> {
    await this.request<unknown>("POST", "/api/password-reset/request", {
      body: { email },
    });
  }

  /**
   * Email an invitation's link to its address. Resolves when the provider took
   * the message; throws `ApiError` with body `error` = `send_failed` (502),
   * `email_not_configured` (400) or `invitation_not_pending` (410). Called
   * right after {@link inviteMember} — creating the invitation sends nothing by
   * itself, precisely so the admin can be told whether the email went out.
   */
  async sendInvitationEmail(invitationId: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/api/invitations/${encodeURIComponent(invitationId)}/send`,
    );
  }

  /** Re-send the sign-up confirmation email for the signed-in address. */
  async sendVerificationEmail(email: string): Promise<void> {
    // The server builds its own link and ignores callbackURL, but Better Auth's
    // schema requires the field.
    await this.request<unknown>("POST", "/api/auth/send-verification-email", {
      body: { email, callbackURL: "/email-verified" },
    });
  }

  /**
   * Kick off a social sign-in and get the provider's authorization URL to open
   * in the system browser. `callbackURL` is where the server bounces the browser
   * after the OAuth callback (our /api/desktop-auth/finish handoff).
   */
  async socialSignInUrl(provider: "google", callbackURL: string): Promise<string> {
    const { data } = await this.request<{ url?: string; redirect?: boolean }>(
      "POST",
      "/api/auth/sign-in/social",
      { body: { provider, callbackURL } },
    );
    if (!data?.url) {
      throw new ApiError(500, "Server did not return an authorization URL");
    }
    return data.url;
  }

  /** Redeem the one-time handoff code for the session token + user. */
  async exchangeDesktopCode(code: string): Promise<{ user: AuthUser; token: string }> {
    const { data } = await this.request<{ token: string; user: AuthUser }>(
      "POST",
      "/api/desktop-auth/exchange",
      { body: { code } },
    );
    if (data.token) this.token = data.token;
    return { user: data.user, token: data.token };
  }

  /** Current session, or null if the token is missing/expired/revoked. */
  async getSession(): Promise<SessionInfo | null> {
    if (!this.token) return null;
    try {
      const { data } = await this.request<{
        user: AuthUser;
        session: { activeOrganizationId?: string | null };
      } | null>("GET", "/api/auth/get-session");
      // Better Auth signals "no active session" with a literal `null` body — the
      // only response that should drop the stored token. A well-formed session
      // has a `user`. Anything else (an empty body, a proxy's HTML error page
      // that happened to return 200, an API contract drift) is NOT a trustworthy
      // "signed out" signal: throwing keeps the token so the caller can retry,
      // instead of logging the user out over a transient hiccup.
      if (data == null) return null;
      if (typeof data === "object" && (data as { user?: unknown }).user) {
        return {
          user: data.user,
          activeOrganizationId: data.session?.activeOrganizationId ?? null,
        };
      }
      throw new ApiError(0, "Unexpected get-session response shape");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    }
  }

  // ---- Organizations (org plugin) -----------------------------------------

  async createOrganization(input: { name: string; slug: string }): Promise<Organization> {
    const { data } = await this.request<Organization>("POST", "/api/auth/organization/create", {
      body: input,
    });
    return data;
  }

  async listOrganizations(): Promise<Organization[]> {
    const { data } = await this.request<Organization[]>("GET", "/api/auth/organization/list");
    // Dedupe by id: a user can transiently hold more than one membership row for
    // the same org (invite + join code both add a member), which would otherwise
    // show the same vault twice in the switcher. See issue #14.
    const byId = new Map<string, Organization>();
    for (const org of data ?? []) if (!byId.has(org.id)) byId.set(org.id, org);
    return [...byId.values()];
  }

  async setActiveOrganization(organizationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/set-active", {
      body: { organizationId },
    });
  }

  async listMembers(organizationId?: string): Promise<Member[]> {
    const { data } = await this.request<{ members: Member[] } | Member[]>(
      "GET",
      "/api/auth/organization/list-members",
      { query: organizationId ? { organizationId } : undefined },
    );
    return Array.isArray(data) ? data : (data?.members ?? []);
  }

  async inviteMember(input: {
    email: string;
    role: "member" | "admin" | "owner";
    organizationId?: string;
  }): Promise<Invitation> {
    const { data } = await this.request<Invitation>(
      "POST",
      "/api/auth/organization/invite-member",
      { body: input },
    );
    return data;
  }

  /** Invitations pending on the ACTIVE organization (admin view). */
  async listInvitations(organizationId?: string): Promise<Invitation[]> {
    const { data } = await this.request<{ invitations: Invitation[] } | Invitation[]>(
      "GET",
      "/api/auth/organization/list-invitations",
      { query: organizationId ? { organizationId } : undefined },
    );
    return Array.isArray(data) ? data : (data?.invitations ?? []);
  }

  /** Kill a pending invitation (owner/admin). The link stops working at once. */
  async cancelInvitation(invitationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/cancel-invitation", {
      body: { invitationId },
    });
  }

  /**
   * What an invitation id names — vault, inviter, invited address, status.
   *
   * Public on the server (the id is the capability), so this works signed out
   * and on whatever server the app is currently pointed at. A bearer header
   * still rides along when we have one; the route ignores it.
   *
   * Throws `ApiError` 404 for an id the server doesn't know, which is what the
   * caller maps to "expired or already used" — an unknown id and a consumed
   * one must stay indistinguishable.
   */
  async previewInvitation(invitationId: string): Promise<InvitationPreview> {
    const { data } = await this.request<InvitationPreview>(
      "GET",
      `/api/invitations/${encodeURIComponent(invitationId)}/preview`,
    );
    return data;
  }

  /**
   * Invitations addressed to the signed-in user (invitee view).
   *
   * Our own `/api/invitations/mine` FIRST, Better Auth's route only as a 404
   * fallback for an older self-hosted server. Better Auth's
   * `list-user-invitations` answers 403 for any user whose email isn't
   * verified — which is every password sign-up — so the in-app invite inbox was
   * silently empty for exactly the people who most needed it.
   */
  async listUserInvitations(): Promise<Invitation[]> {
    try {
      const { data } = await this.request<{ invitations: Invitation[] } | Invitation[]>(
        "GET",
        "/api/invitations/mine",
      );
      return Array.isArray(data) ? data : (data?.invitations ?? []);
    } catch (e) {
      // Only a missing ROUTE falls back. A 403/500 from our own endpoint is a
      // real failure and must not be papered over with a call that returns 403
      // for the same user anyway.
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    const { data } = await this.request<{ invitations: Invitation[] } | Invitation[]>(
      "GET",
      "/api/auth/organization/list-user-invitations",
    );
    return Array.isArray(data) ? data : (data?.invitations ?? []);
  }

  async acceptInvitation(invitationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/accept-invitation", {
      body: { invitationId },
    });
  }

  async rejectInvitation(invitationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/reject-invitation", {
      body: { invitationId },
    });
  }

  // ---- Join codes -----------------------------------------------------------

  /** The active vault's shareable join code (owner/admin; lazily created). */
  async getJoinCode(): Promise<string> {
    const { data } = await this.request<{ code: string }>("GET", "/api/orgs/join-code");
    return data.code;
  }

  /** Join a vault by its shared code (any signed-in user). */
  async joinVault(code: string): Promise<{
    organizationId: string;
    name?: string;
    alreadyMember?: boolean;
  }> {
    const { data } = await this.request<{
      organizationId: string;
      name?: string;
      alreadyMember?: boolean;
    }>("POST", "/api/orgs/join", { body: { code } });
    return data;
  }

  /**
   * Permanently delete a vault and all its server data (owner only). The server
   * cascades members/note-collections/folders/notes/shares and purges the FK-less
   * CRDT stores. Throws ApiError 403 if the caller isn't the owner.
   * (The vault's server identity is the Better Auth organization id.)
   *
   * A vault on Pro is cancelled at the provider FIRST, at the period end; if
   * the provider refuses, nothing is deleted and this throws 502
   * `subscription_cancel_failed` (#111). On success `subscription` says when
   * the paid period runs out — until then it can be moved to another vault.
   */
  async deleteRemoteVault(organizationId: string): Promise<VaultDeleteResult> {
    const { data } = await this.request<VaultDeleteResult>(
      "DELETE",
      `/api/orgs/${encodeURIComponent(organizationId)}`,
    );
    return data;
  }

  /**
   * What making this vault local only would destroy (owner only). Pure counting
   * — nothing is changed. Throws ApiError 403 `owner_only` for anyone else and
   * 404 `vault_not_found` for a vault that is already gone.
   */
  async getUnsyncPreview(organizationId: string): Promise<UnsyncPreview> {
    const { data } = await this.request<UnsyncPreview>(
      "GET",
      `/api/orgs/${encodeURIComponent(organizationId)}/unsync-preview`,
    );
    return data;
  }

  /**
   * Make a vault local only (owner only): the server deletes everything it
   * holds for the vault — notes, files, history, shares, links, tokens — and
   * the caller keeps its `.md` files on disk.
   *
   * `confirmName` must equal the vault's name; the server answers 409
   * `name_mismatch` otherwise and destroys NOTHING. Same billing rule as
   * `deleteRemoteVault`: a paid vault is cancelled at the provider first and a
   * provider refusal aborts the whole thing with 502
   * `subscription_cancel_failed`, so a throw here means the server copy is
   * still intact — which is exactly why the caller must not touch this device
   * until this resolves.
   */
  async unsyncVault(organizationId: string, confirmName: string): Promise<UnsyncResult> {
    const { data } = await this.request<UnsyncResult>(
      "POST",
      `/api/orgs/${encodeURIComponent(organizationId)}/unsync`,
      { body: { confirmName } },
    );
    return data;
  }

  /**
   * Does this vault still exist, and are we in it? The one probe that can tell
   * "the owner made it local only" apart from "it is another account's vault" —
   * a folder stamped for an org we cannot see looks identical in both cases,
   * and only the first one deserves the recovery banner.
   *
   * Never throws: every refusal becomes an {@link OrgStatus}, and an
   * unreachable server answers `unknown` so the caller stays silent rather than
   * accusing a perfectly good folder.
   */
  async getOrgStatus(organizationId: string): Promise<OrgStatus> {
    try {
      const { data } = await this.request<{ orgId: string; name: string; role: string }>(
        "GET",
        `/api/orgs/${encodeURIComponent(organizationId)}/status`,
      );
      return { kind: "member", orgId: data.orgId, name: data.name, role: data.role };
    } catch (e) {
      if (e instanceof ApiError) {
        // The code is the contract, the status is the fallback — same rule as
        // `blobErrorCode`, so an older server that sends a bare status still
        // lands in the right branch.
        const code = errorCodeOf(e.body);
        if (code === "vault_not_found" || e.status === 404) return { kind: "vault-not-found" };
        if (code === "not_a_member" || e.status === 403) return { kind: "not-a-member" };
      }
      return { kind: "unknown" };
    }
  }

  /**
   * Remove a member from a vault (owner/admin). The server deletes the
   * membership, purges any shares granted directly to that user, and force-closes
   * their live sync sockets so access is revoked immediately. Throws ApiError 403
   * if the caller lacks permission (e.g. an admin trying to remove another admin).
   */
  async removeMember(organizationId: string, userId: string): Promise<void> {
    await this.request<{ removed: boolean }>(
      "DELETE",
      `/api/orgs/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
    );
  }

  /**
   * Leave a vault you don't own (#121). The server drops the membership, purges
   * shares granted directly to you, unpins the vault from your sessions and
   * force-closes your live sync sockets — the same teardown as being removed by
   * an admin. Throws ApiError 409 `owner_cannot_leave` for the owner (their exit
   * is deleteRemoteVault) and 404 when you aren't a member.
   */
  async leaveVault(organizationId: string): Promise<void> {
    await this.request<{ left: boolean }>(
      "POST",
      `/api/orgs/${encodeURIComponent(organizationId)}/leave`,
    );
  }

  /**
   * Change a member's role (owner/admin). Same authz shape as removeMember:
   * an admin may only change plain members; nobody touches the owner or
   * themselves. The server force-closes the member's live sync sockets so the
   * new role applies immediately, not at token expiry.
   */
  async updateMemberRole(
    organizationId: string,
    userId: string,
    role: "member" | "admin",
  ): Promise<void> {
    await this.request<{ updated: boolean }>(
      "PATCH",
      `/api/orgs/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { body: { role } },
    );
  }

  // ---- MCP tokens ---------------------------------------------------------

  /** The MCP endpoint URL for this server (what an AI client connects to). */
  mcpUrl(): string {
    return `${this.baseUrl}/api/mcp`;
  }

  /** The caller's MCP tokens for the active vault (metadata only). */
  async listMcpTokens(): Promise<McpTokenRow[]> {
    return (await this.listMcpConnections()).tokens;
  }

  /**
   * The caller's MCP connections for the active vault: each token (with live
   * usage/activity metadata) plus the shared tool catalog every one can reach.
   */
  async listMcpConnections(): Promise<McpConnections> {
    const { data } = await this.request<McpConnections>("GET", "/api/mcp/tokens");
    return { tokens: data.tokens ?? [], tools: data.tools ?? [] };
  }

  /** Mint a new MCP token. The `token` field is the plaintext — shown once. */
  async createMcpToken(name: string): Promise<McpTokenRow & { token: string }> {
    const { data } = await this.request<McpTokenRow & { token: string }>(
      "POST",
      "/api/mcp/tokens",
      { body: { name } },
    );
    return data;
  }

  async revokeMcpToken(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/mcp/tokens/${encodeURIComponent(id)}`);
  }

  // ---- Public links ---------------------------------------------------------

  /**
   * Create-or-get the note's public browser link (`https://<server>/p/<token>`).
   * Repeated calls return the SAME url until it's revoked; gated server-side
   * like share management (owner/admin or the note's creator).
   */
  async createPublicLink(docId: string): Promise<PublicLink> {
    const { data } = await this.request<PublicLink>(
      "POST",
      `/api/notes/${encodeURIComponent(docId)}/public-link`,
    );
    return data;
  }

  /** The note's public link if one exists, else null. */
  async getPublicLink(docId: string): Promise<PublicLink | null> {
    const { data } = await this.request<{ link: PublicLink | null }>(
      "GET",
      `/api/notes/${encodeURIComponent(docId)}/public-link`,
    );
    return data.link ?? null;
  }

  /** Kill the note's public link — the old url 404s immediately. */
  async revokePublicLink(docId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/notes/${encodeURIComponent(docId)}/public-link`,
    );
  }

  // ---- Billing (subscription) ---------------------------------------------

  /**
   * Server billing capability. Public (no auth). Mirrors {@link getAuthMethods}'
   * capability-probe pattern: ANY failure (older/self-hosted server without the
   * endpoint, network error) is treated as "billing disabled" so the UI simply
   * hides all billing affordances and enforces no limits.
   */
  async getBillingConfig(): Promise<BillingConfig> {
    try {
      const { data } = await this.request<BillingConfig>("GET", "/api/billing/config");
      if (!data || data.enabled !== true) return { enabled: false };
      return { enabled: true, plans: data.plans, freeLimits: data.freeLimits };
    } catch {
      return { enabled: false };
    }
  }

  /** A vault's subscription state + seat usage (any member of the org). */
  async getOrgBilling(orgId: string): Promise<OrgBilling> {
    const { data } = await this.request<OrgBilling>(
      "GET",
      `/api/billing/orgs/${encodeURIComponent(orgId)}`,
    );
    return data;
  }

  /** Start a hosted checkout for the org; returns the URL to open (owner/admin). */
  async createBillingCheckout(
    orgId: string,
    interval: "month" | "year",
  ): Promise<{ url: string }> {
    const { data } = await this.request<{ url: string }>(
      "POST",
      `/api/billing/orgs/${encodeURIComponent(orgId)}/checkout`,
      { body: { interval } },
    );
    return data;
  }

  /** Get the customer portal URL to manage/cancel the subscription (owner/admin). */
  async getBillingPortalUrl(orgId: string): Promise<{ url: string }> {
    const { data } = await this.request<{ url: string }>(
      "POST",
      `/api/billing/orgs/${encodeURIComponent(orgId)}/portal`,
    );
    return data;
  }

  /**
   * Every vault the caller belongs to with its plan/seats/role, plus any
   * subscription left behind by a deleted vault. One request rather than an
   * N+1 over {@link getOrgBilling}: the server also reconciles stale rows
   * against the provider while it is in there.
   */
  async getMyBilling(): Promise<MyBilling> {
    const { data } = await this.request<MyBilling>("GET", "/api/billing/mine");
    return data;
  }

  /**
   * Cancel a vault's subscription (owner only; admins use the portal).
   * `period_end` keeps the paid time and stops the next charge; `now` revokes
   * immediately — which is what a subscription from an already-deleted vault
   * wants, since there is no vault left to spend the rest of the period on.
   */
  async cancelSubscription(
    orgId: string,
    mode: "period_end" | "now",
  ): Promise<OrgBilling> {
    const { data } = await this.request<OrgBilling>(
      "POST",
      `/api/billing/orgs/${encodeURIComponent(orgId)}/cancel`,
      { body: { mode } },
    );
    return data;
  }

  /**
   * Move a live subscription from one vault to another the caller owns. The
   * source may be a deleted vault's tombstone, which is the whole point: it
   * turns "I deleted the wrong vault" into a recoverable mistake instead of a
   * refund request. Un-cancels at the provider when the source was set to
   * cancel at the period end.
   */
  async transferSubscription(
    sourceOrgId: string,
    targetOrgId: string,
  ): Promise<{ transferred: boolean; orgId: string; billing: OrgBilling }> {
    const { data } = await this.request<{
      transferred: boolean;
      orgId: string;
      billing: OrgBilling;
    }>("POST", `/api/billing/orgs/${encodeURIComponent(sourceOrgId)}/transfer`, {
      body: { targetOrgId },
    });
    return data;
  }

  // ---- Registry -----------------------------------------------------------

  async listVaults(): Promise<Vault[]> {
    const { data } = await this.request<{ vaults: Vault[] }>("GET", "/api/vaults");
    return data.vaults ?? [];
  }

  async createVault(input: { name: string; organizationId?: string }): Promise<Vault> {
    const { data } = await this.request<Vault>("POST", "/api/vaults", { body: input });
    return data;
  }

  /** Flip a vault-level latch (today: `rootFrozen`). Owner/admin only. */
  async updateVaultSettings(
    vaultId: string,
    input: { rootFrozen: boolean },
  ): Promise<{ id: string; name: string; rootFrozen: boolean }> {
    const { data } = await this.request<{ id: string; name: string; rootFrozen: boolean }>(
      "PATCH",
      `/api/vaults/${encodeURIComponent(vaultId)}`,
      { body: input },
    );
    return data;
  }

  /**
   * The vault's whole structure for the Access panel - ids and paths only, not
   * ACL-filtered. Owner/admin only (403 otherwise).
   *
   * Separate from {@link listFolders}/{@link listNotes} on purpose: those feed
   * the reconciler and MUST stay filtered, or the client would materialise notes
   * it has no right to sync. This one exists so an item you have made Private is
   * still administrable - it has left your disk, and the panel used to draw its
   * list from your disk.
   */
  async listAccessTree(vaultId: string): Promise<AccessTreeResponse> {
    const { data } = await this.request<AccessTreeResponse>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/access-tree`,
    );
    return { folders: data.folders ?? [], notes: data.notes ?? [], files: data.files ?? [] };
  }

  async listFolders(vaultId: string): Promise<RegisteredFolder[]> {
    const { data } = await this.request<{ folders: RegisteredFolder[] }>("GET", "/api/folders", {
      query: { vaultId },
    });
    return data.folders ?? [];
  }

  /**
   * The registry pull's view of a vault's folders: the folders the server will
   * show us, plus the folder ids it says are **deleted**.
   *
   * Same `null`-vs-`[]` contract as {@link listNoteRegistry}: `tombstones: null`
   * means the server did not answer (an older server), and the reconciler must
   * never remove or suppress a folder on the strength of "I don't know".
   */
  async listFolderRegistry(
    vaultId: string,
  ): Promise<{ folders: RegisteredFolder[]; tombstones: string[] | null }> {
    const { data } = await this.request<{
      folders: RegisteredFolder[];
      tombstones?: string[];
    }>("GET", "/api/folders", { query: { vaultId } });
    return {
      folders: data.folders ?? [],
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : null,
    };
  }

  async createFolder(input: {
    vaultId: string;
    name: string;
    path: string;
    parentId?: string | null;
  }): Promise<RegisteredFolder> {
    const { data } = await this.request<RegisteredFolder>("POST", "/api/folders", { body: input });
    return data;
  }

  /** Rename/move a folder (rewrites descendant paths server-side; id stays). */
  async updateFolder(
    id: string,
    input: { name?: string; path?: string; parentId?: string | null; color?: string | null },
  ): Promise<RegisteredFolder> {
    const { data } = await this.request<RegisteredFolder>(
      "PATCH",
      `/api/folders/${encodeURIComponent(id)}`,
      { body: input },
    );
    return data;
  }

  /** Delete a folder subtree (soft-deletes its notes). */
  async deleteFolder(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/folders/${encodeURIComponent(id)}`);
  }

  /**
   * Ask the server, per doc, whether the caller still has ANY access — the
   * second opinion the inbound reconciler needs before it deletes files.
   *
   * `GET /api/notes` and the vault channel's `ready.revoked` are the same
   * resolver read twice (`listReadableDocsInVault`), so they cannot corroborate
   * each other: one regression inside it produces both an empty listing and a
   * "these are revoked" announcement, which together are exactly the authority
   * needed to wipe a member's disk. This route answers through
   * `permissions/resolver.ts effectivePermission` instead — different SQL, a
   * different walk — so a disagreement is detectable, and a disagreement means
   * the file stays.
   *
   * Returns the subset that resolves to NO access. A throw means "no answer",
   * and the caller's rule for that is to remove nothing.
   */
  async accessCheck(vaultId: string, docIds: string[]): Promise<string[]> {
    const { data } = await this.request<{ none: string[] }>(
      "POST",
      `/api/vaults/${encodeURIComponent(vaultId)}/access-check`,
      { body: { docIds }, timeoutMs: ACCESS_CHECK_TIMEOUT_MS },
    );
    return data.none ?? [];
  }

  async listNotes(vaultId: string): Promise<RegisteredNote[]> {
    const { data } = await this.request<{ notes: RegisteredNote[] }>("GET", "/api/notes", {
      query: { vaultId },
    });
    return data.notes ?? [];
  }

  /**
   * The registry pull's view of a vault: the notes the server will show us, plus
   * the doc_ids it says are **deleted**.
   *
   * `tombstones: null` means the server did not answer the question — an older
   * server, a proxy that dropped the field, a truncated body. It is NOT the same
   * as `[]` ("nothing is deleted"), and the reconciler must never infer a delete
   * from `null`, because the fallback for "I don't know" has to be "leave the
   * user's files alone".
   */
  async listNoteRegistry(
    vaultId: string,
  ): Promise<{ notes: RegisteredNote[]; tombstones: string[] | null }> {
    const { data } = await this.request<{ notes: RegisteredNote[]; tombstones?: string[] }>(
      "GET",
      "/api/notes",
      { query: { vaultId } },
    );
    return {
      notes: data.notes ?? [],
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : null,
    };
  }

  /**
   * Register one note. `created` distinguishes the two 2xx answers this route
   * gives (201 a new row, 200 an existing one adopted by path/doc_id) — the
   * single-note twin of the batch route's `status: "created" | "adopted"`, and
   * the same question: a row the server just made holds no CRDT, so it can be
   * seeded in bulk; an adopted one may hold a teammate's content.
   *
   * Optional on purpose: absent reads as "not known to be new", which is the
   * safe direction — the caller simply does not announce it.
   */
  async createNote(input: {
    vaultId: string;
    relPath: string;
    title?: string | null;
    folderId?: string | null;
    docId?: string;
  }): Promise<RegisteredNote & { created?: boolean }> {
    const { data, status } = await this.request<RegisteredNote>("POST", "/api/notes", {
      body: input,
    });
    return { ...data, created: status === 201 };
  }

  /** Rename/move a note (rel_path/folder/title); doc_id is unchanged. */
  async updateNote(
    id: string,
    input: {
      relPath?: string;
      title?: string | null;
      folderId?: string | null;
      color?: string | null;
    },
  ): Promise<RegisteredNote> {
    const { data } = await this.request<RegisteredNote>(
      "PATCH",
      `/api/notes/${encodeURIComponent(id)}`,
      { body: input },
    );
    return data;
  }

  /** Soft-delete a note (keeps its doc_id row; drops it from the registry list). */
  async deleteNote(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/notes/${encodeURIComponent(id)}`);
  }

  /**
   * Register a tree binary as a `files` row, so its blob has a doc_id the
   * permission resolver understands.
   *
   * `id` is the LOCAL `files.id` (a uuid the SQLite index keeps stable per path
   * across rebuilds), supplied the way `createNote` supplies a note's docId, so
   * this device's index and the server name the same identity. `folderId` is
   * deliberately not sent: the server resolves the parent from the path
   * (`resolveParentFolder`), which is the rule that keeps `rel_path` and
   * `folder_id` in agreement — a mismatch comes back as 400
   * `path_folder_mismatch`.
   */
  async registerFile(input: {
    vaultId: string;
    id: string;
    path: string;
  }): Promise<RegisteredFile> {
    // `/api/files`, not `/api/registry/files`: the registry router is mounted at
    // `/api` (see the server's `http/app.ts`), exactly like `/api/notes` and
    // `/api/folders` beside it.
    const { data } = await this.request<RegisteredFile>("POST", "/api/files", {
      body: { vaultId: input.vaultId, path: input.path, docId: input.id },
    });
    return data;
  }

  /**
   * Delete a tree file — the `files` row and the blob that IS its bytes.
   *
   * Not the note's soft delete: a file owns no CRDT and `files` has no
   * tombstone, so the server removes it outright (`DELETE /api/files/:id`).
   * That is what takes it out of `GET /vaults/:id/blobs`, and therefore what
   * stops the next attachment pass downloading it straight back onto the disk
   * it was just deleted from.
   *
   * Idempotent by design at the other end: an id with no row answers 204, so a
   * queue draining twice is not an error.
   */
  async deleteFile(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/files/${encodeURIComponent(id)}`);
  }

  /**
   * Delete one blob by id — the hidden `attachments/` store's half of the same
   * job, where there is no `files` row to delete.
   *
   * `force` is deliberately NOT exposed as a default: without it the server
   * answers 409 `blob_referenced` when a note still embeds those bytes, and
   * that refusal is the point — an image a teammate's note shows must not
   * vanish because one device tidied its `attachments/` folder.
   */
  async deleteBlob(id: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.request<unknown>("DELETE", `/api/blobs/${encodeURIComponent(id)}`, {
      query: opts.force ? { force: "1" } : undefined,
    });
  }

  // ---- Bulk sync engine (batch registry, batched push, bootstrap) ---------
  //
  // Every route here is NEW. A server that predates them answers 404, and a 404
  // on any of them is terminal `server_too_old` — deliberately NOT the tri-state
  // capability memo `blobIntentSupported` uses, which exists to degrade
  // silently. Degrading silently here would put a 5,000-note vault back on the
  // per-note path at 3.7 notes/second and call it success.

  /**
   * Register folders in bulk. No `parentId`: the server sorts by depth and
   * resolves parents inside the request, which deletes the client's
   * level-by-level loop.
   */
  async batchCreateFolders(
    vaultId: string,
    items: FolderBatchItem[],
  ): Promise<FolderBatchResult[]> {
    return this.bulk<{ results: FolderBatchResult[] }>(
      `/api/vaults/${encodeURIComponent(vaultId)}/folders/batch`,
      { items },
    ).then((d) => d.results ?? []);
  }

  /** Register notes in bulk. `folderPath`, never `folderId` — see the type. */
  async batchCreateNotes(
    vaultId: string,
    items: NoteBatchItem[],
  ): Promise<NoteBatchResult[]> {
    return this.bulk<{ results: NoteBatchResult[] }>(
      `/api/vaults/${encodeURIComponent(vaultId)}/notes/batch`,
      { items },
    ).then((d) => d.results ?? []);
  }

  /** Register tree binaries (`files` rows) in bulk. */
  async batchCreateFiles(
    vaultId: string,
    items: FileBatchItem[],
  ): Promise<FileBatchResult[]> {
    return this.bulk<{ results: FileBatchResult[] }>(
      `/api/vaults/${encodeURIComponent(vaultId)}/files/batch`,
      { items },
    ).then((d) => d.results ?? []);
  }

  /**
   * Push N docs' CRDT state in one request (base64 Yjs V1 per doc).
   *
   * The caller packs by BYTES as well as by count — see `BATCH_MAX_DOCS` /
   * `BATCH_MAX_DECODED_BYTES` in `sync/pool.ts`, which mirror the server's
   * limits; overshooting them is `batch_too_large`, not a truncated apply.
   */
  async batchPushDocs(vaultId: string, items: DocPushItem[]): Promise<DocPushResult[]> {
    return this.bulk<{ results: DocPushResult[] }>(
      `/api/vaults/${encodeURIComponent(vaultId)}/docs/batch`,
      { items },
    ).then((d) => d.results ?? []);
  }

  /**
   * Soft-delete N notes in one request — the batched twin of
   * {@link ApiClient.deleteNote}, same write, same broadcast, one of each.
   *
   * Chunking is the CALLER's (`registry.deletePaths`, at `BATCH_MAX_NOTES`):
   * this method sends exactly what it is given, so an over-long list comes back
   * as `batch_too_large` rather than being silently truncated here. The answer
   * is per item, in request order, and a 404 on the route is the usual terminal
   * `server_too_old` — a server that predates it still has the per-note DELETE.
   */
  async deleteNotesBatch(vaultId: string, docIds: string[]): Promise<NoteDeleteResult[]> {
    return this.bulk<{ results: NoteDeleteResult[] }>(
      `/api/vaults/${encodeURIComponent(vaultId)}/notes/delete-batch`,
      { docIds },
    ).then((d) => d.results ?? []);
  }

  /**
   * Open a bootstrap session: the server takes one snapshot of what this member
   * may read and pages it out from a cursor.
   *
   * `have` is the docIds this device already holds CRDT state for — the server
   * subtracts them from the download set, so a second device with most of the
   * vault pays for the difference and not for the vault.
   */
  async createBootstrapSession(
    vaultId: string,
    have: string[] = [],
  ): Promise<BootstrapSession> {
    const data = await this.bulk<BootstrapSession>(
      `/api/vaults/${encodeURIComponent(vaultId)}/bootstrap`,
      have.length > 0 ? { have } : {},
    );
    return {
      sessionId: data.sessionId,
      docs: data.docs ?? 0,
      bytes: data.bytes ?? 0,
      emptyDocs: data.emptyDocs ?? [],
      emptyTruncated: data.emptyTruncated === true,
      expiresAt: data.expiresAt ?? "",
    };
  }

  /**
   * Fetch one page of a bootstrap session: gzip binary, decoded by
   * `sync/bootstrapCodec.ts`.
   *
   * Bypasses {@link ApiClient.request} on purpose — the body is bytes, not JSON
   * — and is modelled on {@link ApiClient.downloadBlob}/{@link
   * ApiClient.downloadBytesFrom}. `Content-Encoding: gzip` is handled by the
   * fetch stack itself, so what lands here is already the plain page.
   *
   * Three statuses carry meaning rather than failure: 410 `session_expired`
   * (the caller re-POSTs with a fresh `have`), 503 `bootstrap_busy` with a
   * `Retry-After` (the server's bootstrap semaphore is full), and 404
   * `server_too_old`.
   */
  async fetchBootstrapPage(
    vaultId: string,
    sessionId: string,
    opts: { cursor?: number; maxBytes?: number } = {},
  ): Promise<BootstrapPageResponse> {
    const url = new URL(
      `${this.baseUrl}/api/vaults/${encodeURIComponent(vaultId)}/bootstrap/${encodeURIComponent(sessionId)}`,
    );
    if (opts.cursor !== undefined) url.searchParams.set("cursor", String(opts.cursor));
    if (opts.maxBytes !== undefined) url.searchParams.set("maxBytes", String(opts.maxBytes));
    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { ...this.baseHeaders(), [ORIGIN_HEADER]: this.clientId },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        /* a plain-text body is fine; `bulkCodeFor` falls back to the status */
      }
      throw new BulkApiError(
        res.status,
        bulkCodeFor(res.status, parsed),
        text || `HTTP ${res.status}`,
        parsed,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    const cursorHeader = res.headers.get("x-baalda-cursor");
    const body = new Uint8Array(await res.arrayBuffer());
    return {
      bytes: body,
      // ABSENT means drained. An empty string is not a cursor either.
      nextCursor: cursorHeader ? Number(cursorHeader) : null,
      docs: numHeader(res.headers.get("x-baalda-docs")),
      uncompressedBytes: numHeader(res.headers.get("x-baalda-bytes")),
    };
  }

  /** POST a bulk route, re-typing any refusal as a {@link BulkApiError}. */
  private async bulk<T>(path: string, body: unknown): Promise<T> {
    try {
      const { data } = await this.request<T>("POST", path, { body });
      return data;
    } catch (e) {
      throw asBulkError(e);
    }
  }

  /**
   * The registry pull's note listing, following the server's keyset pages.
   *
   * Callers are unchanged: this answers exactly what {@link listNoteRegistry}
   * does. `limit` is what asks a NEW server to page; a server that predates
   * pagination ignores it and answers the whole vault with no `nextAfter`, which
   * is the single-page case below — so there is no capability probe and no
   * fallback path to get wrong.
   *
   * `tombstones` ride the LAST page only (that is what keeps the "one snapshot,
   * no precedence rule" property of the unpaged listing), so they are taken from
   * whichever response ended the loop, and `null` still means "the server did not
   * answer the question" rather than "nothing is deleted".
   */
  async listNoteRegistryPaged(
    vaultId: string,
    opts: { limit?: number } = {},
  ): Promise<{ notes: RegisteredNote[]; tombstones: string[] | null }> {
    const limit = opts.limit ?? REGISTRY_PAGE_LIMIT;
    const notes: RegisteredNote[] = [];
    let tombstones: string[] | null = null;
    let after: string | undefined;
    // Bounded so a server that keeps answering the same `nextAfter` cannot spin
    // this loop forever; 1000 pages is 1,000,000 notes at the default limit.
    for (let page = 0; page < 1000; page++) {
      const { data } = await this.request<{
        notes: RegisteredNote[];
        tombstones?: string[];
        nextAfter?: string | null;
      }>("GET", "/api/notes", {
        query: { vaultId, limit: String(limit), after },
      });
      notes.push(...(data.notes ?? []));
      tombstones = Array.isArray(data.tombstones) ? data.tombstones : null;
      const next = typeof data.nextAfter === "string" ? data.nextAfter : null;
      // No cursor ⇒ the last (or only) page. A cursor that did not ADVANCE is a
      // server bug; stopping is strictly better than looping on it.
      if (!next || next === after) return { notes, tombstones };
      after = next;
    }
    return { notes, tombstones };
  }

  // ---- Versioning ---------------------------------------------------------

  /** A note's stored versions, newest first (no content). Needs `view`. */
  async listNoteVersions(docId: string): Promise<NoteVersion[]> {
    const { data } = await this.request<{ versions: NoteVersion[] }>(
      "GET",
      `/api/notes/${encodeURIComponent(docId)}/versions`,
    );
    return data.versions ?? [];
  }

  /** One version *with* its markdown — the preview/revert payload. */
  async getNoteVersion(docId: string, versionId: number): Promise<NoteVersionDetail> {
    const { data } = await this.request<NoteVersionDetail>(
      "GET",
      `/api/notes/${encodeURIComponent(docId)}/versions/${encodeURIComponent(String(versionId))}`,
    );
    return data;
  }

  /**
   * Restore a version as a forward CRDT edit (never a backwards state merge, which
   * would resurrect deleted text). The server captures the pre-revert state first
   * unless the live text already matches the newest stored version — that's when
   * `preRevertVersionId` comes back null. Needs `edit`; a locked share 403s.
   */
  async revertNoteToVersion(
    docId: string,
    versionId: number,
  ): Promise<{ ok: true; preRevertVersionId: number | null }> {
    const { data } = await this.request<{ ok: true; preRevertVersionId: number | null }>(
      "POST",
      `/api/notes/${encodeURIComponent(docId)}/versions/${encodeURIComponent(String(versionId))}/revert`,
    );
    return data;
  }

  /**
   * How many bytes of CRDT the server holds for a note, and whether that puts it
   * over the sync cap. Needs `edit` — it is only actionable by someone who could
   * reset the doc. See `resetNoteHistory`.
   */
  async noteCrdtSize(
    docId: string,
  ): Promise<{ docId: string; bytes: number; capBytes: number; overCap: boolean }> {
    const { data } = await this.request<{
      docId: string;
      bytes: number;
      capBytes: number;
      overCap: boolean;
    }>("GET", `/api/notes/${encodeURIComponent(docId)}/crdt-size`);
    return data;
  }

  /**
   * Discard a note's edit history server-side and re-seed it from `content`.
   *
   * The repair for a note whose Yjs state has grown past the server's cap: it is
   * refused on every connect, so it can never be edited back down through normal
   * means. DESTRUCTIVE — the text survives (you are supplying it), the history
   * does not. Callers must clear the LOCAL CRDT too, or the old state merges
   * straight back in; `SyncManager.resetNoteHistory` does both in the right
   * order.
   */
  async resetNoteHistory(
    docId: string,
    content: string,
  ): Promise<{ docId: string; bytesBefore: number; bytesAfter: number }> {
    const { data } = await this.request<{
      docId: string;
      bytesBefore: number;
      bytesAfter: number;
    }>("POST", `/api/notes/${encodeURIComponent(docId)}/reset-crdt`, {
      body: { content },
    });
    return data;
  }

  /** A note collection's checkpoints, newest first (any vault member). */
  async listCheckpoints(vaultId: string): Promise<VaultCheckpoint[]> {
    const { data } = await this.request<{ checkpoints: VaultCheckpoint[] }>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints`,
    );
    return data.checkpoints ?? [];
  }

  /** Take a manual checkpoint (owner/admin). Throws ApiError(409) while another
   *  checkpoint/revert holds the vault's lock. */
  async createCheckpoint(vaultId: string, label?: string): Promise<VaultCheckpoint> {
    const { data } = await this.request<VaultCheckpoint>(
      "POST",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints`,
      { body: label ? { label } : {} },
    );
    return data;
  }

  async deleteCheckpoint(vaultId: string, checkpointId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints/${encodeURIComponent(checkpointId)}`,
    );
  }

  /** Revert the whole vault to a checkpoint (**owner only**; admins 403).
   *  Synchronous and convergent — re-running it lands in the same place. */
  async revertToCheckpoint(vaultId: string, checkpointId: string): Promise<VaultRevertResult> {
    const { data } = await this.request<VaultRevertResult>(
      "POST",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints/${encodeURIComponent(checkpointId)}/revert`,
    );
    return data;
  }

  // ---- Shares -------------------------------------------------------------

  async listShares(
    resourceType: "folder" | "file" | "vault",
    resourceId: string,
  ): Promise<Share[]> {
    const { data } = await this.request<{ shares: Share[] }>("GET", "/api/shares", {
      query: { resourceType, resourceId },
    });
    return data.shares ?? [];
  }

  /** Vault-level shares (the Open/Read-only posture: an org-wide grant on the
   *  vault). resourceId is the organization id. */
  async listVaultShares(orgId: string): Promise<Share[]> {
    return this.listShares("vault", orgId);
  }

  async createShare(input: {
    resourceType: "folder" | "file" | "vault";
    resourceId: string;
    /** Required for user shares; ignored for org-wide grants/locks. */
    principalId?: string;
    principalType?: "user" | "org";
    permission: Permission | "locked" | "denied";
  }): Promise<Share> {
    const { data } = await this.request<Share>("POST", "/api/shares", { body: input });
    return data;
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/shares/${encodeURIComponent(shareId)}`);
  }

  /**
   * The vault's team access in one shot: the vault-wide mode plus every
   * per-item org row underneath it. Owner/admin only.
   */
  async getTeamAccess(orgId: string): Promise<TeamAccess> {
    const { data } = await this.request<TeamAccess>(
      "GET",
      `/api/orgs/${encodeURIComponent(orgId)}/team-access`,
    );
    return {
      mode: data.mode ?? "private",
      grantId: data.grantId ?? null,
      overrides: data.overrides ?? [],
    };
  }

  /**
   * Set the mode for the WHOLE vault — every folder and note.
   *
   * The server does this transactionally: it deletes every per-item org row
   * first, then writes the new vault row. That is the point of the endpoint.
   * Doing it client-side as revoke-then-create left the per-item rows standing,
   * so "set the entire vault to Shared" quietly skipped everything a folder had
   * overridden. Per-user rows are untouched: people shared with by name keep
   * their access.
   */
  async setTeamAccess(orgId: string, mode: TeamAccessMode): Promise<TeamAccessResult> {
    const { data } = await this.request<TeamAccessResult>(
      "PUT",
      `/api/orgs/${encodeURIComponent(orgId)}/team-access`,
      { body: { mode } },
    );
    return {
      mode: data.mode ?? mode,
      cleared: data.cleared ?? 0,
      disconnectedDocs: data.disconnectedDocs ?? 0,
      postureChanged: data.postureChanged ?? true,
    };
  }

  /** Resolve every member's effective access to a resource (the "who can access"
   *  view). Same manage-gate as {@link listShares}. */
  async resolveAccess(
    resourceType: "folder" | "file",
    resourceId: string,
  ): Promise<AccessResolution> {
    const { data } = await this.request<AccessResolution>("GET", "/api/resolve-access", {
      query: { resourceType, resourceId },
    });
    return { members: data.members ?? [] };
  }

  /** All locks in a vault (readable by any vault member — drives lock badges). */
  /**
   * Every access OVERLAY row in a note collection: `locked` (the read-only cap)
   * and `denied` (Private). One request because both are read for the same
   * reason — badging the tree and resolving what an item inherits — and both
   * need the whole vault's set, which a per-resource read can't give.
   */
  async listVaultLocks(vaultId: string): Promise<Share[]> {
    const { data } = await this.request<{ locks: Share[] }>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/locks`,
    );
    return data.locks ?? [];
  }

  // ---- Sync token ---------------------------------------------------------

  /** Mint a per-doc sync JWT. Throws ApiError(403) when the user has no access. */
  async syncToken(docId: string): Promise<SyncTokenResponse> {
    const { data } = await this.request<SyncTokenResponse>("POST", "/api/sync-token", {
      body: { docId },
    });
    return data;
  }

  /** Mint a vault-scoped token for the background replication channel (spec 05).
   *  Throws ApiError(403) when the user isn't a member of the vault. */
  async vaultSyncToken(vaultId: string): Promise<VaultSyncTokenResponse> {
    const { data } = await this.request<VaultSyncTokenResponse>(
      "POST",
      "/api/vault-sync-token",
      { body: { vaultId } },
    );
    return data;
  }

  // ---- Attachment blobs (Phase 3 blob store, spec 02 §2/§5A) --------------

  /** Common headers (Origin + bearer) shared by the binary blob endpoints. */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    try {
      headers.Origin = new URL(this.baseUrl).origin;
    } catch {
      /* leave unset */
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** List attachment metadata for a vault. */
  async listVaultBlobs(vaultId: string): Promise<BlobMeta[]> {
    const { data } = await this.request<{ blobs: BlobMeta[] }>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/blobs`,
    );
    return data.blobs ?? [];
  }

  /** Upload raw bytes as a vault attachment; server dedupes by sha256. */
  async uploadBlob(input: {
    vaultId: string;
    relPath: string;
    bytes: Uint8Array;
    mime?: string;
    fileName?: string;
    /** The `files` row this blob's bytes belong to (tree binaries only) —
     *  stored as `blobs.doc_id` so the ACL resolves the file, not its path. */
    docId?: string | null;
  }): Promise<BlobMeta> {
    const headers = this.baseHeaders();
    headers["Content-Type"] = input.mime ?? "application/octet-stream";
    headers["x-rel-path"] = input.relPath;
    if (input.fileName) headers["x-file-name"] = input.fileName;
    // A header rather than a body field, because the body IS the file here. An
    // older server ignores it and falls back to the path heuristic.
    if (input.docId) headers["x-doc-id"] = input.docId;

    // Copy into a fresh ArrayBuffer so the fetch body is a clean BodyInit.
    const buf = input.bytes.slice().buffer;
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/vaults/${encodeURIComponent(input.vaultId)}/blobs`,
      { method: "POST", headers, body: buf },
    );
    const text = await res.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, parsed);
    }
    return parsed as unknown as BlobMeta;
  }

  /**
   * Headers that prove who we are on a blob route we host ourselves.
   *
   * Public because the attachment sync has to decide, per download, whether the
   * URL it was handed is ours (bearer REQUIRED) or a third-party presign
   * (bearer FORBIDDEN — S3 rejects a request that carries both a signature and
   * an `Authorization` header). The decision lives in `sync/attachments.ts`
   * where it is tested; this just supplies the header when the answer is "ours".
   */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** Whether this server is known to speak the intent flow (null = unasked). */
  supportsBlobIntent(): boolean | null {
    return this.blobIntentSupported;
  }

  /**
   * Announce an upload: what the bytes are, where they belong, how big.
   *
   * The server answers either "already have them" (`deduped`, zero bytes move —
   * which is the whole reason this exists: the legacy route learned that only
   * AFTER a new device re-uploaded every attachment in full) or a URL to PUT
   * them to, for BOTH storage providers. A 404 means this server predates the
   * flow: remembered per server URL so exactly one upload pays for the probe.
   */
  async createBlobIntent(
    vaultId: string,
    meta: {
      sha256: string;
      size: number;
      mime: string;
      relPath: string;
      filename?: string | null;
      /** The `files` row these bytes belong to — see {@link registerFile}. The
       *  server stores it as `blobs.doc_id`; an older one ignores it. */
      docId?: string | null;
    },
  ): Promise<BlobIntent> {
    if (this.blobIntentSupported === false) {
      // Known-legacy server: answer the way it would, without the round trip.
      throw new BlobTransportError(404, "not_found", "server has no blob intent route");
    }
    try {
      const { data } = await this.request<BlobIntent>(
        "POST",
        `/api/vaults/${encodeURIComponent(vaultId)}/blobs/intent`,
        { body: meta },
      );
      this.blobIntentSupported = true;
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.blobIntentSupported = false;
      throw asBlobError(e);
    }
  }

  /**
   * Finish an upload: the server checks what landed and promotes the row to
   * `ready`. Idempotent, so a retry after a dropped response is safe.
   *
   * `completeUrl` comes from the intent and is absolute — the server owns the
   * path, and a multipart flow may point it elsewhere entirely.
   */
  async completeBlob(completeUrl: string, body: BlobCompleteBody = {}): Promise<BlobMeta> {
    return (await this.requestAbsolute<BlobMeta>("POST", completeUrl, body)) ?? ({} as BlobMeta);
  }

  /** Fresh presigned URLs for parts whose own presign expired mid-upload. */
  async requestBlobParts(
    partsUrl: string,
    partNumbers: number[],
  ): Promise<{ parts: BlobUploadPart[]; expiresAt?: number }> {
    const data = await this.requestAbsolute<{ parts: BlobUploadPart[]; expiresAt?: number }>(
      "POST",
      partsUrl,
      { partNumbers },
    );
    return { parts: data?.parts ?? [], expiresAt: data?.expiresAt };
  }

  /**
   * Where to GET this blob's bytes right now.
   *
   * A JSON URL rather than following `GET /api/blobs/:id`'s 302: reqwest
   * forwards `Authorization` across a redirect and S3 rejects a presign that
   * arrives with one, so the desktop asks first and then fetches with a client
   * that carries exactly the headers `direct` calls for. 404 = a server that
   * predates this; the caller falls back to {@link downloadBlob}.
   */
  async blobDownloadUrl(blobId: string): Promise<BlobDownloadTarget> {
    if (this.blobUrlSupported === false) {
      throw new BlobTransportError(404, "not_found", "server has no blob url route");
    }
    try {
      const { data } = await this.request<BlobDownloadTarget>(
        "GET",
        `/api/blobs/${encodeURIComponent(blobId)}/url`,
      );
      this.blobUrlSupported = true;
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.blobUrlSupported = false;
      throw asBlobError(e);
    }
  }

  /** Whether this server is known to accept extracted text (null = unasked). */
  supportsBlobText(): boolean | null {
    return this.blobTextSupported;
  }

  /**
   * Hand the server the plain text Rust already extracted from a blob, so the
   * team's search can find a `.docx` by what is inside it.
   *
   * Ranking fuel and snippets only — never served as content, never an
   * authorization input, and re-derivable from the bytes, which is what makes a
   * CLIENT-supplied extraction acceptable: a member who can upload the file can
   * already write any words they like into a note. The server caps the body at
   * 1 MB (413) and answers 409 when the blob's own sha does not match the one
   * this text describes, so a racing re-upload cannot attach stale words to new
   * bytes.
   *
   * 404 disables it for the whole session (remembered per server URL like
   * {@link createBlobIntent}'s probe): it means either a server that predates
   * the route or a blob it has forgotten, and neither is worth a retry per
   * file.
   */
  async uploadBlobText(
    vaultId: string,
    blobId: string,
    body: {
      chars: number;
      content: string;
      source: "client";
      docId?: string | null;
      sha256: string;
    },
  ): Promise<void> {
    if (this.blobTextSupported === false) {
      throw new BlobTransportError(404, "not_found", "server has no blob text route");
    }
    try {
      await this.request<unknown>(
        "PUT",
        `/api/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}/text`,
        { body },
      );
      this.blobTextSupported = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.blobTextSupported = false;
      throw asBlobError(e);
    }
  }

  /**
   * PUT raw bytes at a presigned URL from the WEBVIEW — the fallback for when
   * the Rust streaming command is unavailable (tests, or a build without it).
   *
   * Sends `headers` and nothing else. No bearer, ever: `direct: true` is a
   * third-party presign that rejects one, and `direct: false` is our own route
   * whose `?t=` query IS the credential. Note the webview's own limits — the
   * body lives in the JS heap and the bucket needs CORS — which is exactly why
   * Rust is the primary path.
   */
  async uploadBytesTo(input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    bytes: Uint8Array;
  }): Promise<{ status: number; etag: string | null }> {
    const res = await this.fetchImpl(input.url, {
      method: input.method ?? "PUT",
      headers: { ...(input.headers ?? {}) },
      body: input.bytes.slice().buffer,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BlobTransportError(res.status, null, text || `HTTP ${res.status}`);
    }
    return { status: res.status, etag: res.headers.get("etag") };
  }

  /** GET bytes from an arbitrary (possibly presigned) URL — webview fallback. */
  async downloadBytesFrom(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<Uint8Array> {
    const res = await this.fetchImpl(url, { method: "GET", headers: { ...headers } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BlobTransportError(res.status, null, text || `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * JSON round trip to an ABSOLUTE url the server handed us (complete, parts).
   *
   * The bearer goes only to our own origin; a `completeUrl` pointing anywhere
   * else gets the body and nothing to replay. Same-origin is the test because
   * these URLs are minted by the server we are already authenticated to.
   */
  private async requestAbsolute<T>(
    method: string,
    url: string,
    body: unknown,
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      [ORIGIN_HEADER]: this.clientId,
    };
    if (this.isOwnOrigin(url)) {
      try {
        headers.Origin = new URL(this.baseUrl).origin;
      } catch {
        /* leave unset */
      }
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(url, { method, headers, body: JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const code = errorCodeOf(parsed);
      throw new BlobTransportError(res.status, code, code ?? `HTTP ${res.status}`, parsed);
    }
    return (parsed ?? null) as T | null;
  }

  /** Is this absolute URL served by the server we hold a session for? */
  private isOwnOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  /** Download an attachment's bytes by blob id. */
  async downloadBlob(id: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/blobs/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Re-type a failed blob call so callers can branch on the server's `code`. */
function asBlobError(e: unknown): unknown {
  if (e instanceof BlobTransportError) return e;
  if (e instanceof ApiError) {
    return new BlobTransportError(e.status, errorCodeOf(e.body), e.message, e.body);
  }
  return e;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Normalize snake/camel doc-id/vault-id fields the server may return. */
export function noteDocId(n: RegisteredNote): string {
  return n.docId ?? n.doc_id ?? n.id;
}
export function noteVaultId(n: RegisteredNote): string | undefined {
  return n.vaultId ?? n.vault_id;
}
export function noteRelPath(n: RegisteredNote): string | undefined {
  return n.relPath ?? n.rel_path;
}
/** Who created the note, or null when the server didn't say. */
export function noteCreatedBy(n: RegisteredNote): string | null {
  return n.createdBy ?? n.created_by ?? null;
}
/**
 * The note's last-edit stamp, or null when it has never been edited (or the
 * server predates versioning). Null is the honest answer — a row with no
 * `last_edited_at` must show no "edited by" tag rather than a bare avatar.
 */
export function noteLastEdited(n: RegisteredNote): NoteLastEdited | null {
  const at = n.lastEditedAt ?? n.last_edited_at ?? null;
  if (!at) return null;
  return {
    userId: n.lastEditedBy ?? n.last_edited_by ?? null,
    name: n.lastEditedByName ?? n.last_edited_by_name ?? null,
    at,
  };
}
export function vaultOrgId(v: Vault): string | undefined {
  return v.organizationId ?? v.organization_id;
}
/** Whether this vault's root is closed to new folders/notes. */
export function vaultRootFrozen(v: Vault): boolean {
  return (v.rootFrozen ?? v.root_frozen) === true;
}
export function sharePrincipalId(s: Share): string {
  return s.principalId ?? s.principal_id ?? "";
}
export function sharePrincipalType(s: Share): "user" | "org" {
  return s.principalType ?? s.principal_type ?? "user";
}
export function shareResourceType(s: Share): "folder" | "file" | "vault" {
  return s.resourceType ?? s.resource_type ?? "file";
}
export function shareResourceId(s: Share): string {
  return s.resourceId ?? s.resource_id ?? "";
}
