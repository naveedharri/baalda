import { useRef, useState, type CSSProperties } from "react";
import { ITEM_COLORS } from "../lib/appearance";
import { authManager } from "../lib/auth/authManager";
import { imageFileToSquareDataUrl } from "../lib/squareImage";
import { toast } from "../lib/toast";
import {
  defaultVaultIcon,
  parseVaultIcon,
  resolveVaultIcon,
  serializeVaultIcon,
  VAULT_ICON_IMAGE_PX,
  VAULT_ICON_MAX_CHARS,
  VAULT_ICON_NAMES,
  writeLocalVaultIcon,
  type VaultIconName,
} from "../lib/vaultIcon";
import { useStore } from "../store";
// Static on purpose: this module only loads inside the lazy settings dialog.
import VaultIconSvg from "./VaultIconSvg";
import { useVaultIconRaw, VaultTile } from "./VaultSwitcher";

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
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async (value: string | null) => {
    setBusy(true);
    try {
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
    } catch (e) {
      toast(`Couldn't change the vault icon — ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
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

  const upload = async (file: File) => {
    try {
      const src = await imageFileToSquareDataUrl(file, VAULT_ICON_IMAGE_PX, VAULT_ICON_MAX_CHARS);
      await save(serializeVaultIcon({ kind: "image", src }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <div className="vault-icon-settings">
      <div className="subhead">Vault icon</div>
      <div className="vault-icon-current">
        <span className="vault-icon-preview">
          <VaultTile identity={identity} name={name} />
        </span>
        <div className="vault-icon-current-actions">
          <div className="row">
            <button
              className="secondary sm"
              disabled={!canEdit || busy}
              onClick={() => fileRef.current?.click()}
            >
              Upload image
            </button>
            {isCustom && (
              <button className="link-btn" disabled={!canEdit || busy} onClick={() => void save(null)}>
                Reset to default
              </button>
            )}
          </div>
          <span className="muted">
            {canEdit
              ? identity.startsWith("org:")
                ? "Everyone in this vault sees this icon."
                : "Shown on this device only, until you turn on sync."
              : "Only an owner or admin can change the vault icon."}
          </span>
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

      <div className="vault-icon-colors" role="radiogroup" aria-label="Icon colour">
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
              <span className="vault-tile">
                <VaultIconSvg icon={icon} color={color} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
