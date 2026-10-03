import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ITEM_COLORS } from "../lib/appearance";
import { authManager } from "../lib/auth/authManager";
import { imageFileToSquareDataUrl } from "../lib/squareImage";
import { toast } from "../lib/toast";
import {
  defaultVaultIcon,
  NO_COLOR,
  onLocalVaultIconChange,
  parseVaultIcon,
  readRecentUploads,
  rememberRecentUpload,
  resolveVaultIcon,
  serializeVaultIcon,
  VAULT_ICON_IMAGE_PX,
  VAULT_ICON_MAX_CHARS,
  VAULT_ICON_NAMES,
  writeLocalVaultIcon,
  type VaultIconName,
} from "../lib/vaultIcon";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { Spinner } from "./Spinner";
// Static on purpose: this module only loads inside the lazy settings dialog.
import VaultIconSvg from "./VaultIconSvg";
import { useVaultIconRaw, VaultTile } from "./VaultSwitcher";

/** How many of the remembered uploads the picker offers. */
const RECENT_SHOWN = 6;
/** Device-local: whether the icon/colour picker is expanded. Default closed. */
const CUSTOMISE_OPEN_KEY = "context.vaultIcon.customiseOpen";

function readCustomiseOpen(): boolean {
  try {
    return localStorage.getItem(CUSTOMISE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCustomiseOpen(open: boolean) {
  try {
    if (open) localStorage.setItem(CUSTOMISE_OPEN_KEY, "1");
    else localStorage.removeItem(CUSTOMISE_OPEN_KEY);
  } catch {
    // Storage unavailable: the choice just doesn't outlive the dialog.
  }
}

/**
 * Vault settings → General → Vault icon: pick a preset glyph and colour, or
 * upload an image. A synced vault's icon is the team's (stored on the server,
 * owner/admin only); a local vault's is this device's.
 */
export function VaultIconSettings({
  identity,
  name,
  canEdit,
}: {
  /** The switcher identity: `org:<id>` (synced) or `local:<path>`. */
  identity: string;
  name: string;
  canEdit: boolean;
}) {
  const raw = useVaultIconRaw(identity);
  const current = resolveVaultIcon(identity, raw);
  const isCustom = parseVaultIcon(raw) !== null;
  // The colour the preset grid is drawn in. Follows the current preset; an
  // image keeps the last picked (or default) colour for when you switch back.
  const [pickedColor, setPickedColor] = useState<string | null>(null);
  const color =
    pickedColor ?? (current.kind === "preset" ? current.color : defaultVaultIcon(identity).color);
  // What is being saved right now, if anything. Any value locks every picker;
  // "upload" also relabels the button, since that path can take seconds.
  const [pending, setPending] = useState<"upload" | "image" | "reset" | "preset" | null>(null);
  const busy = pending !== null;
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Images uploaded on this device, offered again (newest first).
  const [recent, setRecent] = useState(readRecentUploads);
  useEffect(() => onLocalVaultIconChange(() => setRecent(readRecentUploads())), []);

  /** Store the icon (server for a synced vault, this device for a local one). Throws. */
  const persist = async (value: string | null) => {
    if (identity.startsWith("org:")) {
      const orgId = identity.slice("org:".length);
      await authManager.api.updateOrganizationLogo(orgId, value);
      // Paint it now; teammates pick it up with their next vault list.
      useStore.setState((s) => ({
        organizations: s.organizations.map((o) => (o.id === orgId ? { ...o, logo: value } : o)),
      }));
    } else {
      writeLocalVaultIcon(identity.slice("local:".length), value);
    }
  };

  const save = async (value: string | null, kind: "image" | "reset" | "preset" = "preset") => {
    setPending(kind);
    setUploadError(null);
    try {
      await persist(value);
    } catch (e) {
      toast(`Couldn't change the vault icon — ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setPending(null);
    }
  };

  const pickPreset = (icon: VaultIconName) =>
    void save(serializeVaultIcon({ kind: "preset", icon, color }));

  const pickColor = (colorId: string) => {
    setPickedColor(colorId);
    if (current.kind === "preset") {
      void save(serializeVaultIcon({ kind: "preset", icon: current.icon, color: colorId }));
    }
  };

  // The whole path is one busy span: square/compress the file, then save it.
  const upload = async (file: File) => {
    setPending("upload");
    setUploadError(null);
    try {
      const src = await imageFileToSquareDataUrl(file, VAULT_ICON_IMAGE_PX, VAULT_ICON_MAX_CHARS);
      await persist(serializeVaultIcon({ kind: "image", src }));
      // Offered again only once it actually took.
      rememberRecentUpload(src);
    } catch (e) {
      console.warn("[vault-icon] upload failed", e);
      setUploadError("Couldn't upload that image. Try a smaller PNG or JPG.");
    } finally {
      setPending(null);
    }
  };

  const isSynced = identity.startsWith("org:");
  const usingImage = current.kind === "image";
  const shownRecent = recent.slice(0, RECENT_SHOWN);
  const [open, setOpenState] = useState(readCustomiseOpen);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    writeCustomiseOpen(next);
  };

  return (
    <div className="vault-icon-settings">
      <div className="vault-icon-head">
        <span className="vault-icon-preview" aria-busy={busy || undefined}>
          <VaultTile identity={identity} name={name} />
          {busy && (
            <span className="vault-icon-preview-busy">
              <Spinner size="sm" tone="neutral" />
            </span>
          )}
        </span>
        <div className="vault-icon-head-text">
          <span className="vault-icon-title">Vault icon</span>
          <span className="field-hint">
            {canEdit
              ? isSynced
                ? "Everyone in this vault sees this icon."
                : "Shown on this device only, until you turn on sync."
              : "Only an owner or admin can change the vault icon."}
          </span>
        </div>
        <div className="vault-icon-head-actions">
          {isCustom && (
            <AsyncButton
              className="link-btn"
              disabled={!canEdit || busy}
              onClick={() => save(null, "reset")}
            >
              Reset
            </AsyncButton>
          )}
          {/* Not an AsyncButton: its click only opens the file picker, and the
              slow part starts later, in the input's onChange. */}
          <button
            className={`secondary sm${pending === "upload" ? " is-busy" : ""}`}
            disabled={!canEdit || busy}
            aria-busy={pending === "upload" || undefined}
            onClick={() => fileRef.current?.click()}
          >
            <span className="async-btn-label">
              {pending === "upload" ? "Uploading…" : "Upload image"}
            </span>
            {pending === "upload" && <Spinner size="xs" />}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
      </div>

      {uploadError && (
        <div className="auth-error" role="alert">
          {uploadError}
        </div>
      )}

      <button
        type="button"
        className="vault-icon-disclosure"
        aria-expanded={open}
        aria-controls="vault-icon-customise"
        onClick={() => setOpen(!open)}
      >
        <svg
          className="vault-icon-chevron"
          data-open={open ? "" : undefined}
          viewBox="0 0 24 24"
          width="14"
          height="14"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        Choose icon and colour
      </button>

      {open && (
        <div className="vault-icon-customise" id="vault-icon-customise" aria-busy={busy || undefined}>
          {shownRecent.length > 0 && (
            <div className="vault-icon-recent">
              <span className="vault-icon-label">Recent uploads</span>
              <div className="vault-icon-recent-row" role="radiogroup" aria-label="Recent uploads">
                {shownRecent.map((src) => {
                  const selected = current.kind === "image" && current.src === src;
                  return (
                    <button
                      key={src}
                      className={`vault-icon-thumb${selected ? " active" : ""}`}
                      role="radio"
                      aria-checked={selected}
                      title="Use this image"
                      disabled={!canEdit || busy}
                      onClick={() => {
                        rememberRecentUpload(src);
                        void save(serializeVaultIcon({ kind: "image", src }), "image");
                      }}
                    >
                      <span className="vault-tile image">
                        <img src={src} alt="" draggable={false} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="vault-icon-colors" role="radiogroup" aria-label="Icon colour">
            {/* No background: the glyph alone, in the text colour. */}
            <button
              className={`swatch swatch-none${color === NO_COLOR ? " active" : ""}`}
              role="radio"
              aria-checked={color === NO_COLOR}
              title="None"
              disabled={!canEdit || busy}
              onClick={() => pickColor(NO_COLOR)}
            />
            {ITEM_COLORS.map((c) => (
              <button
                key={c.id}
                className={`swatch${c.id === color ? " active" : ""}`}
                style={{ background: c.value } as CSSProperties}
                role="radio"
                aria-checked={c.id === color}
                title={c.label}
                disabled={!canEdit || busy}
                onClick={() => pickColor(c.id)}
              />
            ))}
          </div>

          {usingImage && (
            <span className="vault-icon-note">
              Using your uploaded image. Pick an icon to switch back.
            </span>
          )}
          <div className="vault-icon-grid" role="radiogroup" aria-label="Icon">
            {VAULT_ICON_NAMES.map((icon) => {
              const selected = current.kind === "preset" && current.icon === icon;
              return (
                <button
                  key={icon}
                  className={`vault-icon-option${selected ? " active" : ""}`}
                  role="radio"
                  aria-checked={selected}
                  title={icon}
                  disabled={!canEdit || busy}
                  onClick={() => pickPreset(icon)}
                >
                  <span className={`vault-tile${color === NO_COLOR ? " none" : ""}`}>
                    <VaultIconSvg icon={icon} color={color} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
