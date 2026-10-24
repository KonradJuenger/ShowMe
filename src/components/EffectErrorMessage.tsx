import { createContext, useState } from "react";

// Only authoring previews opt in; presentation surfaces retain their behavior.
export const EffectErrorCopyContext = createContext(false);

export function EffectErrorMessage({ message }: { message: string }) {
  const [result, setResult] = useState<{ message: string; status: string }>();
  async function copy() {
    try {
      if (window.desktop?.writeTextClipboard)
        await window.desktop.writeTextClipboard(message);
      else await navigator.clipboard.writeText(message);
      setResult({ message, status: "Error copied to clipboard" });
    } catch {
      setResult({ message, status: "Could not copy error to clipboard" });
    }
  }
  return (
    <>
      <button
        type="button"
        className="effect-error-copy"
        title="Click to copy error to clipboard"
        onClick={() => void copy()}
      >
        {message}
      </button>
      <span className="effect-error-copy-status" role="status">
        {result?.message === message ? result.status : ""}
      </span>
    </>
  );
}
