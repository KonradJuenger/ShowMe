import {
  textStyleSchema,
  textStyleNameKey,
  normalizeTextOverrides,
  resolveTextTypography,
  type TextStyle,
  type TextFormat,
} from "./textTypography";
import type {
  Deck,
  PresentationDocument,
  Slide,
  TemplatePage,
} from "./document";
import {
  contentSchema,
  frameSchema,
  walkElements,
  type Element,
} from "./element";
import { uid } from "./ids";

export function collectReferencedTextStyles(
  deck: Deck,
  roots: readonly Element[],
) {
  const ids = new Set(
    walkElements([...roots]).flatMap((e) =>
      e.content?.type === "text" && e.content.format.kind === "style"
        ? [e.content.format.styleId]
        : [],
    ),
  );
  const styles = deck.textStyles.filter((s) => ids.has(s.id));
  if (styles.length !== ids.size)
    throw new Error("Dangling Text Style reference");
  return structuredClone(styles);
}
export function importTextStyles(
  deck: Deck,
  styles: readonly TextStyle[],
  newId: () => string = uid,
  sameDocument = false,
) {
  const textStyles = [...deck.textStyles];
  const remap = new Map<string, string>();
  const used = new Set<string>();
  for (const raw of styles) {
    const source = textStyleSchema.parse(raw);
    if (remap.has(source.id)) continue;
    // IDs only establish identity inside the same presentation.
    let target = sameDocument
      ? textStyles.find((s) => s.id === source.id)
      : undefined;
    let name = source.name;
    for (let suffix = 1; !target; suffix++) {
      const tail = suffix === 1 ? "" : ` ${suffix}`;
      name = source.name.slice(0, 200 - tail.length).trimEnd() + tail;
      const existing = textStyles.find(
        (s) => textStyleNameKey(s.name) === textStyleNameKey(name),
      );
      if (!existing) break;
      // Suffixes are imported custom definitions; default ownership stays local.
      const metadataMatches =
        suffix === 1
          ? existing.defaultKind === source.defaultKind
          : existing.defaultKind === undefined;
      if (
        !used.has(existing.id) &&
        metadataMatches &&
        JSON.stringify(existing.typography) ===
          JSON.stringify(source.typography)
      )
        target = existing;
    }
    if (target) remap.set(source.id, target.id);
    else {
      const imported: TextStyle = {
        id: newId(),
        name,
        typography: source.typography,
      };
      if (textStyles.some((s) => s.id === imported.id))
        throw new Error("Duplicate imported Text Style ID");
      textStyles.push(imported);
      remap.set(source.id, imported.id);
    }
    used.add(remap.get(source.id)!);
  }
  return { textStyles, remap };
}
export function remapTextStyles(roots: Element[], remap: Map<string, string>) {
  for (const e of walkElements(roots))
    if (e.content?.type === "text" && e.content.format.kind === "style") {
      const id = remap.get(e.content.format.styleId);
      if (!id) throw new Error("Missing imported Text Style");
      e.content.format = { ...e.content.format, styleId: id };
    }
}

export function validateTextStyleReferences(
  styles: readonly TextStyle[],
  roots: Element[],
) {
  const ids = new Set(styles.map((s) => s.id));
  if (ids.size !== styles.length) throw new Error("Duplicate Text Style IDs");
  if (
    new Set(styles.map((s) => textStyleNameKey(s.name))).size !== styles.length
  )
    throw new Error("Duplicate Text Style names");
  for (const e of walkElements(roots))
    if (
      e.content?.type === "text" &&
      e.content.format.kind === "style" &&
      !ids.has(e.content.format.styleId)
    )
      throw new Error("Dangling Text Style reference");
}

export type TextStyleEdit = {
  styleId: string;
  value: TextStyle | null;
  expectedValue?: TextStyle | null;
  restoreFormats?: Record<string, Record<string, TextFormat>>;
  layouts?: Record<
    string,
    Record<
      string,
      {
        expectedContent: NonNullable<Element["content"]>;
        expectedFrame: Element["frame"];
        frame: Element["frame"];
      }
    >
  >;
};
/** Style edits touch content only for detach/normalization, never for propagation. */
export function editTextStyleDeck(deck: Deck, edit: TextStyleEdit): Deck {
  if (edit.value) {
    const value = textStyleSchema.parse(edit.value);
    edit = { ...edit, value };
    if (
      deck.textStyles.some(
        (s) =>
          s.id !== edit.styleId &&
          textStyleNameKey(s.name) === textStyleNameKey(value.name),
      )
    )
      throw new Error(`A Text Style named "${value.name}" already exists`);
  }
  const previous = deck.textStyles.find((s) => s.id === edit.styleId);
  if (
    edit.expectedValue !== undefined &&
    JSON.stringify(previous ? textStyleSchema.parse(previous) : null) !==
      JSON.stringify(
        edit.expectedValue ? textStyleSchema.parse(edit.expectedValue) : null,
      )
  )
    throw new Error("Text Style changed while preparing the edit");
  if (!previous && !edit.value) throw new Error("Unknown Text Style");
  if (edit.value && edit.value.id !== edit.styleId)
    throw new Error("Text Style ID mismatch");
  if (
    previous?.defaultKind &&
    (!edit.value ||
      edit.value.defaultKind !== previous.defaultKind ||
      edit.value.name !== previous.name)
  )
    throw new Error("Default Text Styles must remain present");
  if (!previous && edit.value?.defaultKind)
    throw new Error("Cannot create another default Text Style");
  return {
    ...deck,
    textStyles: previous
      ? deck.textStyles.flatMap((s) =>
          s.id === edit.styleId ? (edit.value ? [edit.value] : []) : [s],
        )
      : [...deck.textStyles, edit.value!],
  };
}
export function editTextStylePage<T extends Slide | TemplatePage>(
  page: T,
  deck: Deck,
  edit: TextStyleEdit,
): T {
  const next = structuredClone(page);
  for (const e of walkElements(next.nodes.flatMap((r) => r.children))) {
    if (e.content?.type !== "text") continue;
    const layout = edit.layouts?.[page.id]?.[e.id];
    if (layout) {
      if (
        e.content.autoSize === "none" ||
        (!edit.restoreFormats?.[page.id]?.[e.id] &&
          (e.content.format.kind !== "style" ||
            e.content.format.styleId !== edit.styleId))
      )
        throw new Error("Style layout must target affected auto-sized text");
      if (
        JSON.stringify(contentSchema.parse(e.content)) !==
          JSON.stringify(contentSchema.parse(layout.expectedContent)) ||
        JSON.stringify(frameSchema.parse(e.frame)) !==
          JSON.stringify(frameSchema.parse(layout.expectedFrame))
      )
        throw new Error("Text layout changed while preparing the style edit");
      e.frame = layout.frame;
    }
    const restored = edit.restoreFormats?.[page.id]?.[e.id];
    if (restored) {
      e.content.format = restored;
      continue;
    }
    const format = e.content.format;
    if (format.kind !== "style" || format.styleId !== edit.styleId) continue;
    e.content.format = edit.value
      ? {
          ...format,
          overrides: normalizeTextOverrides(
            edit.value.typography,
            format.overrides,
          ),
        }
      : { kind: "local", typography: resolveTextTypography(deck, e.content) };
  }
  return next;
}
export function validateTextStyleLayouts(
  document: PresentationDocument,
  edit: TextStyleEdit,
) {
  const nextDeck = editTextStyleDeck(document.deck, edit);
  for (const page of [
    ...Object.values(document.slides),
    ...Object.values(document.templates),
  ]) {
    const after = editTextStylePage(page, document.deck, edit);
    const byId = new Map(
      walkElements(after.nodes.flatMap((r) => r.children)).map((e) => [
        e.id,
        e,
      ]),
    );
    for (const e of walkElements(page.nodes.flatMap((r) => r.children))) {
      if (e.content?.type !== "text" || e.content.autoSize === "none") continue;
      const changed = byId.get(e.id)!;
      if (changed.content?.type !== "text") continue;
      if (
        JSON.stringify(resolveTextTypography(document.deck, e.content)) !==
          JSON.stringify(resolveTextTypography(nextDeck, changed.content)) &&
        !edit.layouts?.[page.id]?.[e.id]
      )
        throw new Error(
          "Shared Text Style update requires measured auto-size layout",
        );
    }
    for (const id of Object.keys(edit.layouts?.[page.id] ?? {}))
      if (!byId.has(id)) throw new Error("Unknown text layout Element");
  }
  for (const id of Object.keys(edit.layouts ?? {}))
    if (!document.slides[id] && !document.templates[id])
      throw new Error("Unknown text layout page");
}
export function textStyleInverse(
  document: PresentationDocument,
  edit: TextStyleEdit,
): TextStyleEdit {
  const restoreFormats: NonNullable<TextStyleEdit["restoreFormats"]> = {};
  const layouts: NonNullable<TextStyleEdit["layouts"]> = {};
  for (const page of [
    ...Object.values(document.slides),
    ...Object.values(document.templates),
  ]) {
    const after = edit.layouts?.[page.id]
      ? editTextStylePage(page, document.deck, edit)
      : null;
    const byId = new Map(
      after
        ? walkElements(after.nodes.flatMap((r) => r.children)).map((e) => [
            e.id,
            e,
          ])
        : [],
    );
    for (const e of walkElements(page.nodes.flatMap((r) => r.children))) {
      if (e.content?.type !== "text") continue;
      if (
        edit.restoreFormats?.[page.id]?.[e.id] ||
        (e.content.format.kind === "style" &&
          e.content.format.styleId === edit.styleId)
      )
        (restoreFormats[page.id] ??= {})[e.id] = e.content.format;
      if (edit.layouts?.[page.id]?.[e.id]) {
        const changed = byId.get(e.id)!;
        (layouts[page.id] ??= {})[e.id] = {
          expectedContent: changed.content!,
          expectedFrame: changed.frame,
          frame: e.frame,
        };
      }
    }
  }
  return {
    styleId: edit.styleId,
    value: document.deck.textStyles.find((s) => s.id === edit.styleId) ?? null,
    expectedValue: edit.value,
    restoreFormats,
    layouts,
  };
}
