import {
  type ReactNode,
  type ChangeEvent,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { Collaboration } from "../Collaboration";
import { MaterialIcon } from "../MaterialIcon";
import { PresentationMenu } from "../PresentationMenu";
import { platform } from "../../platform";
import { McpSettings } from "../McpSettings";
import { AgentHistoryControls } from "../AgentHistoryControls";

type PresentationMenuProps = Parameters<typeof PresentationMenu>[0];

interface EditorToolbarProps {
  onNewPresentation?: PresentationMenuProps["onNewPresentation"];
  onPresentationOpened?: PresentationMenuProps["onPresentationOpened"];
  deckId: string;
  deckName: string;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  flushTransactions: PresentationMenuProps["flushTransactions"];
  onError: (error: unknown) => void;
  presentationSetup: ReactNode;
  navOpen: boolean;
  onToggleNav: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onInsert: (type: "text" | "frame") => void;
  mediaButton: RefObject<HTMLButtonElement | null>;
  mediaOpen: boolean;
  frameEditing: boolean;
  onToggleMedia: () => void;
  fileInput: RefObject<HTMLInputElement | null>;
  replaceInput: RefObject<HTMLInputElement | null>;
  onImportFiles: (files: File[]) => void;
  onReplaceMedia: (files: File[]) => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  busy: boolean;
  onPresent: () => void | Promise<void>;
  onSave?: PresentationMenuProps["onSave"];
  onSaveAs?: PresentationMenuProps["onSaveAs"];
  editingEnabled?: boolean;
  collaborationEnabled?: boolean;
  onCollaborationEnabledChange?(enabled: boolean): void;
  inspectorEnabled?: boolean;
  presentEnabled?: boolean;
}

export function EditorToolbar({
  deckId,
  deckName,
  settingsOpen,
  setSettingsOpen,
  flushTransactions,
  onError,
  presentationSetup,
  navOpen,
  onToggleNav,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onInsert,
  mediaButton,
  mediaOpen,
  frameEditing,
  onToggleMedia,
  fileInput,
  replaceInput,
  onImportFiles,
  onReplaceMedia,
  inspectorOpen,
  onToggleInspector,
  busy,
  onPresent,
  onSave,
  onSaveAs,
  onNewPresentation,
  onPresentationOpened,
  editingEnabled = true,
  collaborationEnabled = false,
  onCollaborationEnabledChange,
  inspectorEnabled = true,
  presentEnabled = true,
}: EditorToolbarProps) {
  const importChanged = (event: ChangeEvent<HTMLInputElement>) => {
    onImportFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const replaceChanged = (event: ChangeEvent<HTMLInputElement>) => {
    onReplaceMedia(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  return (
    <header
      className="toolbar"
      aria-label="Editor toolbar"
      onKeyDown={(event) => {
        if (
          (event.key === " " || event.key === "Enter") &&
          (event.target as HTMLElement).closest("button")
        )
          event.stopPropagation();
      }}
    >
      <div className="toolbar-region toolbar-left">
        <div className="toolbar-group document-controls">
          <PresentationMenu
            onNewPresentation={onNewPresentation}
            onPresentationOpened={onPresentationOpened}
            settingsOpen={settingsOpen}
            setSettingsOpen={setSettingsOpen}
            applicationSettings={
              <>
                <McpSettings />
                {platform.collaborationStatus &&
                  onCollaborationEnabledChange && (
                    <section className="settings-section">
                      <h3>Collaboration · Experimental</h3>
                      <label>
                        <input
                          type="checkbox"
                          checked={collaborationEnabled}
                          onChange={(event) =>
                            onCollaborationEnabledChange(
                              event.currentTarget.checked,
                            )
                          }
                        />
                        Enable Collaboration
                      </label>
                      <p>
                        Trusted LAN only. Traffic is not encrypted. Do not use
                        on untrusted or shared networks where confidentiality
                        matters.
                      </p>
                    </section>
                  )}
              </>
            }
            deckId={deckId}
            flushTransactions={flushTransactions}
            onError={onError}
            onSave={onSave}
            onSaveAs={onSaveAs}
          />

          <div className="toolbar-group history-controls">
            <button
              className="tool-button tool-button-icon-only"
              aria-label="Undo"
              title="Undo"
              disabled={!canUndo}
              onClick={onUndo}
            >
              <MaterialIcon name="undo" />
            </button>
            <button
              className="tool-button tool-button-icon-only"
              aria-label="Redo"
              title="Redo"
              disabled={!canRedo}
              onClick={onRedo}
            >
              <MaterialIcon name="redo" />
            </button>
          </div>
          <button
            className={`tool-button tool-button-icon-only ${navOpen ? "active" : ""}`}
            aria-label="Slides panel"
            aria-pressed={navOpen}
            title="Toggle slides"
            onClick={onToggleNav}
          >
            <MaterialIcon name="dock-left" />
          </button>
          <AgentHistoryControls documentId={deckId} onError={onError} />
          <div className="deck-title-container">
            <div
              aria-label="Presentation filename"
              className="deck-name"
              title="Presentation filename"
            >
              {deckName}
            </div>
          </div>
        </div>
      </div>

      <div className="toolbar-region toolbar-center">
        <div
          className="toolbar-pill-group insert-controls"
          role="group"
          aria-label="Insert elements"
        >
          <button
            className="tool-button"
            aria-label="Text"
            title="Add text"
            disabled={!editingEnabled}
            onClick={() => onInsert("text")}
          >
            <MaterialIcon name="format-text" />
            <span>Text</span>
          </button>
          <button
            className={`tool-button ${frameEditing ? "active" : ""}`}
            aria-label="Frame"
            title="Add empty frame"
            disabled={!editingEnabled}
            onClick={() => onInsert("frame")}
          >
            <MaterialIcon name="crop-free" />
            <span>Frame</span>
          </button>
          <button
            ref={mediaButton}
            className={`tool-button ${mediaOpen ? "active" : ""}`}
            aria-label="Media"
            aria-expanded={mediaOpen}
            aria-controls={mediaOpen ? "media-browser-popover" : undefined}
            title="Media"
            disabled={!editingEnabled}
            onClick={onToggleMedia}
          >
            <MaterialIcon name="image-outline" />
            <span>Media</span>
          </button>
        </div>

        <input
          ref={fileInput}
          data-testid="import-files"
          type="file"
          accept="image/*,video/mp4,video/webm,.svg"
          multiple
          disabled={!editingEnabled}
          hidden
          onChange={importChanged}
        />
        <input
          ref={replaceInput}
          data-testid="replace-file"
          type="file"
          accept="image/*,video/mp4,video/webm,.svg"
          disabled={!editingEnabled}
          hidden
          onChange={replaceChanged}
        />
      </div>

      <div className="toolbar-region toolbar-right">
        {collaborationEnabled && <Collaboration documentId={deckId} />}

        <button
          className={`tool-button tool-button-icon-only ${inspectorOpen ? "active" : ""}`}
          aria-label="Inspector"
          aria-pressed={inspectorOpen}
          title="Toggle inspector"
          disabled={!inspectorEnabled}
          onClick={onToggleInspector}
        >
          <MaterialIcon name="dock-right" />
        </button>

        {presentationSetup}
        <button
          className="present-button"
          disabled={busy || !presentEnabled}
          aria-label="Present"
          onClick={() => void onPresent()}
        >
          <MaterialIcon name="presentation-play" />
          <span>Present</span>
        </button>
      </div>
    </header>
  );
}
