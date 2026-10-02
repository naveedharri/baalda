/* Preset vault icons, drawn with DiceBear's Bootstrap-icons style.

   LAZY ONLY, like `./Avatar`: `@dicebear/collection` is heavy, so this module
   is reached through `React.lazy` in `./VaultSwitcher` (`VaultTile`) and never
   static-imported from the startup graph. */
import { useMemo } from "react";
import { createAvatar } from "@dicebear/core";
import { icons } from "@dicebear/collection";
import { ITEM_COLORS } from "../lib/appearance";
import { NO_COLOR, type VaultIconName } from "../lib/vaultIcon";

/**
 * The SVG for one preset. DiceBear draws a white glyph on a mid-tone square;
 * we recolour it to our palette's pairing instead — the pastel fill under the
 * deeper outline of the same hue — so a vault icon reads like the coloured
 * folders in the tree.
 */
export function vaultIconSvg(icon: VaultIconName, colorId: string): string {
  // "None": no square behind it, and the glyph in the surrounding text colour
  // (`currentColor`), so it reads in both themes.
  if (colorId === NO_COLOR) {
    return createAvatar(icons, {
      seed: icon,
      icon: [icon],
      backgroundColor: ["transparent"],
      scale: 80,
    })
      .toString()
      .replace(/fill="#fff"/g, 'fill="currentColor"');
  }
  const color = ITEM_COLORS.find((c) => c.id === colorId) ?? ITEM_COLORS[0];
  return createAvatar(icons, {
    seed: icon,
    icon: [icon],
    backgroundColor: [color.fill.slice(1)],
    backgroundType: ["solid"],
    scale: 80,
  })
    .toString()
    .replace(/fill="#fff"/g, `fill="${color.value}"`);
}

export default function VaultIconSvg({
  icon,
  color,
}: {
  icon: VaultIconName;
  color: string;
}) {
  const svg = useMemo(() => vaultIconSvg(icon, color), [icon, color]);
  return <span className="vault-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
