import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import {
  assignPresentationView,
  type PresentationDisplay,
  type PresentationDisplayAssignment,
  type PresentationView,
} from "../core/presentationDisplays";
import { MaterialIcon } from "./MaterialIcon";
import "./PresentationDisplaySetup.css";

const dragType = "application/x-showme-presentation-view";

export function PresentationDisplaySetup({
  displays,
  onAssign,
  disabled = false,
}: {
  displays: PresentationDisplay[];
  onAssign(assignment: PresentationDisplayAssignment | null): Promise<void>;
  disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const [dragging, setDragging] = useState<PresentationView | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const visible = open && !disabled;
  const presenterId = displays.find((display) => display.presenter)?.id;
  const audienceId = displays.find((display) => display.audience)?.id;
  const multiple = displays.length > 1;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!visible) return;
    popup.current?.focus();
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!popup.current?.contains(node) && !button.current?.contains(node))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", resize);
    };
  }, [visible]);

  async function assign(view: PresentationView, displayId: number) {
    if (
      !multiple ||
      saving ||
      disabled ||
      presenterId === undefined ||
      audienceId === undefined
    )
      return;
    setSaving(true);
    try {
      await onAssign(
        assignPresentationView(
          { presenterDisplayId: presenterId, audienceDisplayId: audienceId },
          view,
          displayId,
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  const left = Math.min(...displays.map((display) => display.bounds.x));
  const upper = Math.min(...displays.map((display) => display.bounds.y));
  const width =
    Math.max(
      ...displays.map((display) => display.bounds.x + display.bounds.width),
    ) - left;
  const height =
    Math.max(
      ...displays.map((display) => display.bounds.y + display.bounds.height),
    ) - upper;

  function drop(event: DragEvent, id: number) {
    event.preventDefault();
    const view = event.dataTransfer.getData(dragType);
    if (view === "audience" || view === "presenter") void assign(view, id);
    setDragging(null);
    setTarget(null);
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="tool-button tool-button-icon-only presentation-setup-button"
        aria-label="Presentation screen setup"
        aria-haspopup="dialog"
        aria-expanded={visible}
        disabled={disabled}
        title={
          disabled
            ? "End the presentation to change screen setup"
            : "Presentation screen setup"
        }
        onClick={() => {
          setTop((button.current?.getBoundingClientRect().bottom ?? 48) + 8);
          setOpen((value) => !value);
        }}
      >
        <MaterialIcon name="monitor-edit" />
      </button>
      {visible &&
        createPortal(
          <div
            ref={popup}
            className="presentation-display-setup"
            role="dialog"
            aria-labelledby="presentation-display-title"
            aria-describedby="presentation-display-help"
            tabIndex={-1}
            style={{ top }}
          >
            <div className="presentation-display-heading">
              <strong id="presentation-display-title">
                Presentation screens
              </strong>
              <button
                type="button"
                aria-label="Close screen setup"
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                }}
              >
                ×
              </button>
            </div>
            <p id="presentation-display-help">
              {multiple
                ? "Drag each view to a screen. Dropping on the other view swaps them. Screens stay fixed while presenting."
                : displays.length === 1
                  ? "One screen connected. Audience opens fullscreen on this screen."
                  : "Screen assignment is available in the desktop app."}
            </p>
            {displays.length > 0 && (
              <div className="presentation-display-map-scroll">
                <div
                  className="presentation-display-map"
                  aria-label="Attached screens"
                  style={{
                    aspectRatio: `${width} / ${height}`,
                    minWidth:
                      width *
                      Math.max(
                        130 /
                          Math.min(
                            ...displays.map((display) => display.bounds.width),
                          ),
                        70 /
                          Math.min(
                            ...displays.map((display) => display.bounds.height),
                          ),
                      ),
                  }}
                >
                  {displays.map((display, index) => (
                    <div
                      key={display.id}
                      className="presentation-display-screen"
                      data-drop-target={
                        target === display.id ? "true" : undefined
                      }
                      aria-label={`Screen ${index + 1}: ${display.label}`}
                      style={{
                        left: `${((display.bounds.x - left) / width) * 100}%`,
                        top: `${((display.bounds.y - upper) / height) * 100}%`,
                        width: `${(display.bounds.width / width) * 100}%`,
                        height: `${(display.bounds.height / height) * 100}%`,
                      }}
                      onDragOver={(event) => {
                        if (!dragging || saving || !multiple) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setTarget(display.id);
                      }}
                      onDragLeave={() => setTarget(null)}
                      onDrop={(event) => drop(event, display.id)}
                    >
                      <span className="presentation-display-number">
                        {index + 1}
                        {display.primary ? " · Main" : ""}
                      </span>
                      <span
                        className="presentation-display-name"
                        title={display.label}
                      >
                        {display.label}
                      </span>
                      <div className="presentation-display-views">
                        {(["presenter", "audience"] as const).map(
                          (view) =>
                            display[view] && (
                              <span
                                key={view}
                                className="presentation-display-view"
                                data-view={view}
                                draggable={multiple && !saving}
                                onDragStart={(event) => {
                                  event.dataTransfer.setData(dragType, view);
                                  event.dataTransfer.effectAllowed = "move";
                                  setDragging(view);
                                }}
                                onDragEnd={() => {
                                  setDragging(null);
                                  setTarget(null);
                                }}
                              >
                                {view === "presenter"
                                  ? "Presenter"
                                  : "Audience"}
                              </span>
                            ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {multiple && (
              <>
                <div className="presentation-display-selects">
                  {(["presenter", "audience"] as const).map((view) => (
                    <label key={view}>
                      {view === "presenter"
                        ? "Presenter view"
                        : "Audience view"}
                      <select
                        value={view === "presenter" ? presenterId : audienceId}
                        disabled={saving}
                        onChange={(event) =>
                          void assign(view, Number(event.target.value))
                        }
                      >
                        {displays.map((display, index) => (
                          <option key={display.id} value={display.id}>
                            {index + 1} · {display.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await onAssign(null);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Reset to default screens
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
