// An access group's icon: picked from its NAME so "Design" gets a palette and
// "Sales" a coin, with no setting to store. A name we don't recognise gets a
// stable pick from the group's id. Drawn with the same DiceBear icon set as
// vault icons (`components/GroupIconSvg.tsx`, lazy).

/** The DiceBear `icons` names this file uses (all exist in that set). */
export type GroupIconName =
  | "palette" | "megaphone" | "cashCoin" | "piggyBank" | "laptop" | "bug" | "inbox" | "puzzle"
  | "binoculars" | "search" | "lock" | "emojiSmile" | "boxSeam" | "award" | "pen" | "mortarboard"
  | "briefcase" | "key" | "egg" | "cameraReels" | "ticketPerforated" | "truck" | "shop" | "phone"
  | "router" | "speaker" | "globe2" | "houseDoor" | "calculator" | "handThumbsUp" | "newspaper"
  | "lightbulb" | "star" | "gem" | "lightning" | "flower1" | "tree" | "sun" | "moonStars"
  | "compass" | "magic" | "gift" | "flag" | "umbrella" | "cup" | "bicycle";

/**
 * Words → icon, first match wins. Words of 3 letters or fewer must be the whole
 * word ("pr", "qa", "it"); longer ones match the start of a word, so "Designers"
 * and "Marketing team" both match.
 */
const RULES: ReadonlyArray<readonly [GroupIconName, readonly string[]]> = [
  ["bug", ["qa", "test", "tester", "quality"]],
  ["palette", ["design", "ux", "ui", "creative", "brand", "art", "artist", "illustrat"]],
  ["megaphone", ["marketing", "growth", "pr", "comms", "communicat", "social", "campaign", "seo", "ads"]],
  ["cashCoin", ["sales", "sale", "revenue", "deal", "bizdev", "bd", "account"]],
  ["piggyBank", ["finance", "financ", "accounting", "billing", "payroll", "money", "budget", "treasury"]],
  ["router", ["devops", "infra", "platform", "sre", "ops"]],
  ["laptop", ["engineer", "dev", "developer", "tech", "code", "coder", "it", "backend", "frontend", "software", "web"]],
  ["phone", ["mobile", "ios", "android", "app", "apps"]],
  ["inbox", ["support", "help", "helpdesk", "cs", "service", "success", "care"]],
  ["puzzle", ["product", "pm", "pms"]],
  ["binoculars", ["research", "insight", "user"]],
  ["search", ["data", "analytic", "analyst", "bi"]],
  ["lock", ["legal", "compliance", "security", "privacy", "admin", "admins", "lawyer"]],
  ["emojiSmile", ["hr", "people", "talent", "recruit", "hiring", "culture"]],
  ["boxSeam", ["operation", "logistic", "warehouse", "inventory"]],
  ["truck", ["shipping", "delivery", "fulfil", "supply"]],
  ["award", ["leader", "leadership", "exec", "management", "manager", "founder", "board", "director", "c-suite"]],
  ["pen", ["writer", "writing", "editor", "editorial", "content", "copy", "docs", "blog"]],
  ["newspaper", ["news", "press", "journal"]],
  ["mortarboard", ["education", "training", "learning", "onboarding", "teacher", "student", "school", "course"]],
  ["egg", ["intern", "interns", "junior", "new", "newbie", "trainee"]],
  ["briefcase", ["contractor", "freelanc", "consultant", "agency", "vendor"]],
  ["key", ["guest", "client", "customer", "external", "partner", "investor"]],
  ["cameraReels", ["video", "media", "film", "photo", "youtube", "studio"]],
  ["speaker", ["podcast", "audio", "music", "sound"]],
  ["ticketPerforated", ["event", "events", "community-events"]],
  ["globe2", ["community", "global", "international", "world"]],
  ["shop", ["shop", "store", "ecommerce", "retail", "merch"]],
  ["lightbulb", ["idea", "ideas", "innovation", "strategy", "lab", "labs"]],
  ["handThumbsUp", ["review", "reviewer", "approver", "feedback"]],
  ["calculator", ["math", "pricing", "tax"]],
  ["houseDoor", ["everyone", "all", "team", "staff", "core", "home", "company"]],
];

/** Pleasant icons for a name with no match; picked by the group's id. */
const FALLBACK: readonly GroupIconName[] = [
  "star", "gem", "lightning", "flower1", "tree", "sun", "moonStars", "compass", "magic", "gift", "flag", "umbrella", "cup", "bicycle",
];

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The icon for a group, from its name, else a stable pick from its id. */
export function groupIconFor(group: { id: string; name: string }): GroupIconName {
  const words = group.name.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const [icon, keys] of RULES) {
    for (const key of keys) {
      const hit = key.length <= 3 ? words.includes(key) : words.some((w) => w.startsWith(key));
      if (hit) return icon;
    }
  }
  return FALLBACK[hash(`group\0${group.id}`) % FALLBACK.length];
}
