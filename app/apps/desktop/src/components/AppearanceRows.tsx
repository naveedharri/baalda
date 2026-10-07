import type { ReactNode } from "react";
import {
  APPEARANCE_DEFAULTS,
  type AppearanceKey,
  type AppearanceSettings,
  type ResolvedAppearance,
} from "../lib/appearanceSettings";
import type { PropertiesMode } from "../lib/editor/frontmatter";
import {
  EDITOR_MEASURE_SLIDER_MAX,
  EDITOR_MEASURE_SLIDER_MIN,
  EDITOR_MEASURE_STEP,
  measureLabel,
  measureToSlider,
  sliderToMeasure,
} from "../lib/editorMeasure";
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_FONT_SIZE_STEP,
  PROPERTIES_MODES,
} from "../lib/prefs";
import type { ThemeMode } from "../lib/theme";
import { ContentWidthPreview } from "./ContentWidthPreview";
import { MenuSelect } from "./MenuSelect";
import { Switch } from "./Switch";
import { ThemeToggle } from "./ThemeToggle";

const NOT_SET = "__not_set__";
type NotSet = typeof NOT_SET;

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The six appearance rows, shared by Account Settings → Appearance (personal)
 * and Vault Settings → Appearance (defaults for everyone).
 *
 * personal: shows the EFFECTIVE values exactly as before, plus `trailing(key)`
 *   (the "Vault default" tag or the "Reset to vault default" link).
 * vault: every row has an explicit Not set state. Selects gain a "Not set"
 *   option, toggles show a "Not set" tag until switched and a Clear link once
 *   set, sliders carry a "Not set" checkbox. `readOnly` disables every control.
 */
export function AppearanceRows(props: {
  mode: "personal" | "vault";
  /** What each control shows. In vault mode, unset keys show the app default. */
  values: ResolvedAppearance;
  /** Vault mode: which keys the vault actually sets. */
  settings?: AppearanceSettings;
  onChange: <K extends AppearanceKey>(key: K, value: AppearanceSettings[K] | undefined) => void;
  readOnly?: boolean;
  trailing?: (key: AppearanceKey) => ReactNode;
}) {
  const { mode, values, settings = {}, onChange, readOnly = false, trailing } = props;
  const vault = mode === "vault";
  const isSet = (k: AppearanceKey) => !vault || settings[k] !== undefined;
  const tail = (k: AppearanceKey) => trailing?.(k) ?? null;

  /** Toggle rows in vault mode: a Not set tag, or a Clear link once set. */
  const toggleExtra = (k: AppearanceKey) =>
    vault ? (
      isSet(k) ? (
        !readOnly && (
          <button
            type="button"
            className="link-btn appearance-clear"
            // Inside the row's <label>: without this the click also flips the Switch.
            onClick={(e) => {
              e.preventDefault();
              onChange(k, undefined);
            }}
          >
            Clear
          </button>
        )
      ) : (
        <span className="appearance-tag">Not set</span>
      )
    ) : null;

  /** Slider rows in vault mode: a "Not set" checkbox that clears or seeds the key. */
  const notSetBox = <K extends AppearanceKey>(k: K, seed: AppearanceSettings[K]) =>
    vault ? (
      <label className="appearance-notset">
        <input
          type="checkbox"
          checked={!isSet(k)}
          disabled={readOnly}
          onChange={(e) => onChange(k, e.target.checked ? undefined : seed)}
        />
        Not set
      </label>
    ) : null;

  return (
    <>
      <div className="menu-row">
        <span className="menu-row-label">Theme</span>
        {tail("theme")}
        {vault ? (
          <MenuSelect<ThemeMode | NotSet>
            value={settings.theme ?? NOT_SET}
            options={[{ value: NOT_SET, label: "Not set" }, ...THEME_OPTIONS]}
            onSelect={(v) => onChange("theme", v === NOT_SET ? undefined : v)}
            disabled={readOnly}
            ariaLabel="Theme"
            triggerClassName="role-field-trigger"
          />
        ) : (
          <ThemeToggle />
        )}
      </div>
      <label className="menu-row toggle-row">
        <span className="menu-row-label">
          Automatic file colors
          <span className="field-hint">
            Give every uncoloured file and folder a personal, stable colour.
          </span>
        </span>
        {tail("autoColors")}
        {toggleExtra("autoColors")}
        <Switch
          checked={values.autoColors}
          disabled={readOnly}
          ariaLabel="Automatic file colors"
          onChange={(next) => onChange("autoColors", next)}
        />
      </label>
      {/* The slider applies on every change rather than on release: the
          preview under it — and the note behind the card — are the answer to
          "how wide is that?", and they have to move with the thumb. */}
      <div className="menu-row measure-row">
        {/* A real <label>, not the row: wrapping a range in one would hijack
            the drag. The row's text is still a click target for the slider. */}
        <label className="menu-row-label" htmlFor={`content-width-${mode}`}>
          Content width
          <span className="field-hint">
            How wide the text runs before it wraps. Drag to the end for the full window.
          </span>
        </label>
        {tail("contentWidth")}
        {notSetBox("contentWidth", values.contentWidth)}
        <span className="range-field">
          <input
            id={`content-width-${mode}`}
            className="range-input"
            type="range"
            min={EDITOR_MEASURE_SLIDER_MIN}
            max={EDITOR_MEASURE_SLIDER_MAX}
            step={EDITOR_MEASURE_STEP}
            value={measureToSlider(values.contentWidth)}
            disabled={readOnly || !isSet("contentWidth")}
            // The <label> also carries the hint line; name the control with the
            // row's title alone rather than reading the whole paragraph out.
            aria-label="Content width"
            aria-valuetext={measureLabel(values.contentWidth)}
            onChange={(e) => onChange("contentWidth", sliderToMeasure(Number(e.target.value)))}
          />
          <span className="range-value">{measureLabel(values.contentWidth)}</span>
        </span>
        <ContentWidthPreview measure={values.contentWidth} />
      </div>
      <div className="menu-row measure-row">
        <label className="menu-row-label" htmlFor={`editor-text-size-${mode}`}>
          Text size
          <span className="field-hint">The size of note text in the editor.</span>
        </label>
        {tail("textSize")}
        {notSetBox("textSize", values.textSize)}
        <span className="range-field">
          <input
            id={`editor-text-size-${mode}`}
            className="range-input"
            type="range"
            min={EDITOR_FONT_SIZE_MIN}
            max={EDITOR_FONT_SIZE_MAX}
            step={EDITOR_FONT_SIZE_STEP}
            value={values.textSize}
            disabled={readOnly || !isSet("textSize")}
            aria-label="Text size"
            aria-valuetext={`${values.textSize} pixels`}
            onChange={(e) => onChange("textSize", Number(e.target.value))}
          />
          <span className="range-value">{values.textSize}px</span>
        </span>
      </div>
      <label className="menu-row toggle-row">
        <span className="menu-row-label">
          Line numbers
          <span className="field-hint">Show a line-number gutter in the editor.</span>
        </span>
        {tail("lineNumbers")}
        {toggleExtra("lineNumbers")}
        <Switch
          checked={values.lineNumbers}
          disabled={readOnly}
          ariaLabel="Line numbers"
          onChange={(next) => onChange("lineNumbers", next)}
        />
      </label>
      {/* How the editor draws, so device-local unless a vault sets a default. */}
      <div className="menu-row">
        <span className="menu-row-label">
          Properties in document
          <span className="field-hint">
            How a note's YAML frontmatter is shown at the top of the note.
          </span>
        </span>
        {tail("properties")}
        <MenuSelect<PropertiesMode | NotSet>
          value={vault ? (settings.properties ?? NOT_SET) : values.properties}
          options={[
            ...(vault ? [{ value: NOT_SET as NotSet, label: "Not set" }] : []),
            ...PROPERTIES_MODES.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
          ]}
          onSelect={(m) => onChange("properties", m === NOT_SET ? undefined : m)}
          disabled={readOnly}
          ariaLabel="Properties in document"
          triggerClassName="role-field-trigger"
        />
      </div>
    </>
  );
}

/** Vault mode shows the app default under a Not set row. */
export function vaultDisplayValues(settings: AppearanceSettings): ResolvedAppearance {
  return { ...APPEARANCE_DEFAULTS, ...settings } as ResolvedAppearance;
}
