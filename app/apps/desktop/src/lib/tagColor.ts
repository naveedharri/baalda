/* Redesign preview: one stable pastel per tag name, shared by #tags in the
   editor and tag chips in Properties. Pairs from baalda.com's palette. */
const TAG_COLORS: Array<[string, string]> = [
  ["#ece6ff", "#5b3fd6"], // violet
  ["#dff3e5", "#2f7044"], // green
  ["#fff1c9", "#7a5a00"], // yellow
  ["#dcf0f8", "#2d6e80"], // sky
  ["#fde3ef", "#a0336f"], // pink
  ["#fde6d6", "#9a4a17"], // orange
  ["#e3e8fb", "#3b52b0"], // indigo
  ["#e2f3ef", "#226b5c"], // teal
];

export function tagColor(name: string): { bg: string; fg: string } {
  const key = name.replace(/^#/, "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const [bg, fg] = TAG_COLORS[(h >>> 0) % TAG_COLORS.length];
  return { bg, fg };
}
