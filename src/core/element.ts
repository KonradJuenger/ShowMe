import { textFormatSchema } from "./textTypography";
import { z } from "zod";
import { idSchema } from "./ids";
import { hashSchema } from "./assets";
import type { Box, Point } from "./geometry";
import { elementEffectsSchema } from "./effects";

const finite = z.number().finite();
export const MAX_ELEMENT_DIMENSION = 100000;
const dimension = finite.positive().max(MAX_ELEMENT_DIMENSION);
export const frameSchema = z
  .object({
    x: finite,
    y: finite,
    width: dimension,
    height: dimension,
    rotation: finite,
    scaleX: finite.positive().max(10000),
    scaleY: finite.positive().max(10000),
    originX: finite.min(0).max(1),
    originY: finite.min(0).max(1),
    flipX: z.boolean(),
    flipY: z.boolean(),
  })
  .strict();
export const appearanceSchema = z
  .object({
    opacity: finite.min(0).max(1),
    fill: z.string().nullable(),
    strokeColor: z.string(),
    strokeWidth: finite.nonnegative(),
    radius: finite.nonnegative(),
  })
  .strict();
const mediaContentFields = {
  assetId: hashSchema,
  filename: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^/\\]+$/),
  mediaType: z.enum(["image", "video", "audio", "font", "other"]),
  opacity: finite.min(0).max(1),
  lockAspect: z.boolean(),
};
export const mediaTransformSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("free"), local: frameSchema }).strict(),
  z
    .object({
      rule: z.literal("fit"),
      intrinsicWidth: dimension.nullable(),
      intrinsicHeight: dimension.nullable(),
      rotation: finite,
      flipX: z.boolean(),
      flipY: z.boolean(),
      anchorX: finite.min(0).max(1),
      anchorY: finite.min(0).max(1),
    })
    .strict(),
  z
    .object({
      rule: z.literal("fill"),
      intrinsicWidth: dimension.nullable(),
      intrinsicHeight: dimension.nullable(),
      rotation: finite,
      flipX: z.boolean(),
      flipY: z.boolean(),
      anchorX: finite.min(0).max(1),
      anchorY: finite.min(0).max(1),
      zoom: finite.min(1).max(100),
    })
    .strict(),
]);
// Null intrinsic dimensions remain valid when source
// size is unavailable. Resolution waits for the asset's natural dimensions.
const mediaFields = { ...mediaContentFields, transform: mediaTransformSchema };
export const contentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(100000),
      placeholder: z.boolean(),
      format: textFormatSchema,
      autoSize: z.enum(["none", "height", "both"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      ...mediaFields,
    })
    .strict(),
  z
    .object({
      type: z.literal("svg"),
      ...mediaFields,
    })
    .strict(),
  z
    .object({
      type: z.literal("video"),
      ...mediaFields,
      autoplay: z.boolean(),
      loop: z.boolean(),
      mute: z.boolean(),
      volume: finite.min(0).max(1),
      startTime: finite.nonnegative(),
      endTime: finite.positive().nullable(),
    })
    .strict(),
]);
export const geometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rect") }).strict(),
  z.object({ type: z.literal("ellipse") }).strict(),
]);
export const containerStateSchema = z
  .object({
    container: z.boolean(),
    clipChildren: z.boolean(),
  })
  .strict();

const baseSchema = z
  .object({
    id: idSchema,
    name: z.string().max(200).optional(),
    cssClasses: z
      .array(
        z
          .string()
          .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)
          .max(100),
      )
      .max(100)
      .optional(),
    effects: elementEffectsSchema.optional(),
    frame: frameSchema,
    geometry: geometrySchema,
    appearance: appearanceSchema,
    content: contentSchema.nullable(),
    container: containerStateSchema.shape.container,
    clipChildren: containerStateSchema.shape.clipChildren,
  })
  .strict();
export type Element = z.infer<typeof baseSchema> & {
  children: Element[];
};
export type MediaContent = Extract<
  NonNullable<Element["content"]>,
  { type: "image" | "svg" | "video" }
>;

/** The only resolved media rectangle. Fit and Fill never persist it. */
export function resolveMediaFrame(
  element: Element,
  intrinsic?: { width: number; height: number },
): Element["frame"] | null {
  const content = element.content;
  if (!content || content.type === "text") return null;
  const transform = content.transform;
  if (transform.rule === "free") return transform.local;

  const sourceWidth = transform.intrinsicWidth ?? intrinsic?.width;
  const sourceHeight = transform.intrinsicHeight ?? intrinsic?.height;
  if (!sourceWidth || !sourceHeight) return null;

  const angle = (transform.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const scale =
    transform.rule === "fit"
      ? Math.min(
          element.frame.width / (sourceWidth * cos + sourceHeight * sin),
          element.frame.height / (sourceWidth * sin + sourceHeight * cos),
        )
      : Math.max(
          (element.frame.width * cos + element.frame.height * sin) /
            sourceWidth,
          (element.frame.width * sin + element.frame.height * cos) /
            sourceHeight,
        ) * Math.max(1, transform.zoom);

  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  let centerX: number;
  let centerY: number;

  if (transform.rule === "fit") {
    const boundsWidth = width * cos + height * sin;
    const boundsHeight = width * sin + height * cos;
    centerX =
      boundsWidth / 2 +
      Math.max(0, element.frame.width - boundsWidth) * transform.anchorX;
    centerY =
      boundsHeight / 2 +
      Math.max(0, element.frame.height - boundsHeight) * transform.anchorY;
    centerX = Math.max(
      boundsWidth / 2,
      Math.min(element.frame.width - boundsWidth / 2, centerX),
    );
    centerY = Math.max(
      boundsHeight / 2,
      Math.min(element.frame.height - boundsHeight / 2, centerY),
    );
  } else {
    const signedCos = Math.cos(angle);
    const signedSin = Math.sin(angle);
    const fx = transform.flipX ? -1 : 1;
    const fy = transform.flipY ? -1 : 1;
    const u = (0.5 - transform.anchorX) * width;
    const v = (0.5 - transform.anchorY) * height;
    centerX = element.frame.width / 2 + fx * (u * signedCos - v * signedSin);
    centerY = element.frame.height / 2 + fy * (u * signedSin + v * signedCos);

    const projectU = (x: number, y: number) =>
      fx * x * signedCos + fy * y * signedSin;
    const projectV = (x: number, y: number) =>
      -fx * x * signedSin + fy * y * signedCos;
    const corners = [
      { x: 0, y: 0 },
      { x: element.frame.width, y: 0 },
      { x: element.frame.width, y: element.frame.height },
      { x: 0, y: element.frame.height },
    ];
    const projectedU = corners.map((point) => projectU(point.x, point.y));
    const projectedV = corners.map((point) => projectV(point.x, point.y));
    const minU = Math.min(...projectedU);
    const maxU = Math.max(...projectedU);
    const minV = Math.min(...projectedV);
    const maxV = Math.max(...projectedV);
    const currentU = projectU(centerX, centerY);
    const currentV = projectV(centerX, centerY);
    const nextU = Math.max(
      maxU - width / 2,
      Math.min(minU + width / 2, currentU),
    );
    const nextV = Math.max(
      maxV - height / 2,
      Math.min(minV + height / 2, currentV),
    );
    centerX = fx * (nextU * signedCos - nextV * signedSin);
    centerY = fy * (nextU * signedSin + nextV * signedCos);
  }

  return {
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.5,
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: transform.rotation,
    flipX: transform.flipX,
    flipY: transform.flipY,
  };
}

export const elementSchema: z.ZodType<Element> = z.lazy(() =>
  baseSchema
    .extend({ children: z.array(elementSchema).max(10000) })
    .strict()
    .refine(
      (element) => element.container || element.children.length === 0,
      "Only containers may have children",
    ),
);

/** Frame coordinates are local to the parent. Resizing a container does not scale children.
 * Text frame resizing changes the box; text size changes only through fontSize/autoSize.
 * Free media stores its content-local rectangle; resizing its parent leaves it
 * unchanged. Fit and Fill derive that rectangle from the outer frame, intrinsic
 * size, rotation, anchors and (for Fill) zoom, including on frame resize.
 * Media has no separate persistent identity or child Element. Clipping applies
 * the element geometry to both content and descendants.
 * Only x/y/size/rotation/flips are stored; world transforms and bounds are derived.
 */
export function validateElementForest(roots: readonly Element[]): void {
  const ids = new Set<string>();
  const ancestors = new Set<Element>();
  let count = 0;
  const visit = (node: Element, depth: number) => {
    if (depth > 100) throw new Error("Element nesting exceeds 100 levels");
    if (++count > 100000) throw new Error("Element tree exceeds 100000 nodes");
    if (ancestors.has(node)) throw new Error("Cyclic Element tree");
    if (ids.has(node.id)) throw new Error(`Duplicate Element ID: ${node.id}`);
    ids.add(node.id);
    ancestors.add(node);
    for (const child of node.children) visit(child, depth + 1);
    ancestors.delete(node);
  };
  for (const root of roots) visit(root, 1);
  z.array(elementSchema).parse(roots);
}

export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function inverse(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error("Noninvertible transform");
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}
export function transformPoint(m: Matrix, p: Point): Point {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}
/** Motion independent transforms: T(layout) T(origin) S(signed) R T(-origin).
 * localMatrix is the canonical geometry representation of the rendered frame. */
export function frameCssTransform(frame: Element["frame"]): string {
  return `scale(${(frame.flipX ? -1 : 1) * frame.scaleX}, ${(frame.flipY ? -1 : 1) * frame.scaleY}) rotate(${frame.rotation}deg)`;
}
export function frameCssOrigin(frame: Element["frame"]): string {
  return `${frame.originX * 100}% ${frame.originY * 100}%`;
}
export function localMatrix(frame: Element["frame"]): Matrix {
  const a = (frame.rotation * Math.PI) / 180;
  const c = Math.cos(a),
    s = Math.sin(a),
    fx = (frame.flipX ? -1 : 1) * frame.scaleX,
    fy = (frame.flipY ? -1 : 1) * frame.scaleY;
  const cx = frame.width * frame.originX,
    cy = frame.height * frame.originY;
  return [
    c * fx,
    s * fy,
    -s * fx,
    c * fy,
    frame.x + cx - c * fx * cx + s * fx * cy,
    frame.y + cy - s * fy * cx - c * fy * cy,
  ];
}
export function walkElements(roots: readonly Element[]): Element[] {
  return roots.flatMap((node) => [node, ...walkElements(node.children)]);
}
export function findElementInForest(
  roots: readonly Element[],
  id: string,
): Element | undefined {
  return walkElements(roots).find((node) => node.id === id);
}
function locate(
  roots: Element[],
  id: string,
  parent: Element | null = null,
  parentWorld: Matrix = IDENTITY,
):
  | {
      node: Element;
      siblings: Element[];
      parent: Element | null;
      world: Matrix;
    }
  | undefined {
  for (const node of roots) {
    const world = multiply(parentWorld, localMatrix(node.frame));
    if (node.id === id) return { node, siblings: roots, parent, world };
    const nested = locate(node.children, id, node, world);
    if (nested) return nested;
  }
}
export function worldMatrix(roots: Element[], id: string): Matrix {
  const found = locate(roots, id);
  if (!found) throw new Error(`Unknown Element: ${id}`);
  return found.world;
}
export function worldBounds(roots: Element[], id: string): Box {
  const node = findElementInForest(roots, id);
  if (!node) throw new Error(`Unknown Element: ${id}`);
  const m = worldMatrix(roots, id),
    { width: w, height: h } = node.frame;
  const points = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => transformPoint(m, p));
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
/** For S R, rows are orthogonal with lengths scaleX/scaleY.
 * Preserve the X reflection branch; determinant fixes Y, and row X fixes rotation.
 * Nonorthogonal rows cannot be represented without shear. Keep layout/origin. */
export function frameFromMatrix(
  m: Matrix,
  frame: Element["frame"],
): Element["frame"] {
  const scaleX = Math.hypot(m[0], m[2]);
  const scaleY = Math.hypot(m[1], m[3]);
  if (scaleX < 1e-12 || scaleY < 1e-12)
    throw new Error("Noninvertible transform");
  if (Math.abs(m[0] * m[1] + m[2] * m[3]) > 1e-7 * scaleX * scaleY)
    throw new Error("This move would require a sheared Element transform");
  const flipX = frame.flipX;
  const flipY = m[0] * m[3] - m[1] * m[2] < 0 !== flipX;
  const rotation =
    (Math.atan2(-m[2] * (flipX ? -1 : 1), m[0] * (flipX ? -1 : 1)) * 180) /
    Math.PI;
  const origin = {
    x: frame.width * frame.originX,
    y: frame.height * frame.originY,
  };
  const positioned = transformPoint(m, origin);
  return {
    ...frame,
    x: positioned.x - origin.x,
    y: positioned.y - origin.y,
    rotation,
    scaleX,
    scaleY,
    flipX,
    flipY,
  };
}
/** Structural changes are atomic to the caller; persistence still belongs to DocumentAuthority. */
export function reparentElementInForest(
  roots: Element[],
  id: string,
  parentId: string | null,
  index?: number,
): Element[] {
  const copy = structuredClone(roots),
    source = locate(copy, id);
  if (!source) throw new Error(`Unknown Element: ${id}`);
  const destination = parentId === null ? null : locate(copy, parentId);
  if (parentId !== null && (!destination || !destination.node.container))
    throw new Error("Destination must be a container");
  if (
    destination &&
    (destination.node.id === id ||
      (parentId !== null &&
        findElementInForest(source.node.children, parentId)))
  )
    throw new Error("Cannot parent an Element into itself or a descendant");
  const target = destination?.node.children ?? copy;
  const maximumIndex =
    source.siblings === target ? target.length - 1 : target.length;
  if (
    index !== undefined &&
    (!Number.isInteger(index) || index < 0 || index > maximumIndex)
  )
    throw new Error("Invalid reparent index");
  const local = multiply(inverse(destination?.world ?? IDENTITY), source.world);
  source.siblings.splice(source.siblings.indexOf(source.node), 1);
  source.node.frame = frameFromMatrix(local, source.node.frame);
  target.splice(index ?? target.length, 0, source.node);
  validateElementForest(copy);
  return copy;
}
export function insertElementInForest(
  roots: Element[],
  parentId: string | null,
  node: Element,
  index?: number,
): Element[] {
  const copy = structuredClone(roots);
  if (findElementInForest(copy, node.id))
    throw new Error(`Duplicate Element ID: ${node.id}`);
  const parent = parentId === null ? null : findElementInForest(copy, parentId);
  if (parentId !== null && (!parent || !parent.container))
    throw new Error("Destination must be a container");
  const target = parent?.children ?? copy;
  if (
    index !== undefined &&
    (!Number.isInteger(index) || index < 0 || index > target.length)
  )
    throw new Error("Invalid insertion index");
  target.splice(index ?? target.length, 0, structuredClone(node));
  validateElementForest(copy);
  return copy;
}
export function removeElementFromForest(
  roots: Element[],
  id: string,
): Element[] {
  const copy = structuredClone(roots),
    found = locate(copy, id);
  if (!found) throw new Error(`Unknown Element: ${id}`);
  found.siblings.splice(found.siblings.indexOf(found.node), 1);
  return copy;
}
export function replaceElementInForest(
  roots: Element[],
  id: string,
  node: Element,
): Element[] {
  if (node.id !== id) throw new Error("Element identity cannot change");
  const copy = structuredClone(roots),
    found = locate(copy, id);
  if (!found) throw new Error(`Unknown Element: ${id}`);
  found.siblings.splice(
    found.siblings.indexOf(found.node),
    1,
    structuredClone(node),
  );
  validateElementForest(copy);
  return copy;
}
export function cloneElement(node: Element, newId: () => string): Element {
  return {
    ...structuredClone(node),
    id: newId(),
    children: node.children.map((child) => cloneElement(child, newId)),
  };
}

/** Wrap sibling Elements in a neutral container. Children keep their world transform. */
export function frameSiblingElements(
  roots: Element[],
  ids: readonly string[],
  frameId: string,
): Element[] {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("Frame Selection requires distinct Elements");
  const copy = structuredClone(roots);
  if (findElementInForest(copy, frameId))
    throw new Error("Frame ID already exists");
  const selected = ids.map((id) => locate(copy, id));
  if (selected.some((entry) => !entry))
    throw new Error("Unknown Element in selection");
  const locations = selected as NonNullable<(typeof selected)[number]>[];
  const siblings = locations[0].siblings;
  if (locations.some((entry) => entry.siblings !== siblings))
    throw new Error("Frame Selection requires sibling Elements");
  const selectedIds = new Set(ids);
  const ordered = siblings.filter((node) => selectedIds.has(node.id));
  const points = ordered.flatMap((node) => {
    const matrix = localMatrix(node.frame);
    return [
      { x: 0, y: 0 },
      { x: node.frame.width, y: 0 },
      { x: node.frame.width, y: node.frame.height },
      { x: 0, y: node.frame.height },
    ].map((point) => transformPoint(matrix, point));
  });
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  const frame: Element = {
    id: frameId,
    frame: {
      scaleX: 1,
      scaleY: 1,
      originX: 0.5,
      originY: 0.5,
      x,
      y,
      width: Math.max(1e-6, right - x),
      height: Math.max(1e-6, bottom - y),
      rotation: 0,
      flipX: false,
      flipY: false,
    },
    geometry: { type: "rect" },
    appearance: {
      opacity: 1,
      fill: null,
      strokeColor: "#000000",
      strokeWidth: 0,
      radius: 0,
    },
    content: null,
    container: true,
    clipChildren: false,
    children: ordered.map((node) => ({
      ...node,
      frame: { ...node.frame, x: node.frame.x - x, y: node.frame.y - y },
    })),
  };
  // Match the working Group command's frontmost insertion rule.
  const frontmostIndex = Math.max(
    ...locations.map((entry) => siblings.indexOf(entry.node)),
  );
  const insertion = siblings.filter(
    (node, index) => index < frontmostIndex && !selectedIds.has(node.id),
  ).length;
  for (let index = siblings.length - 1; index >= 0; index--)
    if (selectedIds.has(siblings[index].id)) siblings.splice(index, 1);
  siblings.splice(insertion, 0, frame);
  validateElementForest(copy);
  return copy;
}

export function isNeutralFrame(element: Element): boolean {
  return (
    element.container &&
    !element.effects?.length &&
    element.content === null &&
    element.geometry.type === "rect" &&
    element.appearance.opacity === 1 &&
    element.appearance.fill === null &&
    element.appearance.strokeWidth === 0 &&
    !element.clipChildren
  );
}

/** Remove a neutral frame while preserving the world appearance of its children. */
export function unframeSiblingElement(
  roots: Element[],
  frameId: string,
): Element[] {
  const copy = structuredClone(roots);
  const found = locate(copy, frameId);
  if (!found) throw new Error(`Unknown Element: ${frameId}`);
  const frame = found.node;
  if (!isNeutralFrame(frame))
    throw new Error("Only a neutral Frame can be unframed without visual loss");
  const frameMatrix = localMatrix(frame.frame);
  const moved = frame.children.map((child) => ({
    ...child,
    frame: frameFromMatrix(
      multiply(frameMatrix, localMatrix(child.frame)),
      child.frame,
    ),
  }));
  const index = found.siblings.indexOf(frame);
  found.siblings.splice(index, 1, ...moved);
  validateElementForest(copy);
  return copy;
}
