import { useEffect, useRef, useState } from "react";
import { syncManager } from "../lib/sync/docSession";
import { createPortal } from "react-dom";
import type { McpToolInfo, McpTokenRow } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import * as ipc from "../lib/ipc";
import { isManagedServer } from "../lib/serverFeatures";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { BusyButton } from "./skills/parts";
import { ToolLogo } from "./skills/ToolLogos";
import "./skills/skills.css";
import "./McpTab.css";

/**
 * MCP: expose this vault to AI clients over the Model Context Protocol.
 * The MCP endpoint is part of the same server; a client authenticates with a
 * token minted here and then gets the SAME CRUD access to notes/folders that
 * the signed-in user has (owners/admins see everything; members see what's
 * shared with them). This is where you grab the URL + a token.
 *
 * Nothing on the page moves when you act: a new token is minted and shown in
 * a dialog, and every Copy flips to a tick in place.
 */
export function McpTab() {
  const session = useStore((s) => s.session);
  const serverUrl = useStore((s) => s.serverUrl);

  const mcpUrl = `${serverUrl.replace(/\/+$/, "")}/api/mcp`;
  const hasVault = !!session?.activeOrganizationId;

  const [tokens, setTokens] = useState<McpTokenRow[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<McpTokenRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumps every 20s so "connected" dots + relative times stay live while open.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!hasVault) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = () =>
      authManager.api
        .listMcpConnections()
        .then(({ tokens, tools }) => {
          if (cancelled) return;
          setTokens(tokens);
          setTools(tools);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    void load();
    // Poll so a connection that goes active/idle while the panel is open shows it.
    const poll = window.setInterval(() => void load(), 20_000);
    const tickle = window.setInterval(() => setTick((n) => n + 1), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tickle);
    };
  }, [hasVault]);

  const revoke = async (id: string) => {
    try {
      await authManager.api.revokeMcpToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      setRevoking(null);
    } catch (e) {
      toast(`Couldn't revoke the token: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  if (!hasVault) {
    return (
      <div className="muted perm-empty">
        MCP needs an active vault. Create or switch to one first.
      </div>
    );
  }

  return (
    <>
      <div className="muted">
        Connect any MCP-compatible AI client to this vault. It gets the same
        access you do: read, search, create, edit and delete notes and folders.
        Owners and admins can also manage the team's access from the same chat.
        Ask Claude or ChatGPT to share a folder with someone, make it view only,
        or set what new members see.
      </div>

      {isManagedServer(serverUrl) && <ClaudeDirectoryBanner />}

      <div className="mcp-endpoint">
        <span className="mcp-endpoint-label">Server address</span>
        <CopyField value={mcpUrl} label="server address" />
      </div>

      <div className="mcp-section-head">
        <div className="mcp-section-text">
          <div className="subhead">Access tokens</div>
          <div className="mcp-section-hint">
            Each token connects one AI client as you, in this vault. Revoke any time.
          </div>
        </div>
        <button
          type="button"
          className="primary skills-hdr-btn"
          onClick={() => setCreating(true)}
        >
          New token
        </button>
      </div>

      {loading ? (
        <div className="mcp-empty">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="mcp-empty">No tokens yet. Create one to connect an AI client.</div>
      ) : (
        <ul className="mcp-conn-list">
          {tokens.map((t) => {
            const live = isConnected(t.lastUsedAt);
            const open = expanded === t.id;
            return (
              <li key={t.id} className={`mcp-conn${open ? " open" : ""}`}>
                <div className="mcp-conn-head">
                  <span
                    className={`mcp-dot ${live ? "on" : "off"}`}
                    title={live ? "Connected" : "Disconnected"}
                    aria-hidden="true"
                  />
                  <div className="mcp-conn-main">
                    <div className="mcp-conn-title">
                      <span className="mcp-conn-name">{t.name}</span>
                      <span className={`mcp-status ${live ? "on" : "off"}`}>
                        {live ? "Connected" : "Disconnected"}
                      </span>
                    </div>
                    <div className="mcp-conn-sub">
                      {[
                        t.lastClient ? clientLabel(t.lastClient) : null,
                        t.tokenPrefix,
                        `${t.useCount} ${t.useCount === 1 ? "call" : "calls"}`,
                        t.lastUsedAt
                          ? `last active ${relTime(t.lastUsedAt)}`
                          : `created ${relTime(t.createdAt)}, never used`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="mcp-conn-actions">
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={open}
                      onClick={() => setExpanded((e) => (e === t.id ? null : t.id))}
                    >
                      {open ? "Hide tools" : `Tools · ${tools.length}`}
                    </button>
                    <button
                      type="button"
                      className="link-btn danger"
                      onClick={() => setRevoking(t)}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
                {open && (
                  <ul className="mcp-tool-list">
                    {tools.map((tool) => (
                      <li key={tool.name} title={tool.description}>
                        <span className={`mcp-tool-badge ${tool.access}`}>
                          {tool.access === "read"
                            ? "read"
                            : tool.access === "destructive"
                              ? "delete"
                              : "write"}
                        </span>
                        <code>{tool.name}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <NewMcpTokenDialog
          mcpUrl={mcpUrl}
          onCreated={(row) => setTokens((prev) => [row, ...prev])}
          onClose={() => setCreating(false)}
        />
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke “${revoking.name}”?`}
          confirmLabel="Revoke token"
          onConfirm={() => revoke(revoking.id)}
          onCancel={() => setRevoking(null)}
        >
          Any AI client using this token loses access to the vault right away.
          You can create a new token at any time.
        </ConfirmDialog>
      )}
    </>
  );
}

/** The directory listing points at the managed server, so self-hosters never see it. */
const CLAUDE_DIRECTORY_URL = "https://claude.ai/directory/baalda";

function ClaudeDirectoryBanner() {
  return (
    <div className="mcp-directory">
      <ToolLogo tool="claude" size={16} title="" />
      <span className="mcp-directory-pill">Official connector</span>
      <span className="mcp-directory-text">
        Baalda is in Claude's connector directory. Add it in Claude with one click.
      </span>
      <button
        type="button"
        className="secondary mcp-directory-btn"
        onClick={() =>
          void ipc.openExternal(CLAUDE_DIRECTORY_URL).catch((e) =>
            toast(`Couldn't open the listing: ${e instanceof Error ? e.message : String(e)}`, "error"),
          )
        }
      >
        View listing
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.5 10.5l5-5M6.5 5.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

type Client = "claude" | "codex" | "other";
const CLIENTS: { id: Client; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "other", label: "Other app" },
];

/**
 * New token, in one dialog: name it, then copy it and a setup snippet. The
 * second step replaces the first in place, so nothing on the page behind it
 * moves; the token list updates underneath.
 */
function NewMcpTokenDialog({
  mcpUrl,
  onCreated,
  onClose,
}: {
  mcpUrl: string;
  onCreated: (row: McpTokenRow) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [client, setClient] = useState<Client>("claude");
  const createRef = useRef<HTMLButtonElement | null>(null);

  // Esc closes while naming. Once the token is on screen it would be lost for
  // good, so only Done or ✕ close it then; Esc still stays ours either way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!created) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [created, onClose]);

  const create = async () => {
    setError(null);
    try {
      const minted = await authManager.api.createMcpToken(name.trim() || "MCP token", syncManager.registry.vaultId);
      const { token, ...row } = minted;
      setCreated({ name: minted.name, token });
      onCreated(row);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // Otherwise the button just returns to idle and the user clicks again,
      // minting duplicate tokens on a server that is actually failing (#85).
      toast(`Couldn't create the MCP token: ${message}`, "error");
    }
  };

  const token = created?.token ?? "";
  const claudeSnippet = `claude mcp add --transport http context ${mcpUrl} \\\n  --header "Authorization: Bearer ${token}"`;
  // Codex's own `mcp add` (like Claude's), which writes ~/.codex/config.toml.
  // It reads a bearer token only from an environment variable, so the second
  // line saves the token for new terminals (zsh, the macOS default shell).
  const codexSnippet = `codex mcp add context --url ${mcpUrl} --bearer-token-env-var CONTEXT_MCP_TOKEN\necho 'export CONTEXT_MCP_TOKEN="${token}"' >> ~/.zshrc`;

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        if (!created) onClose();
      }}
    >
      <div
        className="modal skills-form-dialog mcp-token-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={created ? "Your new token" : "New access token"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="skills-form-head">
          <h2 className="confirm-title">{created ? "Your new token" : "New access token"}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {!created ? (
          <>
            <p className="skills-form-intro">
              Name it after the app that will use it, so you can tell your tokens apart later.
            </p>
            <input
              autoFocus
              value={name}
              placeholder="e.g. Claude Desktop"
              aria-label="Token name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createRef.current?.click();
              }}
            />
            {error && <div className="auth-error">{error}</div>}
            <div className="confirm-actions skills-form-actions">
              <button type="button" className="ghost-pill" onClick={onClose}>
                Cancel
              </button>
              <BusyButton
                ref={createRef}
                className="primary"
                busyLabel="Creating…"
                onClick={create}
              >
                Create token
              </BusyButton>
            </div>
          </>
        ) : (
          <>
            <p className="skills-form-intro">
              Copy your token now. It won't be shown again.
            </p>
            <CopyField value={created.token} label="token" wrap />

            <div className="mcp-setup-head">
              <span className="mcp-setup-title">Set it up in</span>
              <div className="member-access-view mcp-client-tabs" role="tablist">
                {CLIENTS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={client === c.id}
                    className={`member-access-view-btn mcp-client-tab${client === c.id ? " is-active" : ""}`}
                    onClick={() => setClient(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mcp-setup-body" role="tabpanel">
              {client === "claude" ? (
                <>
                  <CopyBlock value={claudeSnippet} label="Claude Code command" />
                  <div className="mcp-setup-hint">Run it in a terminal.</div>
                </>
              ) : client === "codex" ? (
                <>
                  <CopyBlock value={codexSnippet} label="Codex commands" />
                  <div className="mcp-setup-hint">Then open a new terminal.</div>
                </>
              ) : (
                <>
                  <div className="mcp-setup-label">Server address</div>
                  <CopyField value={mcpUrl} label="server address" />
                  <div className="mcp-setup-label">Header</div>
                  <CopyField value={`Authorization: Bearer ${created.token}`} label="header" wrap />
                </>
              )}
            </div>

            <div className="confirm-actions skills-form-actions">
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Copies on click; the glyph flips to a tick for 1.5 s in the same 28px box. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button
      type="button"
      className={`icon-btn mcp-copy-btn${copied ? " is-copied" : ""}`}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onClick={() => void copy()}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M10.5 3.5v-.4A1.6 1.6 0 0 0 8.9 1.5H4.1A1.6 1.6 0 0 0 2.5 3.1v4.8a1.6 1.6 0 0 0 1.6 1.6h.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </button>
  );
}

/** A monospace value with its copy button inside the field; one line unless `wrap`. */
export function CopyField({ value, label, wrap = false }: { value: string; label: string; wrap?: boolean }) {
  return (
    <div className="mcp-field">
      <code className={`mcp-field-value${wrap ? " is-wrapped" : ""}`} title={value}>
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** A multi-line command block with its copy button in the corner. */
function CopyBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="mcp-field mcp-block">
      <code className="mcp-block-value">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** A connection is "active" when it made a request in the last few minutes
 *  (MCP here is stateless HTTP — there's no socket to watch, so recency is it). */
const CONNECTED_WINDOW_MS = 3 * 60 * 1000;
function isConnected(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return false;
  return Date.now() - new Date(lastUsedAt).getTime() < CONNECTED_WINDOW_MS;
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", else a date. */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Best-effort human name for a client from its User-Agent. */
function clientLabel(ua: string | null): string {
  if (!ua) return "Unknown client";
  const s = ua.toLowerCase();
  if (s.includes("claude-code") || s.includes("claude code")) return "Claude Code";
  if (s.includes("claude")) return "Claude";
  if (s.includes("cursor")) return "Cursor";
  if (s.includes("node")) return "Node client";
  // Fall back to the leading token of the UA (e.g. "MyApp/1.2" → "MyApp").
  return ua.split(/[\s/]/)[0].slice(0, 40) || "Unknown client";
}
