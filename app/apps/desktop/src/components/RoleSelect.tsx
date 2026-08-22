import { ASSIGNABLE_ROLES, type AssignableRole } from "./memberRoles";
import { MenuSelect } from "./MenuSelect";

/**
 * Role picker used by the Members tab — the invite bar ("field" variant) and
 * each member row ("pill" variant, styled like the static role badge it
 * replaces so unchangeable rows and changeable ones read as the same thing).
 *
 * The popover itself lives in {@link MenuSelect}, shared with the Access
 * panel's per-member picker; this is just the role-shaped face of it.
 */
export function RoleSelect({
  value,
  onSelect,
  disabled,
  ariaLabel,
  variant,
}: {
  value: AssignableRole;
  onSelect: (role: AssignableRole) => void | Promise<void>;
  disabled?: boolean;
  ariaLabel: string;
  variant: "field" | "pill";
}) {
  return (
    <MenuSelect
      value={value}
      options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r }))}
      onSelect={onSelect}
      disabled={disabled}
      ariaLabel={ariaLabel}
      triggerClassName={
        variant === "pill" ? `member-role ${value} role-trigger` : "role-field-trigger"
      }
    />
  );
}
