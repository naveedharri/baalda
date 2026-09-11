/**
 * What type a property is, when the vault's registry has not been told.
 *
 * Two sources, in order: the per-vault registry (`.context/types.json`, see
 * `./types.ts`) and — for everything it has never heard of — the shape of the
 * YAML itself. Inference has to be stable: a `date` that flips to `text` the
 * moment someone clears it would change the control under the user's cursor.
 */

import type { PropValue } from "./parse";

export type PropertyType =
  | "text"
  | "list"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "tags"
  | "aliases";

export const PROPERTY_TYPES: ReadonlyArray<{ id: PropertyType; label: string }> = [
  { id: "text", label: "Text" },
  { id: "list", label: "List" },
  { id: "number", label: "Number" },
  { id: "checkbox", label: "Checkbox" },
  { id: "date", label: "Date" },
  { id: "datetime", label: "Date & time" },
  { id: "tags", label: "Tags" },
  { id: "aliases", label: "Aliases" },
];

/** The types that render as chips rather than a single field. */
export function isListType(type: PropertyType): boolean {
  return type === "list" || type === "tags" || type === "aliases";
}

/**
 * `tags` is always the tags type and cannot be overridden — it is what Rust's
 * `frontmatter_tags` reads to build the tag index, and letting someone call it
 * a number would silently break that. `aliases` merely *defaults* to aliases.
 */
export function isFixedType(key: string): boolean {
  return key.toLowerCase() === "tags";
}

/** Type from the YAML shape alone. Pure; the registry wins over this. */
export function inferType(key: string, value: PropValue): PropertyType {
  const k = key.toLowerCase();
  if (k === "tags" || k === "tag") return "tags";
  if (k === "aliases" || k === "alias") return "aliases";
  switch (value.kind) {
    case "list":
      return "list";
    case "checkbox":
      return "checkbox";
    case "number":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    default:
      return "text";
  }
}

/**
 * Re-shape a value for a type the user just picked. Losing data here would be
 * the worst possible outcome of a mis-click, so every conversion keeps the text
 * it cannot represent (a list becomes a comma-joined string, a number that is
 * not a number stays text).
 */
export function coerceValue(value: PropValue, type: PropertyType): PropValue {
  const asText =
    value.kind === "list" ? value.value.join(", ") : String(value.value);
  switch (type) {
    case "list":
    case "tags":
    case "aliases":
      if (value.kind === "list") return value;
      return {
        kind: "list",
        value: asText.trim() === "" ? [] : asText.split(",").map((s) => s.trim()),
      };
    case "number": {
      const n = Number(asText);
      return Number.isFinite(n) && asText.trim() !== ""
        ? { kind: "number", value: n }
        : { kind: "text", value: asText };
    }
    case "checkbox":
      return { kind: "checkbox", value: asText.trim() === "true" };
    case "date":
      return { kind: "date", value: asText.slice(0, 10) };
    case "datetime":
      return { kind: "datetime", value: asText };
    default:
      return { kind: "text", value: asText };
  }
}
