/** A member's display name from the org roster, else a neutral word (never a raw id). */
export function memberDisplayName(
  members: ReadonlyArray<{ userId: string; user?: { name?: string; email?: string } }>,
  userId: string,
): string {
  const m = members.find((x) => x.userId === userId);
  return m?.user?.name?.trim() || m?.user?.email || "A teammate";
}
