// Minimalistic settings panel for the Graph View. Pure controlled component:
// it holds no physics or canvas state — it only renders inputs bound to the
// shared GraphSettings shape and emits partial patches upward. All visual
// styling lives in graph.css (plus the app-wide `.range-input` / `.range-value`
// in App.css); this file just emits the agreed class names.

import type { GraphSettings, ColorMode, GraphShape } from "../lib/graph/graphSettings";
import { SETTING_RANGES } from "../lib/graph/graphSettings";
import type { LegendEntry } from "../lib/graph/graphColor";

export interface GraphControlsProps {
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings>) => void;
  onReset: () => void;
  legend: LegendEntry[];
}

/** Numeric settings that get a labeled range slider, with friendly labels. */
type SliderKey = keyof typeof SETTING_RANGES;

const SLIDER_LABELS: Record<SliderKey, string> = {
  charge: "Repulsion",
  linkDistance: "Link distance",
  linkStrength: "Link force",
  gravity: "Gravity",
  nodeSize: "Node size",
  edgeThickness: "Edge width",
  labelScale: "Labels",
  minDegree: "Min links",
};

// Small pictures of each shape, drawn in currentColor so they follow the theme.
const SHAPE_ICONS: Record<GraphShape, React.JSX.Element> = {
  globe: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="11" fill="currentColor" opacity="0.12" />
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <ellipse cx="16" cy="16" rx="5" ry="11" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <path d="M5 16h22" stroke="currentColor" strokeWidth="1" opacity="0.6" />
    </svg>
  ),
  flat: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="10" cy="12" r="5" fill="currentColor" opacity="0.35" />
      <circle cx="21" cy="11" r="4" fill="currentColor" opacity="0.6" />
      <circle cx="13" cy="22" r="4.5" fill="currentColor" opacity="0.5" />
      <circle cx="23" cy="21" r="5" fill="currentColor" opacity="0.25" />
    </svg>
  ),
  radial: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <path
          key={a}
          d="M16 16 L16 5 A11 11 0 0 1 25.5 10.5 Z"
          fill="currentColor"
          opacity={0.18 + (a / 300) * 0.4}
          transform={`rotate(${a} 16 16)`}
        />
      ))}
    </svg>
  ),
  ring: (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="9 2.5" />
      <path d="M8 10 Q16 16 24 22 M8 22 Q16 16 22 8" fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.5" />
    </svg>
  ),
};

const SHAPES: { shape: GraphShape; label: string }[] = [
  { shape: "globe", label: "Globe" },
  { shape: "flat", label: "Flat" },
  { shape: "radial", label: "Radial" },
  { shape: "ring", label: "Ring" },
];

const COLOR_MODES: { mode: ColorMode; label: string }[] = [
  { mode: "folder", label: "Folder" },
  { mode: "degree", label: "Degree" },
  { mode: "uniform", label: "Uniform" },
];

/** Round a slider value for display: integers stay whole, fractional steps
 *  keep just enough precision to read cleanly (e.g. 0.3, 1.2). */
function formatValue(key: SliderKey, value: number): string {
  const step = SETTING_RANGES[key].step;
  if (Number.isInteger(step)) return String(Math.round(value));
  // step < 1 → show 1–2 decimals depending on granularity.
  const decimals = step < 0.05 ? 2 : step < 0.1 ? 2 : 1;
  return value.toFixed(decimals);
}

export function GraphControls(props: GraphControlsProps): React.JSX.Element {
  const { settings, onChange, onReset, legend } = props;
  // Radial and Ring place notes by folder and link count, not by physics.
  const fixedShape = settings.shape === "radial" || settings.shape === "ring";

  // One slider row: friendly label, native range input, live numeric readout.
  const slider = (key: SliderKey, disabled = false) => {
    const range = SETTING_RANGES[key];
    const value = settings[key] as number;
    return (
      <div className={"graph-control-row" + (disabled ? " is-disabled" : "")} key={key}>
        <label htmlFor={`graph-${key}`}>{SLIDER_LABELS[key]}</label>
        <input
          id={`graph-${key}`}
          className="range-input"
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange({ [key]: Number(e.target.value) })}
        />
        <span className="range-value">{formatValue(key, value)}</span>
      </div>
    );
  };

  return (
    <div className="graph-controls">
      {/* No Scope section. The graph is the whole vault, always — a Local/Global
          toggle meant this panel could be showing one of two different graphs
          under one name, and the whole-vault view is the one that was wanted. */}
      <div className="graph-control-group">
        <div className="graph-control-group-title">Forces</div>
        {fixedShape && (
          <p className="graph-control-note">
            Radial and Ring are fixed shapes, so forces don&apos;t move them. A dragged note springs back to its place.
          </p>
        )}
        {slider("charge", fixedShape)}
        {slider("linkDistance", fixedShape)}
        {slider("linkStrength", fixedShape)}
        {slider("gravity", fixedShape)}
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Appearance</div>
        <div className="graph-shape-grid" role="group" aria-label="Graph shape">
          {SHAPES.map(({ shape, label }) => (
            <button
              key={shape}
              type="button"
              className={"graph-shape-btn" + (settings.shape === shape ? " is-active" : "")}
              aria-pressed={settings.shape === shape}
              onClick={() => onChange({ shape })}
            >
              {SHAPE_ICONS[shape]}
              <span>{label}</span>
            </button>
          ))}
        </div>
        {slider("nodeSize")}
        {slider("edgeThickness")}
        {slider("labelScale")}
        <div className="graph-control-row is-stacked">
          <label>Color by</label>
          <div className="graph-seg" role="group" aria-label="Color mode">
            {COLOR_MODES.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                className={
                  "graph-seg-btn" + (settings.colorMode === mode ? " is-active" : "")
                }
                aria-pressed={settings.colorMode === mode}
                onClick={() => onChange({ colorMode: mode as ColorMode })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Filter</div>
        <div className="graph-control-row">
          <input
            type="text"
            className="graph-control-search"
            placeholder="Filter by title…"
            value={settings.search}
            onChange={(e) => onChange({ search: e.target.value })}
          />
        </div>
        {slider("minDegree")}
        <div className="graph-control-row">
          <label htmlFor="graph-hideOrphans">Hide unlinked</label>
          <input
            id="graph-hideOrphans"
            type="checkbox"
            checked={settings.hideOrphans}
            onChange={(e) => onChange({ hideOrphans: e.target.checked })}
          />
        </div>
      </div>

      {legend.length > 0 && (
        <div className="graph-control-group">
          <div className="graph-control-group-title">Legend</div>
          <div className="graph-legend">
            {legend.map((entry) => (
              <div className="graph-legend-row" key={entry.label}>
                <span
                  className="graph-legend-dot"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
                <span className="graph-legend-count">{entry.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="graph-control-footer">
        <button type="button" className="graph-control-reset" onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
