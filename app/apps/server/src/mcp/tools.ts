import {
  McpToolError,
  appendNote,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  listFolders,
  listNotes,
  listVaults,
  moveFolderTool,
  moveNoteTool,
  readNote,
  searchNotes,
  updateNote,
  type McpContext,
} from "./service.js";

/**
 * The MCP tool catalog. Each entry carries a JSON-Schema `inputSchema` (sent to
 * clients via tools/list) and a handler that validates its args and calls the
 * gated service. Keep names snake_case and descriptions action-first — that's
 * what the calling model reads to pick a tool.
 */

type Args = Record<string, unknown>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hints per the MCP spec — helps clients label read vs destructive tools. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
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

export const TOOLS: McpTool[] = [
  {
    name: "list_vaults",
    description:
      "List the top-level note collections you can access, each with a vaultId. Start here to get a vaultId for the other tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: (ctx) => listVaults(ctx),
  },
  {
    name: "list_folders",
    description: "List every folder in a vault, with its path and parent.",
    inputSchema: {
      type: "object",
      properties: { vaultId: S("Vault id from list_vaults") },
      required: ["vaultId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, a) => listFolders(ctx, reqStr(a, "vaultId")),
  },
  {
    name: "list_notes",
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
    annotations: { readOnlyHint: true },
    handler: (ctx, a) => listNotes(ctx, reqStr(a, "vaultId"), optStr(a, "folderId")),
  },
  {
    name: "read_note",
    description: "Read a note's full markdown content by its docId.",
    inputSchema: {
      type: "object",
      properties: { docId: S("Note docId from list_notes or search_notes") },
      required: ["docId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, a) => readNote(ctx, reqStr(a, "docId")),
  },
  {
    name: "search_notes",
    description:
      "Semantic + keyword search over the notes you can access in a vault. Returns ranked docIds.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        query: S("What to search for"),
        k: { type: "number", description: "Max results (default 10, max 50)" },
      },
      required: ["vaultId", "query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: (ctx, a) =>
      searchNotes(ctx, reqStr(a, "vaultId"), reqStr(a, "query"), optNum(a, "k")),
  },
  {
    name: "create_note",
    description:
      "Create a new markdown note. relPath is the vault-relative path ending in .md (e.g. 'Ideas/draft.md'). Optionally seed its content.",
    inputSchema: {
      type: "object",
      properties: {
        vaultId: S("Vault id from list_vaults"),
        relPath: S("Vault-relative path ending in .md, e.g. 'Ideas/draft.md'"),
        title: S("Optional display title (defaults to the filename)"),
        folderId: S("Optional folder id the note belongs to"),
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
    description:
      "Replace a note's entire markdown content. Read it first if you mean to edit rather than overwrite.",
    inputSchema: {
      type: "object",
      properties: {
        docId: S("Note docId"),
        content: S("The new full markdown content"),
      },
      required: ["docId", "content"],
      additionalProperties: false,
    },
    annotations: { idempotentHint: true },
    handler: (ctx, a) => updateNote(ctx, reqStr(a, "docId"), reqStr(a, "content")),
  },
  {
    name: "append_note",
    description: "Append text to the end of a note's markdown content.",
    inputSchema: {
      type: "object",
      properties: {
        docId: S("Note docId"),
        text: S("Markdown to append to the end of the note"),
      },
      required: ["docId", "text"],
      additionalProperties: false,
    },
    handler: (ctx, a) => appendNote(ctx, reqStr(a, "docId"), reqStr(a, "text")),
  },
  {
    name: "delete_note",
    description: "Delete a note (soft delete; its edit history is preserved).",
    inputSchema: {
      type: "object",
      properties: { docId: S("Note docId") },
      required: ["docId"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    handler: (ctx, a) => deleteNote(ctx, reqStr(a, "docId")),
  },
  {
    name: "create_folder",
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
    annotations: { destructiveHint: true },
    handler: (ctx, a) =>
      deleteFolder(ctx, reqStr(a, "folderId"), { recursive: optBool(a, "recursive") }),
  },
  {
    name: "move_note",
    description:
      "Rename, move, or retitle a note. relPath moves the file, folderId re-parents it (null for the vault root), title changes the display title. The note keeps its docId and its full history, so links and edits survive.",
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
    annotations: { idempotentHint: true },
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
    annotations: { idempotentHint: true },
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
