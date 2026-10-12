import { setTextStyle } from "./textStyleCommands";
import { textStyleSchema } from "./textTypography";
import {
  collectReferencedTextStyles,
  importTextStyles,
  remapTextStyles,
  validateTextStyleReferences,
} from "./textStyles";
import { cloneMotion, filterMotion, translateAbsoluteMotion } from "./motion";
import { slideMotionSchema, validateMotionTargets } from "./motionModel";
import { walkElements } from "./element";
import {
  combineMotion,
  setSlideMotion,
  setSlideEffects,
} from "./editorCommands";
import {
  effectResourcesSchema,
  importEffectResources,
  validateEffects,
} from "./effects";
import { z } from "zod";
import { idSchema } from "./ids";
import {
  multiply,
  elementSchema,
  validateElementForest,
  type Matrix,
} from "./element";
import { insertElements, type EditorSnapshot } from "./editorCommands";
import {
  cloneSubtree,
  frameFromWorldMatrix,
  getChildren,
  getWorldMatrix,
  resolveEditableScope,
} from "./scene";
export const ELEMENTS_CLIPBOARD_VERSION = 1 as const;

export interface ClipboardSelection {
  elementIds: readonly string[];
  scopeId: string | null;
}

export const ELEMENTS_CLIPBOARD_PREFIX = `show-me-elements:v${ELEMENTS_CLIPBOARD_VERSION}:`;

const finite = z.number().finite();
const matrixSchema = z.tuple([finite, finite, finite, finite, finite, finite]);
const currentClipboardPayloadSchema = z
  .object({
    version: z.literal(ELEMENTS_CLIPBOARD_VERSION),
    documentId: idSchema,
    textStyles: z.array(textStyleSchema).max(10000),
    effectResources: effectResourcesSchema.optional(),
    motion: slideMotionSchema.optional(),
    roots: z
      .array(
        z
          .object({
            element: elementSchema,
            world: matrixSchema,
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();

const clipboardPayloadSchema = currentClipboardPayloadSchema.superRefine(
  (payload, context) => {
    try {
      validateTextStyleReferences(
        payload.textStyles,
        payload.roots.map((r) => r.element),
      );
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });
    }
  },
);

export type ElementsClipboardPayload = z.infer<typeof clipboardPayloadSchema>;

let memoryClipboard: string | null = null;
let clipboardWrite: Promise<void> = Promise.resolve();

function clonePayload(
  payload: ElementsClipboardPayload,
): ElementsClipboardPayload {
  return structuredClone(payload);
}

export function parseElementsClipboardText(
  text: string,
): ElementsClipboardPayload | null {
  const prefix = text.startsWith(ELEMENTS_CLIPBOARD_PREFIX)
    ? ELEMENTS_CLIPBOARD_PREFIX
    : null;
  if (!prefix) return null;
  try {
    const value = JSON.parse(text.slice(prefix.length));
    const parsed = clipboardPayloadSchema.parse(value);
    validateElementForest(parsed.roots.map(({ element }) => element));
    validateEffects(
      walkElements(parsed.roots.map((r) => r.element)),
      parsed.effectResources,
    );
    if (parsed.motion)
      validateMotionTargets(
        parsed.motion,
        walkElements(parsed.roots.map((r) => r.element)),
        parsed.effectResources,
      );
    return clonePayload(parsed);
  } catch {
    return null;
  }
}

export function serializeElementsClipboard(payload: ElementsClipboardPayload) {
  const parsed = clipboardPayloadSchema.parse(payload);
  validateElementForest(parsed.roots.map(({ element }) => element));
  validateEffects(
    walkElements(parsed.roots.map((r) => r.element)),
    parsed.effectResources,
  );
  if (parsed.motion)
    validateMotionTargets(
      parsed.motion,
      walkElements(parsed.roots.map((r) => r.element)),
      parsed.effectResources,
    );
  return ELEMENTS_CLIPBOARD_PREFIX + JSON.stringify(parsed);
}

export function captureElementsClipboard(
  snapshot: EditorSnapshot,
  selection: ClipboardSelection,
): ElementsClipboardPayload | null {
  if (!selection.scopeId || !selection.elementIds.length) return null;
  const children = getChildren(snapshot.slide, selection.scopeId);
  if (!children) return null;
  const selectedIds = new Set(selection.elementIds);
  const roots = children.filter(({ id }) => selectedIds.has(id));
  if (roots.length !== selectedIds.size) return null;
  return {
    version: ELEMENTS_CLIPBOARD_VERSION,
    documentId: snapshot.deck.id,
    textStyles: collectReferencedTextStyles(snapshot.deck, roots),
    effectResources: Object.fromEntries(
      walkElements(roots)
        .flatMap((e) => e.effects ?? [])
        .map((e) => [
          e.resourceId,
          snapshot.slide.effectResources![e.resourceId],
        ]),
    ),
    ...(snapshot.slide.motion
      ? {
          motion: filterMotion(
            snapshot.slide.motion,
            new Set(walkElements(roots).map((e) => e.id)),
          ),
        }
      : {}),
    roots: roots.map((element) => ({
      element: structuredClone(element),
      world: [...getWorldMatrix(snapshot.slide, element.id)] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
    })),
  };
}

export async function writeElementsClipboard(
  payload: ElementsClipboardPayload,
) {
  const text = serializeElementsClipboard(payload);
  memoryClipboard = text;
  clipboardWrite = clipboardWrite.then(async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard)
        await navigator.clipboard.writeText(text);
    } catch {
      // The deterministic in-memory payload is the production fallback.
    }
  });
  await clipboardWrite;
}

export async function readElementsClipboard() {
  await clipboardWrite;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      const text = await navigator.clipboard.readText();
      return parseElementsClipboardText(text);
    }
  } catch {
    // Fall through to the in-memory payload only when system access fails.
  }
  return memoryClipboard ? parseElementsClipboardText(memoryClipboard) : null;
}

export async function hasElementsClipboard() {
  return !!(await readElementsClipboard());
}

export function setElementsMemoryClipboard(
  payload: ElementsClipboardPayload | null,
) {
  memoryClipboard = payload ? serializeElementsClipboard(payload) : null;
}

export function pasteElements(
  snapshot: EditorSnapshot,
  requestedScopeId: string | null,
  payload: ElementsClipboardPayload,
  newId: () => string,
  offset: { x: number; y: number } = { x: 20, y: 20 },
) {
  const parsed = clipboardPayloadSchema.parse(structuredClone(payload));
  validateElementForest(parsed.roots.map(({ element }) => element));
  validateEffects(
    walkElements(parsed.roots.map((r) => r.element)),
    parsed.effectResources,
  );
  if (parsed.motion)
    validateMotionTargets(
      parsed.motion,
      walkElements(parsed.roots.map((r) => r.element)),
      parsed.effectResources,
    );
  const imported = importEffectResources(
    snapshot.slide.effectResources,
    parsed.effectResources,
  );
  const importedStyles = importTextStyles(
    snapshot.deck,
    parsed.textStyles,
    newId,
    parsed.documentId === snapshot.deck.id,
  );
  remapTextStyles(
    parsed.roots.map((r) => r.element),
    importedStyles.remap,
  );
  for (const style of importedStyles.textStyles)
    if (!snapshot.deck.textStyles.some((s) => s.id === style.id))
      snapshot = setTextStyle(snapshot, { styleId: style.id, value: style });
  const scopeId = resolveEditableScope(
    snapshot.slide,
    snapshot.deck,
    requestedScopeId,
  );
  const worldOffset: Matrix = [1, 0, 0, 1, offset.x, offset.y];
  const elementMap = new Map<string, string>();
  const offsets = new Map<string, { x: number; y: number }>();
  const elements = parsed.roots.map(({ element, world }) => {
    const before = walkElements([element]);
    let cursor = 0;
    const copy = cloneSubtree(element, () => {
      const id = newId();
      elementMap.set(before[cursor++].id, id);
      return id;
    });
    for (const child of walkElements([copy]))
      for (const effect of child.effects ?? [])
        effect.resourceId =
          imported.ids.get(effect.resourceId) ?? effect.resourceId;
    copy.frame = frameFromWorldMatrix(
      snapshot.slide,
      scopeId,
      multiply(worldOffset, world),
      copy.frame,
    );
    const absolute = parsed.motion?.stages.some((s) =>
      s.tracks.some(
        (t) =>
          t.elementId === element.id &&
          t.property.startsWith("transform.") &&
          [t.initial, ...t.keyframes.map((k) => k.value)].some(
            (v) => v?.type === "absolute",
          ),
      ),
    );
    if (
      absolute &&
      (["rotation", "scaleX", "scaleY"] as const).some(
        (key) => Math.abs(copy.frame[key] - element.frame[key]) > 1e-6,
      )
    )
      throw new Error(
        "Absolute Motion cannot be pasted into a differently transformed parent. Use relative animation values.",
      );
    if (
      absolute &&
      (copy.frame.flipX !== element.frame.flipX ||
        copy.frame.flipY !== element.frame.flipY)
    )
      throw new Error(
        "Absolute Motion cannot be pasted into a mirrored parent.",
      );
    offsets.set(copy.id, {
      x: copy.frame.x - element.frame.x,
      y: copy.frame.y - element.frame.y,
    });
    return copy;
  });
  const retained =
    parsed.effectResources && Object.keys(parsed.effectResources).length
      ? setSlideEffects(snapshot, { resources: imported.resources })
      : snapshot;
  let next = insertElements(retained, elements, scopeId);
  const motion = cloneMotion(parsed.motion, elementMap);
  if (motion)
    next = setSlideMotion(
      next,
      combineMotion(
        next.slide.motion,
        translateAbsoluteMotion(motion, offsets),
      ),
    );
  return {
    snapshot: next,
    scopeId,
    elementIds: elements.map(({ id }) => id),
  };
}
