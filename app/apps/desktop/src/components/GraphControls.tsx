// Minimalistic settings panel for the Graph View. Pure controlled component:
// it holds no physics or canvas state — it only renders inputs bound to the
// shared GraphSettings shape and emits partial patches upward. All visual
// styling lives in graph.css; this file just emits the agreed class names.

import type { GraphSettings, ColorMode, GraphScope } from "../lib/graph/graphSettings";
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
  localDepth: "Depth",
  charge: "Repulsion",
  linkDistance: "Link distance",
  linkStrength: "Link force",
  gravity: "Gravity",
  nodeSize: "Node size",
  edgeThickness: "Edge width",
  labelScale: "Labels",
  minDegree: "Min links",
};

const COLOR_MODES: { mode: ColorMode; label: string }[] = [
  { mode: "folder", label: "Folder" },
  { mode: "degree", label: "Degree" },
  { mode: "uniform", label: "Uniform" },
];

const SCOPE_MODES: { scope: GraphScope; label: string }[] = [
  { scope: "local", label: "Local" },
  { scope: "global", label: "Global" },
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

  // One slider row: friendly label, native range input, live numeric readout.
  const slider = (key: SliderKey) => {
    const range = SETTING_RANGES[key];
    const value = settings[key] as number;
    return (
      <div className="graph-control-row" key={key}>
        <label htmlFor={`graph-${key}`}>{SLIDER_LABELS[key]}</label>
        <input
          id={`graph-${key}`}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          onChange={(e) => onChange({ [key]: Number(e.target.value) })}
        />
        <span className="graph-control-val">{formatValue(key, value)}</span>
      </div>
    );
  };

  return (
    <div className="graph-controls">
      <div className="graph-control-group">
        <div className="graph-control-group-title">Scope</div>
        <div className="graph-control-row">
          <label>Show</label>
          <div className="graph-seg" role="group" aria-label="Graph scope">
            {SCOPE_MODES.map(({ scope, label }) => (
              <button
                key={scope}
                type="button"
                className={
                  "graph-seg-btn" + (settings.scope === scope ? " is-active" : "")
                }
                aria-pressed={settings.scope === scope}
                onClick={() => onChange({ scope })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {settings.scope === "local" && slider("localDepth")}
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Forces</div>
        {slider("charge")}
        {slider("linkDistance")}
        {slider("linkStrength")}
        {slider("gravity")}
      </div>

      <div className="graph-control-group">
        <div className="graph-control-group-title">Appearance</div>
        {slider("nodeSize")}
        {slider("edgeThickness")}
        {slider("labelScale")}
        <div className="graph-control-row">
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
