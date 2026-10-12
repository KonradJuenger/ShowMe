import { useEffect, useRef, useState } from "react";

export function NewPresentationDialog({
  onCreate,
  onClose,
}: {
  onCreate(name: string): Promise<void>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("Untitled");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="new-presentation-dialog"
      aria-labelledby="new-presentation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="new-presentation-title">New presentation</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void onCreate(name.trim())
            .then(onClose)
            .catch((cause) => setError(String(cause)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Presentation name
          <input
            aria-label="New presentation name"
            value={name}
            maxLength={200}
            required
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            Create presentation
          </button>
        </div>
      </form>
    </dialog>
  );
}
