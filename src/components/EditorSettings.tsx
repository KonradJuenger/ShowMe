import { PropertySection } from "./ElementPanel";
import type { SelectionMode } from "../core/editorPreferences";
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
  showRulers: boolean;
  onToggleRulers(): void;
  showGuides: boolean;
  onToggleGuides(): void;
  showFrameBorders: boolean;
  onToggleFrameBorders(): void;
  onEditLayoutGuides(): void;
  onGenerateGrid(): void;
  onDeleteGuides(): void;
  previewSlide: boolean;
  onTogglePreviewSlide(): void;
}

export function EditorSettings(props: EditorSettingsProps) {
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
      <PropertySection title="View">
        {toggle("Rulers", props.showRulers, props.onToggleRulers)}
        {toggle("Guides", props.showGuides, props.onToggleGuides)}
        {toggle(
          "Element bounds",
          props.showFrameBorders,
          props.onToggleFrameBorders,
        )}
        <button
          type="button"
          className="element-wide"
          onClick={props.onEditLayoutGuides}
        >
          Edit Layout Guides…
        </button>
      </PropertySection>
      <PropertySection title="Preview">
        {toggle(
          "Preview mode",
          props.previewSlide,
          props.onTogglePreviewSlide,
        )}
        <p className="element-wide">
          Audience view without editor overlays. Shortcut W.
        </p>
      </PropertySection>
    </div>
  );
}
