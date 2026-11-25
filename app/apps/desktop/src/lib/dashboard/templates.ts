// SPDX-License-Identifier: Apache-2.0
import { IMPORTED_DASHBOARD_TEMPLATES, type DashboardTemplate } from "./importedTemplates";
import { DEPLOYED_OS_TEMPLATES } from "./deployedTemplates";
export type { DashboardTemplate } from "./importedTemplates";
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [{
  id: "orbit-agentic-os",
  name: "Orbit: Agentic OS",
  author: "Baalda",
  category: "Agentic OS",
  palette: ["#83e4ee", "#b6a4f7", "#080d13"],
  description: "An animated command center with missions, skills, memory, signals, and activity. Dark and light themes included.",
  source: "Baalda original · Apache-2.0",
  previewUrl: "/dashboard-templates/orbit-agentic-os.html",
  thumbnailUrl: "/dashboard-thumbnails/orbit-agentic-os.webp",
  prompt: "Personalize Orbit, my Agentic OS dashboard, using the relevant notes in my vault. Read the customization comment and DEMO data first. Keep its dark and light themes, responsive pages, animated core and reduced-motion support. Replace sample metrics, missions, skills, memory and reports with supported facts; keep anything still simulated clearly labeled. Use Baalda's existing permission-checked dashboard API for live reads. Do not invent agent connections or execute workflows from the template. Preserve this HTML file's identity and the bundled font license notices.",
  loadHtml: async () => {
    const response = await fetch("/dashboard-templates/orbit-agentic-os.html");
    if (!response.ok) throw new Error("This template is unavailable. Try another template.");
    return response.text();
  },
}, {
  id: "waystation-agentic-os",
  name: "Waystation: Agentic OS",
  author: "Baalda",
  category: "Agentic OS",
  palette: ["#8edec1", "#f3c77e", "#10191d"],
  description: "An animated isometric agent studio with six stations, a work queue, routines and an output archive. Night and day themes included.",
  source: "Baalda original · Apache-2.0",
  previewUrl: "/dashboard-templates/waystation-agentic-os.html",
  thumbnailUrl: "/dashboard-thumbnails/waystation-agentic-os.webp",
  prompt: "Personalize Waystation using supported facts from my vault. Read the customization comment and DEMO data. Preserve the isometric room, selectable stations, night/day themes, responsive layout and reduced-motion support. Replace sample agents, tasks, routines and artifacts with my workflow. Keep simulations labeled; do not invent connections or execute tasks from this HTML. Use Baalda's permission-checked API for live reads. Preserve file identity and font license notices.",
  loadHtml: async () => {
    const response = await fetch("/dashboard-templates/waystation-agentic-os.html");
    if (!response.ok) throw new Error("This template is unavailable. Try another template.");
    return response.text();
  },
}, {
  id: "meridian-agentic-os",
  name: "Meridian: Agentic OS",
  author: "Baalda",
  category: "Agentic OS",
  palette: ["#c4aff7", "#e5aac7", "#17131e"],
  description: "A personal observatory for apps, routines, memory and skills, with an interactive artifact atlas, calendar and inbox. Dark and light themes included.",
  source: "Baalda original · Apache-2.0",
  previewUrl: "/dashboard-templates/meridian-agentic-os.html",
  thumbnailUrl: "/dashboard-thumbnails/meridian-agentic-os.webp",
  prompt: "Personalize Meridian using supported facts from my vault. Read its customization comment and DEMO data. Keep the artifact atlas, searchable library, memory map, dark/light themes and reduced-motion support. Adapt the apps, routines, calendar, inbox and skill playbooks to my work. Keep demo data and simulated runs labeled until replaced; never invent agent connections or schedules. Use Baalda's existing permission-checked API for live reads. Preserve this HTML file's identity and font license notices.",
  loadHtml: async () => {
    const response = await fetch("/dashboard-templates/meridian-agentic-os.html");
    if (!response.ok) throw new Error("This template is unavailable. Try another template.");
    return response.text();
  },
}, ...DEPLOYED_OS_TEMPLATES, ...IMPORTED_DASHBOARD_TEMPLATES];

export function dashboardPrompt(path: string, vaultPath: string, request = "Update this dashboard using my notes."): string {
  return `${request}\n\nDashboard: ${path}\nVault folder: ${vaultPath}\nBaalda renders; it never generates. Read the HTML comment at the top of the file for the optional baalda API. Read relevant Markdown notes or use the Baalda MCP tools; keep those notes as the source of truth, without a separate JSON export. Update this HTML file via filesystem edits or MCP update_note/edit_note, preserving its identity. Only use information I can read and don't invent facts. No fetch/XHR/WebSocket; inline JS or allowed CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com). Use /__baalda/sdk.js only when live data is useful; no localStorage. Optional API: vault.info/stats; notes.search/list/read/meta/backlinks; graph.edges; tags.list; properties.keys/values; state.get/set; app.open/openExternal. List filters: folder,tag,property:{key,value},modifiedSince (Unix seconds),sort,limit. Use CSS theme variables --bg,--fg,--surface,--muted,--accent,--border. Write the page the user asked for.`;
}
export async function copyDashboardPrompt(path: string, vaultPath: string, request?: string) {
  await navigator.clipboard.writeText(dashboardPrompt(path, vaultPath, request));
}

/** Designs whose page is dark, measured from their thumbnails (average
 *  brightness under 30 of 255; every other design is light, above 180). */
const DARK_TEMPLATES = new Set([
  "black-dashboard", "corona-free-dark-bootstrap-admin-template", "cosmos-agentic-os",
  "marketing-os", "meridian-agentic-os", "orbit-agentic-os", "waystation-agentic-os",
]);
export const isDarkTemplate = (t: DashboardTemplate): boolean => DARK_TEMPLATES.has(t.id);

/** Style tabs after "All styles": Minimal first, the rest in catalog order. */
export function templateCategories(templates: readonly DashboardTemplate[]): string[] {
  const all = [...new Set(templates.map((t) => t.category).filter(Boolean))];
  return [...all.filter((c) => c === "Minimal"), ...all.filter((c) => c !== "Minimal")];
}

/**
 * The "All styles" order: light and dark designs mixed evenly through the
 * grid instead of every dark one in a block, leading with a light Minimal one.
 * Within each tone, categories follow {@link templateCategories}.
 */
export function mixedTemplateOrder(templates: readonly DashboardTemplate[]): DashboardTemplate[] {
  const rank = new Map(templateCategories(templates).map((c, i) => [c, i] as const));
  const byCategory = (list: DashboardTemplate[]) =>
    list
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (rank.get(a.t.category) ?? 99) - (rank.get(b.t.category) ?? 99) || a.i - b.i)
      .map((x) => x.t);
  const light = byCategory(templates.filter((t) => !isDarkTemplate(t)));
  const dark = byCategory(templates.filter(isDarkTemplate));
  const out: DashboardTemplate[] = [];
  const total = light.length + dark.length;
  let d = 0;
  let l = 0;
  for (let k = 0; k < total; k++) {
    // Dark ones land at evenly spaced slots, never first: slot k takes a dark
    // design once the share placed so far falls behind dark/total.
    const wantDark = k > 0 && d < dark.length && (l >= light.length || d < Math.floor(((k + 1) * dark.length) / total));
    out.push(wantDark ? dark[d++] : light[l++]);
  }
  return out;
}
