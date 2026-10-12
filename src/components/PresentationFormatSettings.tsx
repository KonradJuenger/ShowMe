import { useRef, useState } from "react";
import {
  presentationFormat,
  presentationSizePresets,
  type CanvasDimensions,
} from "../core/presentationDimensions";

export function PresentationFormatSettings({
  size,
  onRatioChange,
  onCanvasChange,
}: {
  size: CanvasDimensions;
  onRatioChange(ratio: CanvasDimensions): void;
  onCanvasChange(changes: Partial<CanvasDimensions>): void;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<CanvasDimensions | null>(null);
  const fields = useRef<HTMLFieldSetElement>(null);
  const preset = presentationFormat(size);
  const cancel = () => {
    const inputs = fields.current?.querySelectorAll<HTMLInputElement>("input");
    if (inputs) {
      inputs[0].value = String(size.width);
      inputs[1].value = String(size.height);
    }
    setDraft(null);
  };
  const commit = () => {
    if (!draft) return;
    if (
      [draft.width, draft.height, draft.width / draft.height].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    ) {
      onRatioChange(draft);
      setDraft(null);
    } else cancel();
  };
  return (
    <>
      <label className="element-property element-wide">
        <span title="Applies to every slide and template. Existing content keeps its layout coordinates.">
          Slide format
        </span>
        <select
          aria-label="Presentation slide format"
          value={custom ? "Custom" : (preset?.name ?? "Custom")}
          onChange={(event) => {
            const next = presentationSizePresets.find(
              (item) => item.name === event.currentTarget.value,
            );
            setCustom(!next);
            setDraft(null);
            if (next) onRatioChange(next);
          }}
        >
          {presentationSizePresets.map((item) => (
            <option key={item.name} value={item.name}>
              {item.label}
            </option>
          ))}
          <option>Custom</option>
        </select>
      </label>
      {(custom || !preset) && (
        <fieldset
          ref={fields}
          className="element-wide slide-aspect-ratio"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Enter") commit();
              else cancel();
            }
          }}
        >
          <legend>Custom aspect ratio</legend>
          {(["width", "height"] as const).map((dimension) => (
            <label key={dimension}>
              {dimension === "width" ? "Width ratio" : "Height ratio"}
              <input
                key={`${dimension}-${size[dimension]}`}
                aria-label={`Presentation ${dimension} ratio`}
                type="number"
                min="0.01"
                step="any"
                defaultValue={size[dimension]}
                onChange={() => {
                  const inputs =
                    fields.current!.querySelectorAll<HTMLInputElement>("input");
                  setDraft({
                    width: inputs[0].valueAsNumber,
                    height: inputs[1].valueAsNumber,
                  });
                }}
              />
            </label>
          ))}
        </fieldset>
      )}
      <details className="element-wide">
        <summary title="Changes the layout area. Existing objects and guides keep their coordinates. Display quality adapts automatically.">
          Advanced canvas size
        </summary>
        <div className="slide-aspect-ratio">
          {(["width", "height"] as const).map((dimension) => (
            <label key={dimension}>
              {dimension === "width"
                ? "Width (layout units)"
                : "Height (layout units)"}
              <input
                key={`${dimension}-${size[dimension]}`}
                aria-label={`Presentation ${dimension}`}
                type="number"
                min="0.01"
                step="any"
                defaultValue={size[dimension]}
                onBlur={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value) && value > 0)
                    onCanvasChange({ [dimension]: value });
                  else event.currentTarget.value = String(size[dimension]);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" || event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                  if (event.key === "Escape") {
                    event.currentTarget.value = String(size[dimension]);
                    event.currentTarget.blur();
                  } else if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </label>
          ))}
        </div>
      </details>
    </>
  );
}
