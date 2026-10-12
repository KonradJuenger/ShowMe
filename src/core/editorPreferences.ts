export type SelectionMode = "simple" | "directional" | "reverse-directional";

const selectionModeKey = "showme.selectionMode";

export function readSelectionMode(): SelectionMode {
  try {
    const value = localStorage.getItem(selectionModeKey);
    if (value === "directional" || value === "reverse-directional")
      return value;
  } catch {
    /* Use the default when browser storage is unavailable. */
  }
  return "simple";
}

export function saveSelectionMode(mode: SelectionMode): void {
  try {
    localStorage.setItem(selectionModeKey, mode);
  } catch {
    /* The setting still applies to the current editor session. */
  }
}
