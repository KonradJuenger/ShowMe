import { useEffect, useState } from "react";
import { platform } from "../platform";

export function DisplacedPresentationNotice({
  documentId,
  settingsOpen,
  onMove,
  onSavePortable,
  onError,
}: {
  documentId: string;
  settingsOpen: boolean;
  onMove(): Promise<unknown>;
  onSavePortable(): Promise<unknown>;
  onError(error: unknown): void;
}) {
  const [displaced, setDisplaced] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settingsOpen) return;
    let live = true;
    void platform
      .documentLibraryState?.(documentId)
      .then((state) => live && setDisplaced(state.displaced))
      .catch(onError);
    return () => {
      live = false;
    };
  }, [documentId, onError, settingsOpen]);
  if (!displaced) return null;
  const act = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      setDisplaced(
        (await platform.documentLibraryState!(documentId)).displaced,
      );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      className="library-displaced-notice"
      aria-label="Presentation outside the ShowMe root"
    >
      <p>
        This .sme presentation uses assets from the ShowMe Library but is outside
        the ShowMe root. Move it into the root or save it as a self-contained
        .smp package.
      </p>
      <button disabled={busy} onClick={() => void act(onMove)}>
        Move into ShowMe Root
      </button>
      <button disabled={busy} onClick={() => void act(onSavePortable)}>
        Save as Portable .smp
      </button>
    </aside>
  );
}
