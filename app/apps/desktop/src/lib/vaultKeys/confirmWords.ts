// "Save your vault key": the key only counts as saved once the person re-types
// three randomly chosen words of the 24. Pure, so it is tested in Node.

/** Three distinct word positions (0-based, ascending). */
export function pickConfirmPositions(count = 24, rand: () => number = Math.random): number[] {
  const picked = new Set<number>();
  while (picked.size < Math.min(3, count)) picked.add(Math.floor(rand() * count));
  return [...picked].sort((a, b) => a - b);
}

/** Every typed word matches its position (case and spaces ignored). */
export function confirmWordsMatch(words: string, positions: number[], typed: string[]): boolean {
  const list = words.trim().toLowerCase().split(/\s+/);
  return (
    positions.length > 0 &&
    positions.length === typed.length &&
    positions.every((p, i) => list[p] !== undefined && typed[i].trim().toLowerCase() === list[p])
  );
}
