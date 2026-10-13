import { PropertySection } from "./ElementPanel";
import type { SelectionMode } from "../core/editorPreferences";
import {
  defaultDragSnapSettings,
  type DragSnapSettings,
} from "../core/dragSnapping";
import "./EditorSettings.css";

export interface EditorSettingsProps {
  onOpenAppSettings(): void;
  selectionMode: SelectionMode;
  onSelectionModeChange(mode: SelectionMode): void;
  snapping: boolean;
  onToggleSnapping(): void;
  snapToObjects: boolean;
  onToggleSnapToObjects(): void;
  snapToGuides: boolean;
  onToggleSnapToGuides(): void;
  snapToSlide: boolean;
  onToggleSnapToSlide(): void;
  dragSnapping: DragSnapSettings;
  onDragSnappingChange(settings: DragSnapSettings): void;
  showRulers: boolean;
  onToggleRulers(): void;
  showGuides: boolean;
  onToggleGuides(): void;
  showFrameBorders: boolean;
  onToggleFrameBorders(): void;
  onEditLayoutGuides(): void;
  onGenerateGrid(): void;
  onDeleteGuides(): void;
  previewMedia: boolean;
  onTogglePreviewMedia(): void;
}

export function EditorSettings(props: EditorSettingsProps) {
  const slider = (
    label: string,
    key: keyof DragSnapSettings,
    min: number,
    max: number,
    step = 1,
    unit = "px",
  ) => (
    <label className="element-wide editor-snap-slider">
      <span>
        {label}{" "}
        <output>
          {props.dragSnapping[key]} {unit}
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        aria-label={label}
        aria-valuetext={`${props.dragSnapping[key]} ${unit}`}
        value={props.dragSnapping[key]}
        disabled={!props.snapping}
        onChange={(event) =>
          props.onDragSnappingChange({
            ...props.dragSnapping,
            [key]: Number(event.target.value),
          })
        }
      />
    </label>
  );
  const toggle = (label: string, checked: boolean, onChange: () => void) => (
    <label className="element-property element-property-checkbox">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        aria-checked={checked}
        onChange={onChange}
      />
    </label>
  );
  return (
    <div className="editor-settings-panel">
      <PropertySection title="Application">
        <button
          type="button"
          className="element-wide"
          onClick={props.onOpenAppSettings}
        >
          App Settings…
        </button>
      </PropertySection>
      <PropertySection title="Selection">
        <fieldset className="element-wide editor-selection-options">
          <legend className="visually-hidden">Selection mode</legend>
          {(
            [
              ["simple", "Simple", "Touching objects in either direction"],
              ["directional", "Directional", "→ Contained · ← Touching"],
              [
                "reverse-directional",
                "Reverse Directional",
                "→ Touching · ← Contained",
              ],
            ] as const
          ).map(([value, label, description]) => (
            <label
              key={value}
              className="editor-selection-option"
              data-checked={props.selectionMode === value}
            >
              <input
                type="radio"
                name="selection-mode"
                value={value}
                aria-label={label}
                aria-describedby={`selection-mode-${value}`}
                checked={props.selectionMode === value}
                aria-checked={props.selectionMode === value}
                onChange={() => props.onSelectionModeChange(value)}
              />
              <span className="editor-selection-copy">
                <span className="editor-selection-name">{label}</span>
                <span
                  id={`selection-mode-${value}`}
                  className="editor-selection-description"
                >
                  {description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </PropertySection>
      <PropertySection title="Snapping">
        {toggle("Enable snapping", props.snapping, props.onToggleSnapping)}
        {toggle(
          "Snap to Objects",
          props.snapToObjects,
          props.onToggleSnapToObjects,
        )}
        {toggle(
          "Snap to Guides",
          props.snapToGuides,
          props.onToggleSnapToGuides,
        )}
        {toggle(
          "Snap to Slide Edges & Center",
          props.snapToSlide,
          props.onToggleSnapToSlide,
        )}
        <p className="element-wide editor-selection-description">
          Slow down to capture nearby edges and centers. Canvas edges take
          priority over object alignments. Set Hold distance to 0 for capture
          without sticking after movement.
        </p>
        {slider("Capture distance", "intentCapture", 1, 8)}
        {slider("Hold distance", "intentRelease", 0, 24)}
        {slider("Capture below speed", "intentSpeed", 150, 1200, 50, "px/s")}
        <button
          type="button"
          className="element-wide"
          onClick={() =>
            props.onDragSnappingChange({ ...defaultDragSnapSettings })
          }
        >
          Reset tuning
        </button>
        <p className="element-wide editor-selection-description">
          Drag tuning lasts for this editor session.
        </p>
        <p className="element-wide">
          Hold Alt while dragging to bypass snapping.
        </p>
        <div className="element-wide editor-guide-actions">
          <button type="button" onClick={props.onGenerateGrid}>
            Generate Guide Grid…
          </button>
          <button
            type="button"
            className="danger"
            onClick={props.onDeleteGuides}
          >
            Delete Guides
          </button>
        </div>
      </PropertySection>
      <PropertySection title="View & playback">
        {toggle("Rulers", props.showRulers, props.onToggleRulers)}
        {toggle("Guides", props.showGuides, props.onToggleGuides)}
        {toggle(
          "Frame & text box borders",
          props.showFrameBorders,
          props.onToggleFrameBorders,
        )}
        {toggle(
          "Preview media",
          props.previewMedia,
          props.onTogglePreviewMedia,
        )}
        <button
          type="button"
          className="element-wide"
          onClick={props.onEditLayoutGuides}
        >
          Edit Layout Guides…
        </button>
      </PropertySection>
    </div>
  );
}
