/* An access group's icon, drawn with DiceBear's Bootstrap-icons style, the same
   set vault icons use (`./VaultIconSvg`). LAZY ONLY: `@dicebear/collection` is
   heavy, so this is reached through `React.lazy` in `./GroupsPanel`. The glyph is
   drawn in `currentColor` with no square, so it sits on the group's own tint. */
import { useId, useMemo } from "react";
import { createAvatar } from "@dicebear/core";
import { icons } from "@dicebear/collection";
import type { GroupIconName } from "../lib/groupIcon";
import { scopeSvgIds } from "../lib/svgIds";

export function groupIconSvg(icon: GroupIconName): string {
  return createAvatar(icons, {
    seed: icon,
    icon: [icon],
    backgroundColor: ["transparent"],
    scale: 100,
  })
    .toString()
    // Only the glyph's group: the viewbox mask's rect is also fill="#fff", and a
    // coloured mask lets only part of the glyph through (it read washed out).
    .replace(/<g fill="#fff">/g, '<g fill="currentColor">')
    // Single-shape icons (megaphone, laptop, inbox, egg…) carry the white fill
    // on the path itself; left white they vanished on the group's light tint.
    .replace(/(<path\b[^>]*?)\sfill="#fff"/g, '$1 fill="currentColor"');
}

export default function GroupIconSvg({ icon }: { icon: GroupIconName }) {
  const instance = useId();
  const svg = useMemo(() => scopeSvgIds(groupIconSvg(icon), instance), [icon, instance]);
  return <span className="group-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
