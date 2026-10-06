// SPDX-License-Identifier: Apache-2.0
// Synthetic, in-memory desktop services for the browser window simulator.
// No disk, OS keychain, account, or network access occurs in this module.

import type {
  VaultChecks,
  VaultStats,
  VaultCheckId,
} from "../../src/lib/health/types";
import type { TrashCopy } from "../../src/lib/ipc";

export interface FixtureIpcResult {
  handled: boolean;
  value?: unknown;
}

const started = Date.now();
const day = 86_400_000;
const services = new Map<string, string | null>();
const propertyValues: Record<string, string[]> = {
  status: ["Planned", "In progress", "Done"],
  owner: ["Kamil", "Ayesha", "Jordan", "Sam"],
  tags: ["planning", "product", "meeting", "decision"],
};
let types = JSON.stringify({
  version: 1,
  types: {
    status: "text",
    owner: "text",
    due: "date",
    priority: "number",
    approved: "checkbox",
    tags: "tags",
  },
});
let copies: TrashCopy[] = [
  {
    stamp: "2026-10-05T090000",
    relPath: "Q3 plan.md",
    bytes: 1240,
    modified: started - day,
  },
  {
    stamp: "2026-10-03T143000",
    relPath: "Specs/Pricing experiments.md",
    bytes: 2350,
    modified: started - 3 * day,
  },
];
const checks: VaultCheckId[] = [
  "empty-notes",
  "unreadable-notes",
  "bad-frontmatter",
  "case-collisions",
  "illegal-names",
  "long-paths",
  "stale-index",
  "broken-links",
  "missing-embeds",
  "duplicate-titles",
  "unindexed-markdown",
  "oversized-notes",
  "heavy-history",
  "orphan-history",
  "trash",
];

export function fixtureIpc(
  cmd: string,
  args: Record<string, unknown> = {},
): FixtureIpcResult {
  const yes = (value?: unknown): FixtureIpcResult => ({ handled: true, value });
  switch (cmd) {
    case "vault_stats": {
      const value: VaultStats = {
        computedAt: Date.now(),
        notes: { count: 7, bytes: 9830, empty: 0 },
        folders: 3,
        attachments: { count: 0, bytes: 0 },
        otherFiles: { count: 0, bytes: 0 },
        tags: 4,
        links: 8,
        brokenLinks: 0,
        index: { bytes: 245760, files: 0, extractedTextBytes: 0 },
        history: {
          docs: 7,
          updates: 47,
          bytes: 18320,
          orphanDocs: 0,
          orphanBytes: 0,
        },
        largestNotes: [
          {
            path: "Specs/Pricing experiments.md",
            bytes: 3260,
            mtime: started - day,
          },
          { path: "Q3 plan.md", bytes: 2410, mtime: started },
          {
            path: "Specs/Self-host GA.md",
            bytes: 1960,
            mtime: started - 2 * day,
          },
        ],
        largestFiles: [],
        heaviestHistory: [
          {
            docId: "preview-note",
            path: "Q3 plan.md",
            updates: 18,
            bytes: 6120,
          },
        ],
        activity: {
          modifiedLast7d: 5,
          modifiedLast30d: 5,
          weeks: [0, 0, 1, 0, 2, 1, 3, 2, 1, 3, 4, 5],
          days: Array.from({ length: 371 }, (_, i) =>
            i > 340 && i % 3 === 0 ? 1 + (i % 4) : 0,
          ),
        },
      };
      return yes(value);
    }
    case "vault_checks": {
      const value: VaultChecks = {
        computedAt: Date.now(),
        results: checks.map((id) =>
          id === "trash"
            ? {
                id,
                count: copies.length,
                bytes: copies.reduce((sum, copy) => sum + copy.bytes, 0),
                items: copies.map((copy) => ({
                  path: `${copy.stamp}/${copy.relPath}`,
                  bytes: copy.bytes,
                })),
              }
            : { id, count: 0, items: [] },
        ),
        linkedPaths: { id: "linked-paths", count: 0, items: [] },
        sharedFiles: [],
      };
      return yes(value);
    }
    case "list_trash_copies":
      return yes(copies.map((copy) => ({ ...copy })));
    case "read_trash_copy":
      return yes(
        `# ${String(args.relPath ?? "Recovered note").replace(/\.md$/, "")}\n\nThis is a synthetic recovery copy from the window simulator.\n`,
      );
    case "delete_trash_copy":
      copies = copies.filter(
        (copy) => copy.stamp !== args.stamp || copy.relPath !== args.relPath,
      );
      return yes();
    case "empty_trash": {
      const result = {
        filesRemoved: copies.length,
        bytesFreed: copies.reduce((sum, copy) => sum + copy.bytes, 0),
      };
      copies = [];
      return yes(result);
    }
    case "get_vault_types":
      return yes(types);
    case "set_vault_types":
      types = String(args.content ?? "");
      return yes();
    case "list_property_keys":
      return yes([
        { key: "status", count: 5 },
        { key: "owner", count: 4 },
        { key: "due", count: 3 },
        { key: "tags", count: 3 },
        { key: "priority", count: 2 },
        { key: "approved", count: 1 },
      ]);
    case "list_property_values":
      return yes(propertyValues[String(args.key)] ?? []);
    case "list_tags":
      return yes([
        { name: "product", count: 4 },
        { name: "planning", count: 3 },
        { name: "meeting", count: 2 },
        { name: "decision", count: 1 },
      ]);
    case "keychain_get": {
      const service = String(args.serviceKey ?? "");
      if (!service.startsWith("steward:openrouter:")) return { handled: false };
      return yes(
        services.has(service)
          ? (services.get(service) ?? null)
          : "DEMO_ONLY_NOT_A_VALID_API_KEY",
      );
    }
    case "keychain_set":
      services.set(String(args.serviceKey), String(args.value));
      return yes();
    case "keychain_delete":
      services.set(String(args.serviceKey), null);
      return yes();
    case "get_note_ui_state":
      return yes(null);
    case "set_note_ui_state":
    case "rebuild_index":
    case "export_path":
    case "clipboard_write":
    case "set_server_url":
      return yes();
    case "list_file_rows":
    case "list_binaries":
    case "list_attachments":
    case "list_disk_drift":
      return yes([]);
    case "get_file_text":
      return yes(null);
    case "file_stat":
      return yes({
        size: 2410,
        modified: started,
        created: started - 30 * day,
      });
    default:
      return { handled: false };
  }
}
