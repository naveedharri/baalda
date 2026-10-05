import {
  McpToolError,
  appendNote,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  deleteFileTool,
  moveFileTool,
  editNote,
  getAccessDefaultTool,
  listAttachments,
  listFolders,
  listResourceAccessTool,
  listNotes,
  listVaults,
  moveFolderTool,
  moveNoteTool,
  manageAccessTool,
  readAttachmentText,
  readNote,
  searchNotes,
  setAccessDefaultTool,
  updateNote,
  type McpContext,
  type NoteEdit,
} from "./service.js";
import type {
  AccessAudience,
  AccessMode,
  AccessResource,
} from "../permissions/access-management.js";

/**
 * The MCP tool catalog. Each entry carries a JSON-Schema `inputSchema` (sent to
 * clients via tools/list) and a handler that validates its args and calls the
 * gated service. Keep names snake_case and descriptions action-first — that's
 * what the calling model reads to pick a tool.
 *
 * NO `attach_file`, deliberately. Uploading through here would mean base64 over
 * JSON-RPC — the whole file in the request, in the response envelope's memory,
 * and through a transport with no resume — while the HTTP side spent PR 2b
 * building the opposite (intent → presigned PUT → complete, bytes never
 * touching this process). There is also no idempotency story for it: `create_note`
 * can adopt a path, but a retried upload of 40 MB has no key to recognise
 * itself by. Files come in through the desktop; the AI reads them.
 */

type Args = Record<string, unknown>;

/** MCP spec ToolAnnotations (all five fields, always set explicitly). */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

type Hints = Omit<McpToolAnnotations, "title">;

// Every tool acts only on this server's vault data, so none is open-world.
/** Reads only. */
const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds content without removing any; a repeat adds again (append_note's
 *  idempotencyKey is optional, so the tool as a whole is not idempotent). */
const CREATE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Replaces the whole body (can drop existing text); the same body twice is a no-op. */
const REPLACE: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Changes a location only; the same move twice lands in the same place. */
const MOVE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Removes content (soft delete into Trash for notes). */
const DELETE: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Can narrow or remove people's access; re-applying the same mode is a no-op. */
const ACCESS: Hints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP ToolAnnotations. Required on every tool: directory checks and clients
   * treat a tool without readOnlyHint/destructiveHint as unclassified.
   */
  annotations: McpToolAnnotations;
  handler: (ctx: McpContext, args: Args) => Promise<unknown>;
}

// ── tiny arg validators (McpToolError → surfaced as an isError tool result) ──

function reqStr(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError(`Missing required string argument: ${key}`);
  }
  return v;
}

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new McpToolError(`Argument ${key} must be a string`);
  return v;
}

function optNum(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new McpToolError(`Argument ${key} must be a number`);
  return v;
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new McpToolError(`Argument ${key} must be a boolean`);
  return v;
}

/**
 * Like `optStr`, but keeps `null` distinct from absent.
 *
 * `optStr` collapses both to `undefined`, which the move tools read as "leave it
 * where it is" — so with `optStr` alone there is no way to express "move this to
 * the vault root", and that operation would be unreachable over MCP.
 */
function optStrOrNull(args: Args, key: string): string | null | undefined {
  if (!(key in args)) return undefined;
  const v = args[key];
  if (v === null) return null;
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new McpToolError(`Argument ${key} must be a string or null`);
  return v;
}

const S = (description: string) => ({ type: "string", description });

function accessMode(args: Args): AccessMode {
  const mode = reqStr(args, "mode");
  if (mode !== "private" && mode !== "readonly" && mode !== "open") {
    throw new McpToolError("mode must be private, readonly, or open");
  }
  return mode;
}

function accessResources(raw: unknown): AccessResource[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new McpToolError("resources must be a non-empty array");
  }
  return raw.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new McpToolError(`resources[${index}] must be an object`);
    }
    const row = value as Args;
    const resourceType = reqStr(row, "resourceType");
    if (resourceType !== "folder" && resourceType !== "file" && resourceType !== "vault") {
      throw new McpToolError(`resources[${index}].resourceType is invalid`);
    }
    return { resourceType, resourceId: reqStr(row, "resourceId") };
  });
}

function accessAudience(raw: unknown): AccessAudience {
  if (!raw || typeof raw !== "object") throw new McpToolError("audience is required");
  const row = raw as Args;
  const type = reqStr(row, "type");
  if (type === "org") return { type };
  if (type !== "users" || !Array.isArray(row.userIds)) {
    throw new McpToolError("audience must be org or users with userIds");
  }
  if (row.userIds.some((id) => typeof id !== "string" || !id)) {
    throw new McpToolError("audience.userIds must contain non-empty strings");
  }
  return { type, userIds: row.userIds as string[] };
}

/**
 * Validate `edit_note`'s `edits` argument into typed edits (McpToolError on a bad
 * shape). The schema names the anchor `find` for replace/delete and `anchor` for
 * the inserts, and the new text `replace` vs `text`; agents mix those up often
 * enough that each is accepted under either name — there is no ambiguity in
 * what was meant, so refusing bought nothing but an error.
 */
export function parseEdits(raw: unknown): NoteEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new McpToolError("edit_note requires a non-empty `edits` array", "bad_edit");
  }
  return raw.map((e, i): NoteEdit => {
    if (!e || typeof e !== "object") throw new McpToolError(`edits[${i}] must be an object`, "bad_edit");
    const o = e as Args;
    const str = (key: string, alias?: string): string => {
      const v = o[key] ?? (alias ? o[alias] : undefined);
      if (typeof v !== "string") {
        throw new McpToolError(`edits[${i}].${key} must be a string`, "bad_edit");
      }
      return v;
    };
    const all = optBool(o, "all");
    switch (o.type) {
      case "replace":
        return {
          type: "replace",
          find: str("find", "anchor"),
          replace: str("replace", "text"),
          ...(all !== undefined ? { all } : {}),
        };
      case "delete":
        return { type: "delete", find: str("find", "anchor"), ...(all !== undefined ? { all } : {}) };
      case "insert_before":
        return { type: "insert_before", anchor: str("anchor", "find"), text: str("text", "replace") };
      case "insert_after":
        return { type: "insert_after", anchor: str("anchor", "find"), text: str("text", "replace") };
      default:
        throw new McpToolError(
          `edits[${i}].type must be one of replace, insert_before, insert_after, delete`,
          "bad_edit",
        );
    }
  });
}

export const TOOLS: McpTool[] = [
  {
    name: "list_vaults",
    annotations: { title: "List vaults", ...READ },
    description:
      "List the top-level note collections you can access, each with a vaultId. Start here to get a vaultId for the other tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (ctx) => listVaults(ctx),
  },
  {
    name: "get_access_default",
    annotations: { title: "Get access default for new members", ...READ },
    description:
      "Get what future members initially see when they join this vault (the New members row): open (Can edit) / readonly (Can view) / private (No access). Owner/admin only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (ctx) => getAccessDefaultTool(ctx),
  },
  {
    name: "set_access_default",
    annotations: { title: "Set access default for new members", ...ACCESS },
    description:
      "Set future members' initial access to content that already exists when they join (the New members row): open (Can edit) / readonly (Can view) / private (No access). Existing members are unchanged. Owner/admin only.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["private", "readonly", "open"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    handler: (ctx, args) => setAccessDefaultTool(ctx, accessMode(args)),
  },
  {
    name: "list_resource_access",
    annotations: { title: "List access on folders and files", ...READ },
    description:
      "List every vault member's effective access to one folder or file, after each person's own vault level (which wins for them either way), Everyone access and locks. Owner/admin only.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: { type: "string", enum: ["folder", "file"] },
        resourceId: S("Folder id or file/note docId"),
      },
      required: ["resourceType", "resourceId"],
      additionalProperties: false,
    },
    handler: (ctx, args) => {
      const resourceType = reqStr(args, "resourceType");
      if (resourceType !== "folder" && resourceType !== "file") {
        throw new McpToolError("resourceType must be folder or file");
      }
      return listResourceAccessTool(ctx, resourceType, reqStr(args, "resourceId"));
    },
  },
  {
    name: "manage_access",
    annotations: { title: "Change access", ...ACCESS },
    description:
      "Replace access on one or more selected folders/files, or the whole vault. Modes: open (Can edit) / readonly (Can view) / private (No access). Everyone clears all custom member overrides in selected subtrees; selected users changes only those users. A users-audience mode on the vault resource is that person's absolute vault level (Can edit everything / Can view everything / No access): it replaces Everyone access, the owner/admin shortcut and authorship for them, and only their own folder/file grants lift a No access. Owner/admin only.",
    inputSchema: {
      type: "object",
      properties: {
        resources: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: {
            type: "object",
            properties: {
              resourceType: { type: "string", enum: ["folder", "file", "vault"] },
              resourceId: S("Resource id; for vault use the organization id"),
            },
            required: ["resourceType", "resourceId"],
            additionalProperties: false,
          },
        },
        audience: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["org", "users"] },
            userIds: { type: "array", items: { type: "string" } },
          },
          required: ["type"],
          additionalProperties: false,
        },
        mode: { type: "string", enum: ["private", "readonly", "open"] },
      },
      required: ["resources", "audience", "mode"],
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      manageAccessTool(
        ctx,
        accessResources(args.resources),
        accessAudience(args.audience),
        accessMode(args),
      ),
  },
  {
    name: "list_folders",
    annotations: { title: "List folders", ...READ },
    description: "List every folder in a vault, with its path and parent.",
    inputSchema: {
      type: "object",
      properties: { vaultId: S("Vault id from list_vaults") },
      required: ["vaultId"],
      additionalProperties: false,
    },
    handler: (ctx, a) => listFolders(ctx, reqStr(a, "vaultId")),
  },
  {
    name: "list_notes",
    annotations: { title: "List notes", ...READ },
    description:
      "List notes you can access in a vault (optionally within one folder). Returns each note's docId, title, path and your permission.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        folderId: S("Optional folder id to list only that folder's notes"),
      },
      required: ["vaultId"],
      additionalProperties: false,
    },
    handler: (ctx, a) => listNotes(ctx, reqStr(a, "vaultId"), optStr(a, "folderId")),
  },
  {
    name: "read_note",
    annotations: { title: "Read note", ...READ },
    description:
      "Read a note's full markdown content by its docId. Also returns its `revision` — pass it as expectedRevision to update_note / append_note / edit_note so a write is refused if the note changed in between.",
    inputSchema: {
      type: "object",
      properties: { docId: S("Note docId from list_notes or search_notes") },
      required: ["docId"],
      additionalProperties: false,
    },
    handler: (ctx, a) => readNote(ctx, reqStr(a, "docId")),
  },
  {
    name: "search_notes",
    annotations: { title: "Search notes and files", ...READ },
    description:
      "Semantic + keyword search over everything you can access in a vault: notes, and the text extracted from files (docx, xlsx, pdf, csv, code…). Each hit carries kind: 'note' or 'file' — read a note with read_note and a file's text with read_attachment_text.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        query: S("What to search for"),
        k: { type: "number", description: "Max results (default 10, max 50)" },
        includeFiles: {
          type: "boolean",
          description: "Also search the text of files, not just notes. Default true.",
        },
      },
      required: ["vaultId", "query"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      searchNotes(
        ctx,
        reqStr(a, "vaultId"),
        reqStr(a, "query"),
        optNum(a, "k"),
        optBool(a, "includeFiles"),
      ),
  },
  {
    name: "list_attachments",
    annotations: { title: "List attachments", ...READ },
    description:
      "List the files (not notes) stored in a vault that you can access — spreadsheets, documents, PDFs, images, attachments. hasText tells you whether read_attachment_text has anything for one.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        folder: S("Optional vault-relative folder to list within, e.g. 'Team/Reports'"),
        limit: { type: "number", description: "Max files to return (default 50, max 200)" },
      },
      required: ["vaultId"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      listAttachments(ctx, reqStr(a, "vaultId"), {
        folder: optStr(a, "folder"),
        limit: optNum(a, "limit"),
      }),
  },
  {
    name: "read_attachment_text",
    annotations: { title: "Read attachment text", ...READ },
    description:
      "Read the extracted plain text of a file — NOT the file itself. Identify it by relPath or blobId (both from list_attachments or a search_notes hit with kind 'file'). Returns an empty text if the file has not been indexed yet.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        relPath: S("Vault-relative path of the file, e.g. 'Team/q3.xlsx'"),
        blobId: S("Blob id from list_attachments or a file search hit (instead of relPath)"),
        maxChars: {
          type: "number",
          description: "Max characters to return (default 20000, max 200000). `truncated` says whether there was more.",
        },
      },
      required: ["vaultId"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      readAttachmentText(
        ctx,
        reqStr(a, "vaultId"),
        { relPath: optStr(a, "relPath"), blobId: optStr(a, "blobId") },
        optNum(a, "maxChars"),
      ),
  },
  {
    name: "create_note",
    annotations: { title: "Create note", ...CREATE },
    description:
      "Create a new markdown note. relPath is the vault-relative path ending in .md (e.g. 'Ideas/draft.md'); every folder in it must already exist (see list_folders / create_folder). If you also pass folderId it must be the folder whose path is relPath's directory. Optionally seed its content.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        relPath: S("Vault-relative path ending in .md, e.g. 'Ideas/draft.md'"),
        title: S("Optional display title (defaults to the filename)"),
        folderId: S("Optional folder id; must match relPath's directory. Usually omit it — the folder is resolved from relPath."),
        content: S("Optional initial markdown content"),
      },
      required: ["vaultId", "relPath"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      createNote(ctx, {
        vaultId: reqStr(a, "vaultId"),
        relPath: reqStr(a, "relPath"),
        title: optStr(a, "title"),
        folderId: optStr(a, "folderId"),
        content: optStr(a, "content"),
      }),
  },
  {
    name: "update_note",
    annotations: { title: "Replace note content", ...REPLACE },
    description:
      "Replace a note's entire markdown content. Prefer edit_note for a change to part of a note. Pass expectedRevision (from read_note) so the write is refused if the note changed since you read it.",
    inputSchema: {
      type: "object",
      properties: {
        docId: S("Note docId"),
        content: S("The new full markdown content"),
        expectedRevision: S(
          "The `revision` read_note returned. If the note no longer matches, the write is refused with a conflict — read again and retry.",
        ),
      },
      required: ["docId", "content"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      updateNote(ctx, reqStr(a, "docId"), reqStr(a, "content"), optStr(a, "expectedRevision")),
  },
  {
    name: "append_note",
    annotations: { title: "Append to note", ...CREATE },
    description:
      "Append text to the end of a note's markdown content. Pass an idempotencyKey when you may retry the call, so a retry cannot append the text twice.",
    inputSchema: {
      type: "object",
      properties: {
        docId: S("Note docId"),
        text: S("Markdown to append to the end of the note"),
        expectedRevision: S("Optional `revision` from read_note; refuses the append if the note changed."),
        idempotencyKey: S(
          "Optional caller-chosen key (e.g. a UUID). A repeat with the same key returns the first result instead of appending again.",
        ),
      },
      required: ["docId", "text"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      appendNote(ctx, reqStr(a, "docId"), reqStr(a, "text"), {
        expectedRevision: optStr(a, "expectedRevision"),
        idempotencyKey: optStr(a, "idempotencyKey"),
      }),
  },
  {
    name: "edit_note",
    annotations: { title: "Edit note", ...CREATE },
    description:
      "Make targeted edits to a note without resending the whole body: replace exact text, insert before/after an anchor, or delete exact text. Each anchor must match exactly once (or set all: true for replace/delete); a missing or ambiguous anchor refuses the whole call with nothing written. Edits apply in order. Pass expectedRevision from read_note to also refuse the call if the note changed since you read it.",
    inputSchema: {
      type: "object",
      properties: {
        docId: S("Note docId"),
        expectedRevision: S("Optional `revision` from read_note; refuses the edit if the note changed."),
        edits: {
          type: "array",
          minItems: 1,
          description: "Edits to apply in order, each matched against the text as left by the previous one.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["replace", "insert_before", "insert_after", "delete"],
                description: "What to do at the anchor.",
              },
              find: S("Exact text to replace or delete (replace / delete). Matched exactly first; if absent, matched ignoring differences in whitespace, quotes, dashes and Unicode form."),
              replace: S("Replacement text (replace)"),
              anchor: S("Exact text to insert next to (insert_before / insert_after)"),
              text: S("Text to insert (insert_before / insert_after)"),
              all: {
                type: "boolean",
                description: "replace / delete only: apply to every occurrence instead of requiring exactly one.",
              },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
      required: ["docId", "edits"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      editNote(ctx, reqStr(a, "docId"), parseEdits(a.edits), optStr(a, "expectedRevision")),
  },
  {
    name: "delete_note",
    annotations: { title: "Delete note", ...DELETE },
    description: "Delete a note (soft delete; its edit history is preserved).",
    inputSchema: {
      type: "object",
      properties: { docId: S("Note docId") },
      required: ["docId"],
      additionalProperties: false,
    },
    handler: (ctx, a) => deleteNote(ctx, reqStr(a, "docId")),
  },
  {
    name: "delete_file",
    annotations: { title: "Delete file", ...DELETE },
    description:
      "Delete a non-note file (pdf, image, office document, csv...) by its id from list_attachments. Removes it for everyone; teammates' stale copies are set aside rather than re-uploaded.",
    inputSchema: {
      type: "object",
      properties: { fileId: S("File id (the docId list_attachments reports)") },
      required: ["fileId"],
      additionalProperties: false,
    },
    handler: (ctx, a) => deleteFileTool(ctx, reqStr(a, "fileId")),
  },
  {
    name: "move_file",
    annotations: { title: "Move or rename file", ...MOVE },
    description:
      "Rename or move a non-note file, keeping its id. path is the new vault-relative path; its directory must be an existing folder.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: S("File id (the docId list_attachments reports)"),
        path: S("New vault-relative path, e.g. 'Archive/report.pdf'"),
      },
      required: ["fileId", "path"],
      additionalProperties: false,
    },
    handler: (ctx, a) => moveFileTool(ctx, reqStr(a, "fileId"), reqStr(a, "path")),
  },
  {
    name: "create_folder",
    annotations: { title: "Create folder", ...CREATE },
    description: "Create a folder in a vault. path is the vault-relative folder path.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        name: S("Folder name"),
        path: S("Vault-relative folder path, e.g. 'Ideas/Drafts'"),
        parentId: S("Optional parent folder id"),
      },
      required: ["vaultId", "name", "path"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      createFolder(ctx, {
        vaultId: reqStr(a, "vaultId"),
        name: reqStr(a, "name"),
        path: reqStr(a, "path"),
        parentId: optStr(a, "parentId"),
      }),
  },
  {
    name: "delete_folder",
    annotations: { title: "Delete folder", ...DELETE },
    description:
      "Delete a folder. By default only an empty one — pass recursive to delete its contents with it.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: S("Folder id from list_folders"),
        recursive: {
          type: "boolean",
          description:
            "Also delete the folder's contents: its notes are soft-deleted (history preserved) and its subfolders removed. Default false, which refuses a non-empty folder.",
        },
      },
      required: ["folderId"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      deleteFolder(ctx, reqStr(a, "folderId"), { recursive: optBool(a, "recursive") }),
  },
  {
    name: "move_note",
    annotations: { title: "Move or rename note", ...MOVE },
    description:
      "Rename, move, or retitle a note. relPath moves the file (its directory must be an existing folder, which becomes the note's folder); folderId alone re-parents it keeping its filename (null for the vault root); title changes the display title. The note keeps its docId and its full history, so links and edits survive.",
    inputSchema: {
      type: "object",
      properties: {
        docId: S("Note docId from list_notes or search_notes"),
        relPath: S("New vault-relative path ending in .md, e.g. 'Archive/old.md'"),
        title: S("New display title"),
        folderId: {
          // Written inline rather than via S(): this one is nullable, and `null`
          // is the only way to say "move it to the vault root".
          type: ["string", "null"],
          description:
            "New parent folder id, or null for the vault root. Omit to leave it where it is.",
        },
      },
      required: ["docId"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      moveNoteTool(ctx, {
        docId: reqStr(a, "docId"),
        relPath: optStr(a, "relPath"),
        title: optStr(a, "title"),
        folderId: optStrOrNull(a, "folderId"),
      }),
  },
  {
    name: "move_folder",
    annotations: { title: "Move or rename folder", ...MOVE },
    description:
      "Rename or move a folder. Its notes and subfolders move with it: every descendant path is rewritten in place and every docId preserved, so backlinks and edit history survive.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: S("Folder id from list_folders"),
        path: S("New vault-relative folder path, e.g. 'Archive/Ideas'"),
        name: S("New folder name (defaults to the last segment of path)"),
        parentId: {
          type: ["string", "null"],
          description:
            "New parent folder id, or null for the vault root. Omit to leave it where it is.",
        },
      },
      required: ["folderId"],
      additionalProperties: false,
    },
    handler: (ctx, a) =>
      moveFolderTool(ctx, {
        folderId: reqStr(a, "folderId"),
        path: optStr(a, "path"),
        name: optStr(a, "name"),
        parentId: optStrOrNull(a, "parentId"),
      }),
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
