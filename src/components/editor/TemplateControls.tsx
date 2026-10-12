import { useState, type ReactNode } from "react";
import type { EditorSnapshot } from "../../core/editorCommands";
import {
  applyTemplate,
  createTemplate,
  deleteTemplate,
  deleteTemplateElements,
  makeIndependent,
} from "../../core/templateCommands";
import { MaterialIcon } from "../MaterialIcon";
import { COMMAND_IDS } from "../../core/commandRegistry";
import { showContextMenu } from "../../platform/contextMenu";
import { uid } from "../../core/ids";

export function TemplateRail({
  snapshot,
  busy,
  thumbnail,
  apply,
  activate,
  onError,
}: {
  snapshot: EditorSnapshot;
  busy: boolean;
  thumbnail(id: string): ReactNode;
  apply(change: (current: EditorSnapshot) => EditorSnapshot): Promise<void>;
  activate(id: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<string | null>(null);
  const { deck, slide } = snapshot;
  const remove = async (id: string, discard: boolean) => {
    if (slide.id === id) await activate(deck.slideIds[0]);
    await apply((current) =>
      discard
        ? deleteTemplateElements(current, id)
        : deleteTemplate(current, id),
    );
    setPendingDeletion(null);
  };
  const openMenu = async (id: string, x: number, y: number) => {
    const command = await showContextMenu({
      x,
      y,
      items: [
        {
          type: "command",
          commandId: COMMAND_IDS.slideDelete,
          label: "Delete template",
          enabled: !busy && id !== deck.defaultTemplateId,
        },
      ],
    });
    if (!command) return;
    const used = Object.values(deck.slideMeta).some(
      (meta) => meta.templateId === id,
    );
    const hasElements = snapshot.templates?.[id]?.nodes.some(
      (root) => root.children.length,
    );
    if (used && hasElements) setPendingDeletion(id);
    else await remove(id, used);
  };
  return (
    <div className="template-rail">
      <button
        className="panel-heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="template-heading-disclosure">{expanded ? "▾" : "▸"} </span>
        <span className="navigator-heading-text">Templates</span>
      </button>
      {expanded && (
        <div className="template-rail-pages">
          {deck.templateIds.map((id) => {
            const label = deck.templateMeta[id].label;
            return (
              <div key={id} className="slide-nav-row">
                <span className="slide-disclosure placeholder" aria-hidden="true" />
                <button
                  type="button"
                  className={`slide-thumb ${slide.id === id ? "active" : ""}`}
                  aria-label={`Edit Template ${label}`}
                  disabled={busy}
                  onClick={() => void activate(id).catch(onError)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void openMenu(id, event.clientX, event.clientY).catch(
                      onError,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "ContextMenu" ||
                      (event.shiftKey && event.key === "F10")
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      void openMenu(id, rect.left + 12, rect.top + 12).catch(
                        onError,
                      );
                    }
                  }}
                >
                  {thumbnail(id)}
                  <strong className="slide-index template-index">{label}</strong>
                </button>
              </div>
            );
          })}
          <div className="slide-rail-add-row">
            <button
              type="button"
              className="slide-rail-add-button"
              title="Add template"
              aria-label="Add template"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  const id = uid();
                  await apply((current) => createTemplate(current, id));
                  await activate(id);
                })().catch(onError)
              }
            >
              <MaterialIcon name="plus" />
            </button>
          </div>
        </div>
      )}
      {pendingDeletion && deck.templateMeta[pendingDeletion] && (
        <div
          className="modal-backdrop"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") setPendingDeletion(null);
          }}
        >
          <section
            className="layout-guides-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-template-title"
          >
            <header>
              <h2 id="delete-template-title">
                Delete Template {deck.templateMeta[pendingDeletion].label}?
              </h2>
            </header>
            <p>
              {
                Object.values(deck.slideMeta).filter(
                  (meta) => meta.templateId === pendingDeletion,
                ).length
              }{" "}
              slides use elements from this template. Choose what happens to
              those elements.
            </p>
            <footer>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  void remove(pendingDeletion, true).catch(onError)
                }
              >
                Delete template elements
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setPendingDeletion(null)}
              >
                Cancel
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

export function TemplatePageControls({
  snapshot,
  busy,
  apply,
  activate,
  onError,
}: {
  snapshot: EditorSnapshot;
  busy: boolean;
  apply(change: (current: EditorSnapshot) => EditorSnapshot): Promise<void>;
  activate(id: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const { deck, slide } = snapshot;
  if (deck.templateIds.includes(slide.id))
    return (
      <div className="template-page-controls">
        Editing Template {deck.templateMeta[slide.id].label}
      </div>
    );
  const templateId = deck.slideMeta[slide.id].templateId;
  return (
    <div className="template-page-controls">
      <div className="element-property">
        <span>Template</span>
        <div className="template-selector-actions">
          <select
            aria-label="Slide template"
            value={templateId ?? ""}
            disabled={busy}
            onChange={(event) => {
              const id = event.currentTarget.value;
              void apply((current) =>
                id ? applyTemplate(current, id) : makeIndependent(current),
              ).catch(onError);
            }}
          >
            {deck.templateIds.map((id) => (
              <option key={id} value={id}>
                {deck.templateMeta[id].label}
              </option>
            ))}
            <option value="">Independent</option>
          </select>
          {templateId && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Edit Template ${deck.templateMeta[templateId].label}`}
              title={`Edit Template ${deck.templateMeta[templateId].label}`}
              onClick={() => void activate(templateId).catch(onError)}
            >
              Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
