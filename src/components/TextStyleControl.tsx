import { useState } from "react";
import "./TextStyleControl.css";
import { measureText } from "./editor/textLayout";
import type { EditorSnapshot } from "../core/editorCommands";
import type { Element } from "../core/element";
import { textStyleNameKey } from "../core/textTypography";
import {
  applyTextStyle,
  clearTextStyleOverrides,
  createTextStyleFromElement,
  setTextStyle,
  updateTextStyleFromElement,
} from "../core/textStyleCommands";

export function TextStyleControl({
  snapshot,
  elements,
  onChange,
  busy = false,
}: {
  snapshot: EditorSnapshot;
  elements: readonly Element[];
  onChange(change: (snapshot: EditorSnapshot) => EditorSnapshot): void;
  busy?: boolean;
}) {
  const [naming, setNaming] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const formats = elements.map((e) =>
    e.content?.type === "text" ? e.content.format : null,
  );
  const ids = elements.map((e) => e.id);
  const values = formats.map((f) => (f?.kind === "style" ? f.styleId : ""));
  const mixed = values.some((v) => v !== values[0]);
  const value = mixed ? "mixed" : (values[0] ?? "");
  const style = snapshot.deck.textStyles.find((s) => s.id === value);
  const nameConflict = snapshot.deck.textStyles.some(
    (s) =>
      (naming === "create" || s.id !== style?.id) &&
      textStyleNameKey(s.name) === textStyleNameKey(name),
  );
  const overrides = formats.some(
    (f) => f?.kind === "style" && Object.keys(f.overrides).length > 0,
  );
  return (
    <fieldset className="text-style-control" disabled={busy} aria-busy={busy}>
      <label className="text-style-picker">
        <span>Applied style</span>
        <select
          aria-label="Text Style"
          title={mixed ? "Mixed styles" : (style?.name ?? "None")}
          value={value}
          onChange={(e) => {
            const id = e.target.value || null;
            onChange((s) => applyTextStyle(s, ids, id, measureText));
          }}
        >
          {mixed && (
            <option value="mixed" disabled>
              Mixed
            </option>
          )}
          <option value="">None</option>
          {snapshot.deck.textStyles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {value === s.id && overrides ? "+" : ""}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label="Create Text Style from selection"
        disabled={elements.length !== 1}
        onClick={() => {
          setName("");
          setNaming("create");
        }}
      >
        Create style
      </button>
      <div
        className="text-style-actions"
        role="group"
        aria-label="Text Style actions"
      >
        <button
          type="button"
          title="Clear overrides and restore the applied style"
          disabled={!style || !overrides}
          onClick={() =>
            onChange((s) => clearTextStyleOverrides(s, ids, measureText))
          }
        >
          Reset style
        </button>
        <button
          type="button"
          disabled={!style || elements.length !== 1}
          onClick={() => onChange((s) => updateTextStyleFromElement(s, ids[0]))}
        >
          Update style
        </button>
        <button
          type="button"
          disabled={!style || !!style.defaultKind}
          onClick={() => {
            if (!style || style.defaultKind) return;
            setName(style.name);
            setNaming("rename");
          }}
        >
          Rename Style
        </button>
        <button
          type="button"
          disabled={!style || !!style.defaultKind}
          onClick={() => {
            if (!style || style.defaultKind) return;
            onChange((s) =>
              setTextStyle(s, { styleId: style.id, value: null }),
            );
          }}
        >
          Delete Style
        </button>
      </div>
      {naming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || nameConflict) return;
            const label = name.trim();
            if (naming === "create")
              onChange((s) => createTextStyleFromElement(s, ids[0], label));
            else if (style)
              onChange((s) => {
                const current = s.deck.textStyles.find(
                  (v) => v.id === style.id,
                );
                if (!current) throw new Error("Text Style was deleted");
                return setTextStyle(s, {
                  styleId: current.id,
                  value: { ...current, name: label },
                });
              });
            setNaming(null);
          }}
        >
          <input
            autoFocus
            aria-label="Text Style name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          {nameConflict && (
            <span role="alert">
              A Text Style with this name already exists.
            </span>
          )}
          <button type="submit" disabled={!name.trim() || nameConflict}>
            Save
          </button>
          <button type="button" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}
    </fieldset>
  );
}
