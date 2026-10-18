import { useEffect, useState } from "react";
import { platform } from "../platform";
import { MaterialIcon } from "./MaterialIcon";

export function AgentHistoryControls({
  documentId,
  onError,
}: {
  documentId: string;
  onError(error: unknown): void;
}) {
  const [history, setHistory] = useState({
    documentId: null as string | null,
    canUndo: false,
    canRedo: false,
    summary: null as string | null,
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      void platform
        .agentHistory?.()
        .then((value) => {
          if (current) setHistory(value);
        })
        .catch(() => {});
    };
    const stop = platform.onAgentHistoryChanged?.(refresh);
    refresh();
    return () => {
      current = false;
      stop?.();
    };
  }, [documentId]);
  if (
    history.documentId !== documentId ||
    (!history.canUndo && !history.canRedo)
  )
    return null;
  const undo = async (redo: boolean) => {
    setBusy(true);
    try {
      const result = await platform.agentUndo!({ documentId, redo });
      if (!result.ok)
        throw new Error(
          result.error?.message ?? "Agent history is unavailable.",
        );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="toolbar-group"
      role="group"
      aria-label={history.summary ?? "Agent edits"}
    >
      <span title={history.summary ?? "Agent edits"}>Agent</span>
      <button
        type="button"
        className="tool-button tool-button-icon-only"
        aria-label="Undo agent edit"
        title="Undo agent edit"
        disabled={busy || !history.canUndo}
        onClick={() => {
          void undo(false);
        }}
      >
        <MaterialIcon name="undo" />
      </button>
      {history.canRedo && (
        <button
          type="button"
          className="tool-button tool-button-icon-only"
          aria-label="Redo agent edit"
          title="Redo agent edit"
          disabled={busy}
          onClick={() => {
            void undo(true);
          }}
        >
          <MaterialIcon name="redo" />
        </button>
      )}
    </div>
  );
}
