// The draft editor's file tree (components/skills/SkillEditor.tsx): skill
// relPaths folded into folders, folders first, SKILL.md pinned to the top.
// Pure, so the ordering rules are pinned by a test.

export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  changed: boolean;
}

export interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  /** Some file below it is changed (the folder shows the dot while collapsed). */
  changed: boolean;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

function sortLevel(nodes: TreeNode[], root: boolean): TreeNode[] {
  const folders = nodes.filter((n): n is TreeFolder => n.kind === "folder").sort(byName);
  const files = nodes.filter((n): n is TreeFile => n.kind === "file").sort(byName);
  for (const f of folders) f.children = sortLevel(f.children, false);
  if (root) {
    const pinned = files.findIndex((f) => f.path === "SKILL.md");
    if (pinned >= 0) {
      const [skillMd] = files.splice(pinned, 1);
      return [skillMd, ...folders, ...files];
    }
  }
  return [...folders, ...files];
}

/** Build the tree for these files. `changed` lists paths with unsaved edits. */
export function buildFileTree(paths: readonly string[], changed: ReadonlySet<string> = new Set()): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, TreeFolder>();
  const folderAt = (path: string): TreeNode[] => {
    if (!path) return root;
    const existing = folders.get(path);
    if (existing) return existing.children;
    const slash = path.lastIndexOf("/");
    const parent = folderAt(slash < 0 ? "" : path.slice(0, slash));
    const folder: TreeFolder = { kind: "folder", name: path.slice(slash + 1), path, changed: false, children: [] };
    folders.set(path, folder);
    parent.push(folder);
    return folder.children;
  };
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    const isChanged = changed.has(path);
    folderAt(dir).push({ kind: "file", name: path.slice(slash + 1), path, changed: isChanged });
    if (isChanged) {
      for (let d = dir; d; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
        const f = folders.get(d);
        if (f) f.changed = true;
      }
    }
  }
  return sortLevel(root, true);
}

/** Rows to draw, depth-first, skipping the children of collapsed folders. */
export function visibleRows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "folder" && !collapsed.has(node.path)) out.push(...visibleRows(node.children, collapsed, depth + 1));
  }
  return out;
}

/** "aggregate_benc…mark.py": keep both ends, so the extension stays visible. */
export function middleTruncate(name: string, max = 26): string {
  if (name.length <= max) return name;
  const keep = max - 1;
  const tail = Math.min(Math.ceil(keep / 2), 10);
  return `${name.slice(0, keep - tail)}…${name.slice(name.length - tail)}`;
}
