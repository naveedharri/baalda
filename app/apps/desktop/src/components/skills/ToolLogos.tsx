// AI tool marks for the skills screens: the "Works with" footer of the Skills
// tab, a skill page's "Available in" line, and the AI tools rows. The
// Claude and Codex files are the dashboard runner's (`assets/agents/`); Cursor
// and Gemini come from the same MIT icon set (see assets/agents/NOTICE.txt).
// Brand colours, one quiet line: "compatible with", not a logo wall.

import claudeLogo from "../../assets/agents/claude-color.svg";
import codexLogo from "../../assets/agents/codex.svg";
import cursorLogo from "../../assets/agents/cursor.svg";
import geminiLogo from "../../assets/agents/gemini-color.svg";
import { AI_TOOL_NAME, type ToolAvailability } from "../../lib/skills/installState";

export type ToolId = "claude" | "codex" | "cursor" | "gemini";

export const TOOL_NAME: Record<ToolId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
};

const SRC: Record<ToolId, string> = { claude: claudeLogo, codex: codexLogo, cursor: cursorLogo, gemini: geminiLogo };
/** Single-colour marks drawn in black: inverted in dark mode. */
const MONO: ReadonlySet<ToolId> = new Set(["codex", "cursor"]);

export function ToolLogo({
  tool,
  size = 14,
  faded = false,
  badge,
  title,
}: {
  tool: ToolId;
  size?: number;
  faded?: boolean;
  /** A small amber or red mark on the logo for a problem. */
  badge?: "warn" | "bad";
  title?: string;
}) {
  return (
    <span
      className={`skills-tool${faded ? " is-faded" : ""}${MONO.has(tool) ? " is-mono" : ""}`}
      title={title === "" ? undefined : title ?? TOOL_NAME[tool]}
      style={{ width: size, height: size }}
    >
      <img src={SRC[tool]} alt={title ?? TOOL_NAME[tool]} width={size} height={size} draggable={false} />
      {badge && <span className={`skills-tool-badge is-${badge}`} aria-hidden="true" />}
    </span>
  );
}

/**
 * "Works with", without words: an overlapping stack of tool marks at the foot
 * of the Skills tab, like an avatar group, ending in "+3" for Copilot, OpenCode
 * and the rest. It fans out on hover; one tooltip says what it means.
 */
export function WorksWith() {
  return (
    <footer className="skills-works-with">
      <span
        className="skills-works-stack"
        title="Your skills work in Claude, Codex, Cursor, Gemini, Copilot, OpenCode and any tool that reads ~/.agents/skills."
      >
        {(["claude", "codex", "cursor", "gemini"] as const).map((t) => (
          <span key={t} className="skills-works-coin" title={TOOL_NAME[t]}>
            <ToolLogo tool={t} size={16} title="" />
          </span>
        ))}
        <span className="skills-works-coin is-more" title="Copilot, OpenCode and more">+3</span>
      </span>
    </footer>
  );
}

/** Each AI tool's mark (and name), full when it can use the skill here, faded with the reason otherwise. */
export function ToolMarks({ tools, names = true }: { tools: readonly ToolAvailability[]; names?: boolean }) {
  return (
    <span className="skills-tool-marks">
      {tools.map((t, i) => (
        <span key={t.tool} className={`skills-available-tool${t.on ? "" : " is-off"}`} title={t.reason ?? t.note ?? `${AI_TOOL_NAME[t.tool]} can use this skill`}>
          {names && i > 0 && <span className="skills-available-sep" aria-hidden="true">·</span>}
          <ToolLogo tool={t.tool} size={16} faded={!t.on} title="" />
          {names && AI_TOOL_NAME[t.tool]}
        </span>
      ))}
    </span>
  );
}

/** A device skill page's "Available in" line. */
export function AvailableIn({ tools }: { tools: readonly ToolAvailability[] }) {
  return (
    <div className="skills-available">
      <span className="skills-available-label">{tools.every((t) => !t.on) ? "Not available in any AI tool here" : "Available in"}</span>
      <ToolMarks tools={tools} />
    </div>
  );
}
