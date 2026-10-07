// SPDX-License-Identifier: Apache-2.0
// Synthetic, in-memory preview data. Never contacts a backend.
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3600000).toISOString();
export const ORG = "preview-org";
export const VAULT = "preview-vault";
export const users = [
  {
    id: "preview-user",
    name: "Kamil",
    email: "kamil@example.com",
    image: "character:baalda-3",
    emailVerified: true,
  },
  {
    id: "preview-aya",
    name: "Aya Khan",
    email: "aya@example.com",
    image: "character:baalda-7",
    emailVerified: true,
  },
  {
    id: "preview-noah",
    name: "Noah Reed",
    email: "noah@example.com",
    image: "character:baalda-11",
    emailVerified: true,
  },
  {
    id: "preview-maya",
    name: "Maya Chen",
    email: "maya@example.com",
    image: "character:baalda-14",
    emailVerified: true,
  },
];
export const organizations = [
  { id: ORG, name: "Product team", slug: "product-team", createdAt: ago(720) },
  {
    id: "preview-design",
    name: "Design studio",
    slug: "design-studio",
    createdAt: ago(240),
  },
];
export const members = users.map((user, i) => ({
  id: `preview-member-${i}`,
  userId: user.id,
  organizationId: ORG,
  role: i === 0 ? "owner" : i === 1 ? "admin" : "member",
  createdAt: ago(720 - i * 72),
  user,
}));
export const invitations = [
  {
    id: "preview-invite-1",
    organizationId: ORG,
    email: "sam@example.com",
    role: "member",
    status: "pending",
    createdAt: ago(12),
    expiresAt: ago(-144),
    inviterId: users[0].id,
    access: "readonly",
  },
];
export const folders = ["Decisions", "Meeting notes", "Specs"].map(
  (path, i) => ({
    id: `preview-folder-${i}`,
    vaultId: VAULT,
    path,
    name: path,
    parentId: null,
    color: null,
  }),
);
export const notes = [
  "Q3 plan.md",
  "Hiring loop.md",
  "Welcome.md",
  "Specs/Pricing experiments.md",
  "Specs/Self-host GA.md",
  "Meeting notes/Weekly planning.md",
  "Decisions/Launch checklist.md",
].map((path, i) => ({
  id: i === 0 ? "preview-note" : `preview-note-${i}`,
  docId: i === 0 ? "preview-note" : `preview-note-${i}`,
  vaultId: VAULT,
  folderId: folders.find((f) => path.startsWith(f.path + "/"))?.id ?? null,
  relPath: path,
  title: path.split("/").pop()!.replace(/\.md$/, ""),
  createdBy: users[i % 4].id,
  createdAt: ago(144 - i * 12),
  lastEditedBy: users[i % 4].id,
  lastEditedByName: users[i % 4].name,
  lastEditedAt: ago(i + 1),
}));
export const files = [
  {
    id: "preview-file-1",
    docId: "preview-file-1",
    vaultId: VAULT,
    folderId: folders[2].id,
    path: "Specs/Launch brief.pdf",
    createdBy: users[1].id,
  },
];
export const vaults = [
  { id: VAULT, organizationId: ORG, name: "Product team", rootFrozen: false },
  {
    id: "preview-design-vault",
    organizationId: "preview-design",
    name: "Design studio",
    rootFrozen: false,
  },
];
export const billingConfig = {
  enabled: true,
  plans: [
    {
      id: "preview-pro-monthly",
      label: "Pro monthly (sample)",
      amount: 1000,
      currency: "USD",
      interval: "month",
    },
    {
      id: "preview-pro-yearly",
      label: "Pro yearly (sample)",
      amount: 10000,
      currency: "USD",
      interval: "year",
    },
  ],
  freeLimits: { vaultsPerUser: 3, membersPerVault: 5, notesPerVault: 20000 },
};
export const orgBilling = {
  plan: "pro",
  status: "active",
  currentPeriodEnd: ago(-720),
  cancelAtPeriodEnd: false,
  interval: "month",
  amount: 1000,
  currency: "USD",
  seats: { members: 4, pendingInvitations: 1, limit: null },
};
const myBilling = () => ({
  vaults: organizations.map((o, i) => ({
    orgId: o.id,
    name: o.name,
    role: "owner",
    ...orgBilling,
    ...(i
      ? {
          plan: "free",
          status: "none",
          amount: null,
          interval: null,
          currency: null,
          currentPeriodEnd: null,
        }
      : {}),
    billingOwner: {
      userId: users[0].id,
      name: users[0].name,
      email: users[0].email,
    },
    canManage: true,
    canTransfer: !i,
  })),
  orphaned: [],
  freeLimits: { ...billingConfig.freeLimits, freeVaultsUsed: 1 },
});
const tokens = [
  {
    id: "preview-mcp-1",
    name: "Local assistant (sample)",
    tokenPrefix: "DEMO_ONLY",
    createdAt: ago(72),
    lastUsedAt: ago(0.2),
    useCount: 42,
    lastClient: "Sample desktop assistant",
  },
];
const tools = [
  { name: "list_notes", description: "List readable notes", access: "read" },
  { name: "read_note", description: "Read a note", access: "read" },
  { name: "search_notes", description: "Search vault content", access: "read" },
  {
    name: "edit_note",
    description: "Edit a note with an exact anchor",
    access: "write",
  },
  { name: "create_note", description: "Create a note", access: "write" },
  {
    name: "delete_note",
    description: "Move a note to Trash",
    access: "destructive",
  },
];
const versions = [1, 2, 3].map((id, i) => ({
  id,
  createdAt: ago(i * 6 + 1),
  cause: "idle",
  authorId: users[i].id,
  authorName: users[i].name,
  sha256: `preview-sha-${id}`,
  size: 400 + i * 80,
}));
const checkpoints = [
  {
    id: "preview-checkpoint-1",
    kind: "manual",
    label: "Before launch planning",
    createdAt: ago(24),
    createdBy: users[0].id,
    createdByName: users[0].name,
    noteCount: notes.length,
  },
  {
    id: "preview-checkpoint-2",
    kind: "auto",
    label: null,
    createdAt: ago(3),
    createdBy: null,
    createdByName: null,
    noteCount: notes.length,
  },
];
const trash = [
  {
    docId: "preview-deleted-note",
    relPath: "Old launch draft.md",
    deletedAt: ago(48),
    deletedBy: { id: users[0].id, name: users[0].name },
    purgeAfter: ago(-672),
    sizeBytes: 256,
    hasUnsyncedContributions: false,
  },
];
let teamMode = "open";
let joinMode = "readonly";
let activeOrg = ORG;
const publicLinks = new Map<string, any>();
const access = new Map<string, string>();
const allResources = () => [...folders, ...notes, ...files];
function modeFor(userId: string, id: string): string {
  if (userId === users[0].id || userId === users[1].id) return "open";
  if (access.has(userId + ":" + id)) return access.get(userId + ":" + id)!;
  if (userId === users[2].id) return id === notes[1].id ? "private" : "open";
  if (userId === users[3].id)
    return id === notes[1].id ? "private" : "readonly";
  return teamMode;
}
const letter = (mode: string) =>
  ({ open: "e", readonly: "v", private: "n", mixed: "m" })[mode] ?? "e";
const ref = (u = users[0]) => ({ userId: u.id, name: u.name, email: u.email });
const content = (path = "Q3 plan.md") =>
  `${path.replace(/\.md$/, "")}\n\nSample version content for this visual preview.\n\n- Confirm the launch owner\n- Review access with the team\n- Share the next milestone\n`;
export const unknownRequests: string[] = [];
const response = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export async function previewFetch(
  input: any,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(String(input?.url ?? input), location.href),
    p = url.pathname,
    method = (init.method ?? input?.method ?? "GET").toUpperCase();
  let body: any = {};
  try {
    body = JSON.parse(String(init.body ?? "{}"));
  } catch {}
  const ok = (data: any) => response(data);
  const blocked = (message: string) =>
    response({ error: message, code: "preview_only" }, 503);
  if (p === "/health")
    return ok({
      ok: true,
      version: "0.1.79",
      features: [
        "notes-with-state",
        "bootstrap-only",
        "files-with-bytes",
        "access-board",
      ],
    });
  if (p === "/api/auth-methods")
    return ok({
      emailPassword: true,
      google: false,
      passwordReset: false,
      invitationEmail: false,
      bugReport: true,
    });
  if (p === "/api/auth/get-session")
    return ok({ user: users[0], session: { activeOrganizationId: activeOrg } });
  if (p === "/api/auth/update-user") {
    Object.assign(users[0], body);
    return ok({ status: true });
  }
  if (p.endsWith("/organization/list")) return ok(organizations);
  if (p.endsWith("/organization/list-members")) return ok({ members });
  if (p.endsWith("/organization/list-invitations")) return ok(invitations);
  if (p.includes("list-user-invitations")) return ok([]);
  if (p.endsWith("/organization/set-active")) {
    activeOrg = body.organizationId;
    return ok({});
  }
  if (p.endsWith("/organization/update")) {
    Object.assign(
      organizations.find((o) => o.id === body.organizationId) ??
        organizations[0],
      body.data,
    );
    return ok({});
  }
  if (p.endsWith("/organization/cancel-invitation")) {
    const i = invitations.findIndex((x) => x.id === body.invitationId);
    if (i >= 0) invitations.splice(i, 1);
    return ok({});
  }
  if (p.endsWith("/members/overview"))
    return ok({
      canManage: true,
      members: members.map((m, i) => ({
        userId: m.userId,
        memberId: m.id,
        role: m.role,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        joinedAt: m.createdAt,
        lastActiveAt: ago(i * 0.5),
        invitedBy: i ? ref() : null,
        access: { level: i < 2 ? "edit" : i === 2 ? "custom" : "view" },
      })),
      invitations,
    });
  if (/\/members\/[^/]+\/activity$/.test(p))
    return ok({
      events: [
        {
          kind: "edited",
          at: ago(0.5),
          docId: notes[0].id,
          path: notes[0].relPath,
        },
        {
          kind: "created",
          at: ago(24),
          docId: notes[3].id,
          path: notes[3].relPath,
        },
        {
          kind: "accessGranted",
          at: ago(48),
          by: ref(),
          permission: "edit",
          resourceType: "folder",
          resourceId: folders[2].id,
          path: "Specs",
        },
        { kind: "joined", at: ago(240), invitedBy: ref() },
      ],
    });
  if (/\/members\/[^/]+\/role$/.test(p)) {
    const id = p.split("/").at(-2);
    const m = members.find((m) => m.userId === id);
    if (m) m.role = body.role;
    return ok({ updated: true });
  }
  if (p.endsWith("/invitations") && method === "POST") {
    return ok({
      results: body.emails.map((email: string) => {
        const invitation = {
          ...invitations[0],
          id: crypto.randomUUID(),
          email,
          role: body.role,
          status: "pending",
          access: body.access ?? joinMode,
          createdAt: ago(0),
          expiresAt: ago(-168),
        };
        invitations.push(invitation);
        return { email, invitationId: invitation.id, emailed: false };
      }),
    });
  }
  if (p.endsWith("/unsync-preview"))
    return ok({
      orgName: organizations[0].name,
      notes: notes.length,
      files: files.length,
      folders: folders.length,
      attachmentBytes: 1843200,
      members: members.length - 1,
      publicLinks: publicLinks.size,
      mcpTokens: tokens.length,
      checkpoints: checkpoints.length,
      subscription: {
        status: orgBilling.status,
        currentPeriodEnd: orgBilling.currentPeriodEnd,
        cancelAtPeriodEnd: false,
      },
    });
  if (p.endsWith("/status") && p.startsWith("/api/orgs/"))
    return ok({ orgId: ORG, name: organizations[0].name, role: "owner" });
  if (p.endsWith("/team-access")) {
    if (method !== "GET") teamMode = body.mode;
    return ok({
      mode: teamMode,
      posture:
        teamMode === "open"
          ? "edit"
          : teamMode === "readonly"
            ? "view"
            : "sealed",
      grantId: "preview-team-grant",
      overrides: [],
      cleared: 0,
      disconnectedDocs: 0,
      postureChanged: true,
    });
  }
  if (p.endsWith("/access-default")) {
    if (method !== "GET") joinMode = body.mode;
    return ok({ mode: joinMode });
  }
  if (p.endsWith("/access/bulk")) {
    for (const r of body.resources ?? [])
      for (const uid of body.audience?.userIds ?? users.map((u) => u.id))
        access.set(uid + ":" + r.resourceId, body.mode);
    return ok({
      mode: body.mode,
      resourcesChanged: body.resources.length,
      overridesCleared: 0,
      membersAffected: body.audience?.userIds?.length ?? 4,
      disconnectedDocs: 0,
    });
  }
  if (p.endsWith("/access/summary"))
    return ok({
      mode:
        body.userIds?.length === 1
          ? modeFor(body.userIds[0], body.resources?.[0]?.resourceId)
          : "mixed",
    });
  if (p.endsWith("/access/summaries"))
    return ok({
      modes: (body.groups ?? []).map((g: any) =>
        modeFor(body.userIds?.[0], g[0]?.resourceId),
      ),
    });
  if (p.endsWith("/access-tree") || p.endsWith("/access-board")) {
    const tree = {
      folders: folders.map((f) => ({ id: f.id, path: f.path, color: f.color })),
      notes: notes.map((n) => ({ id: n.id, relPath: n.relPath })),
      files: files.map((f) => ({ id: f.id, path: f.path })),
    };
    const modes = allResources()
      .map((r) =>
        letter(modeFor(url.searchParams.get("userId") ?? users[0].id, r.id)),
      )
      .join("");
    return ok({
      ...tree,
      modes,
      complete: true,
      totals: {
        edit: [...modes].filter((m) => m === "e").length,
        view: [...modes].filter((m) => m === "v").length,
        none: [...modes].filter((m) => m === "n").length,
        mixed: 0,
      },
    });
  }
  if (p === "/api/resolve-access")
    return ok({
      members: members.map((m) => ({
        ...ref(m.user),
        role: m.role,
        permission: { open: "edit", readonly: "view", private: "none" }[
          modeFor(m.userId, url.searchParams.get("resourceId") ?? "")
        ],
        capped: false,
      })),
    });
  if (p === "/api/vaults") return ok({ vaults });
  if (/^\/api\/vaults\/[^/]+$/.test(p) && method !== "GET") {
    Object.assign(vaults[0], body);
    return ok(vaults[0]);
  }
  if (p === "/api/notes") return ok({ notes });
  if (p === "/api/folders") return ok({ folders });
  if (p === "/api/files") return ok({ files });
  if (p === "/api/shares")
    return ok({
      shares: [
        {
          id: "preview-team-share",
          resourceType: "vault",
          resourceId: ORG,
          principalType: "org",
          principalId: ORG,
          permission: "edit",
        },
      ],
    });
  if (p.endsWith("/locks")) return ok({ locks: [] });
  if (p.endsWith("/join-code")) return ok({ code: "DEMO-ONLY" });
  if (/^\/api\/orgs\/[^/]+$/.test(p) && method === "GET")
    return ok({ orgId: ORG, name: organizations[0].name, role: "owner" });
  if (p === "/api/billing/config") return ok(billingConfig);
  if (p === "/api/billing/mine") return ok(myBilling());
  if (/^\/api\/billing\/orgs\/[^/]+$/.test(p)) return ok(orgBilling);
  if (p.startsWith("/api/billing/"))
    return blocked("Payment actions are unavailable in this visual preview.");
  if (p === "/api/mcp/tokens") {
    if (method === "POST") {
      const row = {
        id: crypto.randomUUID(),
        name: body.name,
        tokenPrefix: "DEMO_ONLY",
        createdAt: ago(0),
        lastUsedAt: null,
        useCount: 0,
        lastClient: null,
      };
      tokens.push(row);
      return ok({ ...row, token: "DEMO_ONLY_NOT_A_VALID_CREDENTIAL" });
    }
    return ok({ tokens, tools });
  }
  if (p.startsWith("/api/mcp/tokens/") && method === "DELETE") {
    const i = tokens.findIndex((t) => t.id === p.split("/").at(-1));
    if (i >= 0) tokens.splice(i, 1);
    return ok({});
  }
  if (p.endsWith("/versions")) return ok({ versions });
  if (/\/versions\/\d+$/.test(p))
    return ok({
      ...(versions.find((v) => v.id === Number(p.split("/").at(-1))) ??
        versions[0]),
      content: content(),
    });
  if (p.endsWith("/checkpoints")) {
    if (method === "POST") {
      const cp = {
        ...checkpoints[0],
        id: crypto.randomUUID(),
        label: body.label ?? "Sample checkpoint",
        createdAt: ago(0),
      };
      checkpoints.unshift(cp);
      return ok(cp);
    }
    return ok({ checkpoints });
  }
  if (p.includes("/checkpoints/") && method === "DELETE") {
    const i = checkpoints.findIndex((c) => c.id === p.split("/").at(-1));
    if (i >= 0) checkpoints.splice(i, 1);
    return ok({});
  }
  if (p.endsWith("/trash")) return ok({ items: trash, truncated: false });
  if (p.endsWith("/trash-content"))
    return ok({
      docId: trash[0]?.docId,
      relPath: trash[0]?.relPath,
      text: content("Old launch draft.md"),
      deletedAt: ago(48),
    });
  if (p.endsWith("/restore")) {
    const id = p.split("/").at(-2);
    const i = trash.findIndex((t) => t.docId === id);
    const item = trash[i];
    if (i >= 0) trash.splice(i, 1);
    return ok({
      docId: id,
      relPath: item?.relPath ?? "Restored note.md",
      renamed: false,
    });
  }
  if (p.endsWith("/revert"))
    return blocked("History changes are disabled in this visual preview.");
  if (p.endsWith("/public-link")) {
    const id = p.split("/").at(-2)!;
    if (method === "DELETE") publicLinks.delete(id);
    if (method === "POST") {
      const link = {
        id: "preview-public-link",
        docId: id,
        url: "https://preview.invalid/p/sample-note",
        createdAt: ago(0),
      };
      publicLinks.set(id, link);
      return ok(link);
    }
    return ok({ link: publicLinks.get(id) ?? null });
  }
  if (p.endsWith("/storage"))
    return ok({
      usedBytes: 1843200,
      pendingBytes: 0,
      blobCount: 1,
      limitBytes: 10737418240,
    });
  if (p.endsWith("/blobs"))
    return ok({
      blobs: [
        {
          id: "preview-blob-1",
          docId: files[0].id,
          sha256: "preview-sha",
          size: 1843200,
          mime: "application/pdf",
          relPath: files[0].path,
          status: "ready",
          storageProvider: "preview",
        },
      ],
    });
  if (p.endsWith("/shrink-events"))
    return ok({ items: [], truncated: false, afterIsCurrent: true });
  if (p.endsWith("/shrink-brakes")) return ok({ items: [], canRelease: true });
  if (p.endsWith("/invitation-expiries")) return ok({ items: [] });
  if (p.endsWith("/housekeeper/status"))
    return ok({
      requiresPro: true,
      available: true,
      provider: "Sample provider — no live inference",
      model: "Preview only",
    });
  if (p.includes("/housekeeper/"))
    return blocked(
      "AI requests are disabled in this visual preview. Configure a real provider in the installed app.",
    );
  if (p === "/api/bug-reports")
    return blocked("Reports cannot be sent from this visual preview.");
  if (
    p.includes("/password-reset/") ||
    p.includes("/send-verification-email") ||
    p.includes("/invitation-email")
  )
    return blocked("Emails cannot be sent from this visual preview.");
  const key = method + " " + p;
  if (!unknownRequests.includes(key)) {
    unknownRequests.push(key);
    console.warn("[preview unimplemented]", key);
  }
  return response(
    {
      error: "This action is not available in the visual preview.",
      code: "preview_unimplemented",
    },
    501,
  );
}
export const initialStore = {
  members,
  pendingInvitations: invitations,
  userInvitations: [],
  organizations,
  billingConfig,
  orgBilling,
  myBilling: myBilling(),
  serverUrl: "http://preview.invalid",
  session: { user: users[0], activeOrganizationId: ORG },
  docIdByPath: Object.fromEntries(notes.map((n) => [n.relPath, n.id])),
};
