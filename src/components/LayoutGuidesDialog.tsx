import { useMemo, useState } from "react";
import {
  deriveGuides,
  emptyGuideSetDraft,
  validateGuideSetGeometry,
  type GuideSetDraft,
} from "../core/guides";
import type { GuideSet } from "../core/guideModel";

const DEFAULT_MARGINS = { top: 90, right: 120, bottom: 90, left: 120 };
const DEFAULT_COLUMNS = { count: 2, gutter: 24 };
const DEFAULT_ROWS = { count: 2, gutter: 24 };

function numeric(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function LayoutGuidesDialog({
  guideSet,
  slideWidth,
  slideHeight,
  onApply,
  onDelete,
  onClose,
}: {
  guideSet: GuideSet | null;
  slideWidth: number;
  slideHeight: number;
  onApply: (draft: GuideSetDraft) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<GuideSetDraft>(() =>
      guideSet
        ? {
            name: guideSet.name,
            margins: guideSet.margins,
            columns: guideSet.columns,
            rows: guideSet.rows,
            manualGuides: guideSet.manualGuides,
          }
        : {
            ...emptyGuideSetDraft("Default Grid"),
            margins: DEFAULT_MARGINS,
            columns: DEFAULT_COLUMNS,
            rows: DEFAULT_ROWS,
          },
    ),
    error = validateGuideSetGeometry(draft, slideWidth, slideHeight),
    preview = useMemo(() => {
      if (error) return [];
      return deriveGuides(
        { ...draft, id: guideSet?.id ?? "preview" },
        slideWidth,
        slideHeight,
      );
    }, [draft, error, guideSet?.id, slideHeight, slideWidth]);

  const setMargin = (
    key: keyof NonNullable<GuideSetDraft["margins"]>,
    value: string,
  ) =>
    setDraft((current) => ({
      ...current,
      margins: {
        ...(current.margins ?? DEFAULT_MARGINS),
        [key]: numeric(value),
      },
    }));
  const setGrid = (
    key: "columns" | "rows",
    field: "count" | "gutter",
    value: string,
  ) =>
    setDraft((current) => {
      const fallback = key === "columns" ? DEFAULT_COLUMNS : DEFAULT_ROWS,
        base = current[key] ?? fallback,
        nextValue =
          field === "count"
            ? Math.max(1, Math.round(numeric(value)))
            : numeric(value);
      return { ...current, [key]: { ...base, [field]: nextValue } };
    });

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) =>
        event.target === event.currentTarget && onClose()
      }
    >
      <section
        className="layout-guides-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Layout guides"
      >
        <header>
          <div>
            <strong>Layout guides</strong>
            <span>These guides are shared by every slide</span>
          </div>
          <button aria-label="Close layout guides" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="layout-guides-body">
          <div className="layout-guide-fields">
            <label>
              <span>Name</span>
              <input
                aria-label="Guide set name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <fieldset>
              <legend>
                <label className="inline-check">
                  <input
                    aria-label="Enable margins"
                    type="checkbox"
                    checked={draft.margins !== null}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        margins: event.target.checked
                          ? (current.margins ?? DEFAULT_MARGINS)
                          : null,
                      }))
                    }
                  />
                  Margins
                </label>
              </legend>
              <div className="guide-field-grid four">
                {(["top", "right", "bottom", "left"] as const).map((key) => (
                  <label key={key}>
                    <span>{key}</span>
                    <input
                      aria-label={`Margin ${key}`}
                      type="number"
                      min="0"
                      disabled={!draft.margins}
                      value={draft.margins?.[key] ?? DEFAULT_MARGINS[key]}
                      onChange={(event) => setMargin(key, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            {(["columns", "rows"] as const).map((key) => {
              const fallback =
                key === "columns" ? DEFAULT_COLUMNS : DEFAULT_ROWS;
              return (
                <fieldset key={key}>
                  <legend>
                    <label className="inline-check">
                      <input
                        aria-label={`Enable ${key}`}
                        type="checkbox"
                        checked={draft[key] !== null}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            [key]: event.target.checked
                              ? (current[key] ?? fallback)
                              : null,
                          }))
                        }
                      />
                      {key === "columns" ? "Columns" : "Rows"}
                    </label>
                  </legend>
                  <div className="guide-field-grid">
                    <label>
                      <span>Count</span>
                      <input
                        aria-label={`${key === "columns" ? "Column" : "Row"} count`}
                        type="number"
                        min="1"
                        max="200"
                        disabled={!draft[key]}
                        value={draft[key]?.count ?? fallback.count}
                        onChange={(event) =>
                          setGrid(key, "count", event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Gutter</span>
                      <input
                        aria-label={`${key === "columns" ? "Column" : "Row"} gutter`}
                        type="number"
                        min="0"
                        disabled={!draft[key]}
                        value={draft[key]?.gutter ?? fallback.gutter}
                        onChange={(event) =>
                          setGrid(key, "gutter", event.target.value)
                        }
                      />
                    </label>
                  </div>
                </fieldset>
              );
            })}
          </div>
          <div className="guide-preview" aria-label="Guide preview">
            <div className="guide-preview-slide">
              {preview.map((guide, index) => (
                <i
                  key={`${guide.axis}-${guide.position}-${index}`}
                  className={guide.axis}
                  style={
                    guide.axis === "vertical"
                      ? { left: `${(guide.position / slideWidth) * 100}%` }
                      : { top: `${(guide.position / slideHeight) * 100}%` }
                  }
                />
              ))}
            </div>
            <span>
              {preview.length} derived guides · {draft.manualGuides.length}{" "}
              manual
            </span>
          </div>
        </div>
        {error && (
          <p className="guide-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          {onDelete && (
            <button className="danger" onClick={onDelete}>
              Delete Guides
            </button>
          )}
          <span />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!!error || !draft.name.trim()}
            onClick={() => onApply({ ...draft, name: draft.name.trim() })}
          >
            Apply
          </button>
        </footer>
      </section>
    </div>
  );
}
