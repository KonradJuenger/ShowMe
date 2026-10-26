import type { Point } from "./geometry";
import type { Asset } from "./assets";
import {
  insertElements,
  setElementContents,
  type EditorSnapshot,
} from "./editorCommands";
import {
  frameFromMatrix,
  inverse,
  localMatrix,
  multiply,
  resolveMediaFrame,
  type Element,
  type MediaContent,
} from "./element";
import {
  findElement,
  getChildren,
  getOwningLayer,
  isEditableScope,
  worldPointToScope,
} from "./scene";

export type MediaRule = MediaContent["transform"]["rule"];
export type MediaIntrinsic = { width: number; height: number };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function isMediaContent(
  content: Element["content"],
): content is MediaContent {
  return !!content && content.type !== "text";
}

export function mediaIntrinsic(
  content: MediaContent,
  fallback?: MediaIntrinsic,
): MediaIntrinsic | null {
  const transform = content.transform;
  if (
    transform.rule !== "free" &&
    transform.intrinsicWidth &&
    transform.intrinsicHeight
  )
    return {
      width: transform.intrinsicWidth,
      height: transform.intrinsicHeight,
    };
  if (fallback?.width && fallback.height) return fallback;
  return null;
}

function requirePreparedMediaAsset(asset: Asset) {
  if (
    !["image", "svg", "video"].includes(asset.type) ||
    !asset.width ||
    !asset.height
  )
    throw new Error("Prepared image, SVG, or video asset required");
}

function neutralAppearance() {
  return {
    opacity: 1,
    fill: null,
    strokeColor: "#000000",
    strokeWidth: 0,
    radius: 0,
  };
}

function initialVideoFields(asset: Asset) {
  return asset.type === "video"
    ? {
        autoplay: true,
        loop: false,
        mute: true,
        volume: 1,
        startTime: 0,
        endTime: null,
      }
    : {};
}

export function createMediaElement(
  id: string,
  asset: Asset,
  origin: Point = { x: 160, y: 160 },
): Element {
  requirePreparedMediaAsset(asset);
  const width = 640;
  const height = Math.max(1, (width * asset.height!) / asset.width!);
  const content = {
    type: asset.type,
    assetId: asset.id,
    filename: asset.filename,
    mediaType: asset.mediaType,
    opacity: 1,
    lockAspect: true,
    transform: {
      rule: "fill" as const,
      intrinsicWidth: asset.width!,
      intrinsicHeight: asset.height!,
      rotation: 0,
      flipX: false,
      flipY: false,
      anchorX: 0.5,
      anchorY: 0.5,
      zoom: 1,
    },
    ...initialVideoFields(asset),
  } as MediaContent;

  return {
    id,
    frame: { scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
      x: origin.x,
      y: origin.y,
      width,
      height,
      rotation: 0,
      flipX: false,
      flipY: false,
    },
    geometry: { type: "rect" },
    appearance: neutralAppearance(),
    content,
    container: false,
    clipChildren: true,
    children: [],
  };
}

function editableInsertionScope(
  snapshot: EditorSnapshot,
  requestedScopeId: string | null,
) {
  if (
    requestedScopeId &&
    getChildren(snapshot.slide, requestedScopeId) &&
    isEditableScope(snapshot.slide, snapshot.deck, requestedScopeId)
  )
    return requestedScopeId;

  if (requestedScopeId) {
    const layer = getOwningLayer(snapshot.slide, requestedScopeId);
    if (
      layer &&
      isEditableScope(snapshot.slide, snapshot.deck, layer.id)
    )
      return layer.id;
  }

  const fallback = snapshot.deck.layers.find(
    (layer) =>
      !layer.hidden &&
      !layer.locked &&
      snapshot.slide.nodes.some((root) => root.id === layer.id),
  );
  if (!fallback)
    throw new Error("Select an unlocked, visible layer to add objects");
  return fallback.id;
}

export function insertMediaAssets(
  snapshot: EditorSnapshot,
  requestedScopeId: string | null,
  assets: readonly Asset[],
  worldCenter: Point,
  newId: () => string,
) {
  if (!assets.length)
    return {
      snapshot,
      scopeId: requestedScopeId,
      elementIds: [] as string[],
    };

  assets.forEach(requirePreparedMediaAsset);
  const scopeId = editableInsertionScope(snapshot, requestedScopeId);
  const elements = assets.map((asset, index) => {
    const center = worldPointToScope(snapshot.slide, scopeId, {
      x: worldCenter.x + index * 24,
      y: worldCenter.y + index * 24,
    });
    const element = createMediaElement(newId(), asset);
    return {
      ...element,
      frame: {
        ...element.frame,
        x: center.x - element.frame.width / 2,
        y: center.y - element.frame.height / 2,
      },
    };
  });

  return {
    snapshot: insertElements(snapshot, elements, scopeId),
    scopeId,
    elementIds: elements.map(({ id }) => id),
  };
}

function requireEditableMedia(
  snapshot: EditorSnapshot,
  elementId: string,
) {
  if (!isEditableScope(snapshot.slide, snapshot.deck, elementId))
    throw new Error("Selected Layer is hidden or locked");
  const element = findElement(snapshot.slide, elementId);
  if (!element || !isMediaContent(element.content))
    throw new Error("Selected Element has no media content");
  return element as Element & { content: MediaContent };
}

function clampVideoSettings(
  previous: Extract<MediaContent, { type: "video" }>,
  asset: Asset,
) {
  const duration =
    asset.duration && Number.isFinite(asset.duration) && asset.duration > 0
      ? asset.duration
      : null;
  const startTime = duration
    ? Math.min(previous.startTime, Math.max(0, duration - 0.05))
    : previous.startTime;
  let endTime = previous.endTime;
  if (endTime !== null && duration) {
    endTime = Math.min(endTime, duration);
    if (endTime <= startTime)
      endTime = Math.min(duration, startTime + Math.min(0.05, duration));
  }
  return {
    autoplay: previous.autoplay,
    loop: previous.loop,
    mute: previous.mute,
    volume: previous.volume,
    startTime,
    endTime,
  };
}

export function replacementMediaContent(
  previous: MediaContent,
  asset: Asset,
): MediaContent {
  requirePreparedMediaAsset(asset);
  if ((previous.type === "video") !== (asset.type === "video"))
    throw new Error("Replace requires the same content family (Image or Video)");
  const transform =
    previous.transform.rule === "free"
      ? structuredClone(previous.transform)
      : {
          ...previous.transform,
          intrinsicWidth: asset.width!,
          intrinsicHeight: asset.height!,
        };
  const videoFields =
    asset.type === "video"
      ? previous.type === "video"
        ? clampVideoSettings(previous, asset)
        : {
            autoplay: true,
            loop: false,
            mute: true,
            volume: 1,
            startTime: 0,
            endTime: null,
          }
      : {};

  return {
    type: asset.type,
    assetId: asset.id,
    filename: asset.filename,
    mediaType: asset.mediaType,
    opacity: previous.opacity,
    lockAspect: previous.lockAspect,
    transform,
    ...videoFields,
  } as MediaContent;
}

export function replaceMediaAsset(
  snapshot: EditorSnapshot,
  elementId: string,
  asset: Asset,
) {
  const element = requireEditableMedia(snapshot, elementId);
  return setElementContents(snapshot, [
    {
      elementId,
      value: replacementMediaContent(element.content, asset),
    },
  ]);
}

function fitAnchorForCenter(
  element: Element,
  resolved: Element["frame"],
) {
  const angle = (resolved.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const boundsWidth = resolved.width * cos + resolved.height * sin;
  const boundsHeight = resolved.width * sin + resolved.height * cos;
  const centerX = resolved.x + resolved.width / 2;
  const centerY = resolved.y + resolved.height / 2;
  const availableX = Math.max(0, element.frame.width - boundsWidth);
  const availableY = Math.max(0, element.frame.height - boundsHeight);
  return {
    anchorX:
      availableX < 1e-9
        ? 0.5
        : clamp((centerX - boundsWidth / 2) / availableX, 0, 1),
    anchorY:
      availableY < 1e-9
        ? 0.5
        : clamp((centerY - boundsHeight / 2) / availableY, 0, 1),
  };
}

function fillAnchorForCenter(
  element: Element,
  resolved: Element["frame"],
) {
  const angle = (resolved.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = resolved.x + resolved.width / 2;
  const centerY = resolved.y + resolved.height / 2;
  const dx = element.frame.width / 2 - centerX;
  const dy = element.frame.height / 2 - centerY;
  const fx = resolved.flipX ? -1 : 1;
  const fy = resolved.flipY ? -1 : 1;
  const u = fx * dx * cos + fy * dy * sin;
  const v = -fx * dx * sin + fy * dy * cos;
  return {
    anchorX: clamp(
      0.5 + u / Math.max(1e-9, resolved.width),
      0,
      1,
    ),
    anchorY: clamp(
      0.5 + v / Math.max(1e-9, resolved.height),
      0,
      1,
    ),
  };
}

function elementWithContent(
  element: Element,
  content: MediaContent,
): Element {
  return { ...element, content };
}

export function convertMediaRule(
  element: Element,
  rule: MediaRule,
  intrinsic?: MediaIntrinsic,
): MediaContent {
  if (!isMediaContent(element.content))
    throw new Error("Element has no media content");
  const content = element.content;
  if (content.transform.rule === rule) return structuredClone(content);

  const resolved = resolveMediaFrame(element, intrinsic);
  if (!resolved) throw new Error("Media intrinsic size is unavailable");
  if (rule === "free")
    return {
      ...content,
      transform: { rule: "free", local: structuredClone(resolved) },
    } as MediaContent;

  const size = mediaIntrinsic(content, intrinsic);
  if (!size) throw new Error("Media intrinsic size is unavailable");
  const common = {
    intrinsicWidth: size.width,
    intrinsicHeight: size.height,
    rotation: resolved.rotation,
    flipX: resolved.flipX,
    flipY: resolved.flipY,
    anchorX: 0.5,
    anchorY: 0.5,
  };

  if (rule === "fit") {
    const provisional = {
      ...content,
      transform: { rule: "fit" as const, ...common },
    } as MediaContent;
    const basis = resolveMediaFrame(elementWithContent(element, provisional));
    if (!basis) return provisional;
    return {
      ...provisional,
      transform: {
        ...provisional.transform,
        ...fitAnchorForCenter(element, { ...basis,
          x: resolved.x + resolved.width / 2 - basis.width / 2,
          y: resolved.y + resolved.height / 2 - basis.height / 2 }),
      },
    } as MediaContent;
  }

  const atOne = {
    ...content,
    transform: { rule: "fill" as const, ...common, zoom: 1 },
  } as MediaContent;
  const base = resolveMediaFrame(elementWithContent(element, atOne));
  if (!base) return atOne;
  const zoom = clamp(
    Math.max(
      resolved.width / Math.max(1e-9, base.width),
      resolved.height / Math.max(1e-9, base.height),
    ),
    1,
    100,
  );
  const sized = {
    ...atOne,
    transform: { ...atOne.transform, zoom },
  } as MediaContent;
  const sizedResolved =
    resolveMediaFrame(elementWithContent(element, sized)) ?? resolved;
  return {
    ...sized,
    transform: {
      ...sized.transform,
      ...fillAnchorForCenter(element, {
        ...sizedResolved,
        x: resolved.x + resolved.width / 2 - sizedResolved.width / 2,
        y: resolved.y + resolved.height / 2 - sizedResolved.height / 2,
      }),
    },
  } as MediaContent;
}

export function centerMedia(
  element: Element,
  _intrinsic?: MediaIntrinsic,
): MediaContent {
  if (!isMediaContent(element.content))
    throw new Error("Element has no media content");
  const content = element.content;
  if (content.transform.rule === "free") {
    const local = content.transform.local;
    return {
      ...content,
      transform: {
        rule: "free",
        local: {
          ...local,
          x: (element.frame.width - local.width) / 2,
          y: (element.frame.height - local.height) / 2,
        },
      },
    } as MediaContent;
  }
  return {
    ...content,
    transform: {
      ...content.transform,
      anchorX: 0.5,
      anchorY: 0.5,
    },
  } as MediaContent;
}

export function resetMedia(
  element: Element,
  intrinsic?: MediaIntrinsic,
): MediaContent {
  if (!isMediaContent(element.content))
    throw new Error("Element has no media content");
  const content = element.content;
  if (content.transform.rule !== "free")
    return {
      ...content,
      transform: {
        ...content.transform,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        ...(content.transform.rule === "fill" ? { zoom: 1 } : {}),
      },
    } as MediaContent;

  const size = mediaIntrinsic(content, intrinsic);
  const current = content.transform.local;
  const sourceWidth = size?.width ?? current.width;
  const sourceHeight = size?.height ?? current.height;
  const scale = Math.min(
    element.frame.width / sourceWidth,
    element.frame.height / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    ...content,
    transform: {
      rule: "free",
      local: { scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
        x: (element.frame.width - width) / 2,
        y: (element.frame.height - height) / 2,
        width,
        height,
        rotation: 0,
        flipX: current.flipX,
        flipY: current.flipY,
      },
    },
  } as MediaContent;
}


export function preserveMediaAfterFrameChange(
  before: Element,
  afterFrame: Element["frame"],
  intrinsic?: MediaIntrinsic,
): MediaContent | null {
  if (!isMediaContent(before.content)) return null;
  const resolved = resolveMediaFrame(before, intrinsic);
  if (!resolved) return structuredClone(before.content);
  const relative = multiply(
    inverse(localMatrix(afterFrame)),
    multiply(localMatrix(before.frame), localMatrix(resolved)),
  );
  const nextResolved = frameFromMatrix(relative, resolved);
  const after = { ...before, frame: structuredClone(afterFrame) };
  const semantic = updateMediaFromResolved(
    after,
    nextResolved,
    intrinsic,
  );
  if (semantic.transform.rule === "free") return semantic;

  const actual = resolveMediaFrame(
    { ...after, content: semantic },
    intrinsic,
  );
  const epsilon = 1e-5;
  if (
    actual &&
    Math.abs(actual.x - nextResolved.x) < epsilon &&
    Math.abs(actual.y - nextResolved.y) < epsilon &&
    Math.abs(actual.width - nextResolved.width) < epsilon &&
    Math.abs(actual.height - nextResolved.height) < epsilon &&
    Math.abs(actual.rotation - nextResolved.rotation) < epsilon &&
    Math.abs(actual.scaleX - nextResolved.scaleX) < epsilon &&
    Math.abs(actual.scaleY - nextResolved.scaleY) < epsilon &&
    actual.flipX === nextResolved.flipX &&
    actual.flipY === nextResolved.flipY
  )
    return semantic;

  return {
    ...before.content,
    transform: {
      rule: "free",
      local: structuredClone(nextResolved),
    },
  } as MediaContent;
}

export function updateMediaFromResolved(
  element: Element,
  resolved: Element["frame"],
  intrinsic?: MediaIntrinsic,
): MediaContent {
  if (!isMediaContent(element.content))
    throw new Error("Element has no media content");
  const content = element.content;
  if (content.transform.rule === "free")
    return {
      ...content,
      transform: { rule: "free", local: structuredClone(resolved) },
    } as MediaContent;

  const size = mediaIntrinsic(content, intrinsic);
  if (!size) throw new Error("Media intrinsic size is unavailable");
  if (content.transform.rule === "fit") {
    const provisional = {
      ...content,
      transform: {
        ...content.transform,
        intrinsicWidth: size.width,
        intrinsicHeight: size.height,
        rotation: resolved.rotation,
        flipX: resolved.flipX,
        flipY: resolved.flipY,
        anchorX: 0.5,
        anchorY: 0.5,
      },
    } as MediaContent;
    const basis =
      resolveMediaFrame(elementWithContent(element, provisional)) ?? resolved;
    return {
      ...provisional,
      transform: {
        ...provisional.transform,
        ...fitAnchorForCenter(element, {
          ...basis,
          x: resolved.x + resolved.width / 2 - basis.width / 2,
          y: resolved.y + resolved.height / 2 - basis.height / 2,
        }),
      },
    } as MediaContent;
  }

  const atOne = {
    ...content,
    transform: {
      ...content.transform,
      intrinsicWidth: size.width,
      intrinsicHeight: size.height,
      rotation: resolved.rotation,
      flipX: resolved.flipX,
      flipY: resolved.flipY,
      anchorX: 0.5,
      anchorY: 0.5,
      zoom: 1,
    },
  } as MediaContent;
  const base =
    resolveMediaFrame(elementWithContent(element, atOne)) ?? resolved;
  const zoom = clamp(
    Math.max(
      resolved.width / Math.max(1e-9, base.width),
      resolved.height / Math.max(1e-9, base.height),
    ),
    1,
    100,
  );
  const sized = {
    ...atOne,
    transform: { ...atOne.transform, zoom },
  } as MediaContent;
  const actual =
    resolveMediaFrame(elementWithContent(element, sized)) ?? resolved;
  return {
    ...sized,
    transform: {
      ...sized.transform,
      ...fillAnchorForCenter(element, {
        ...actual,
        x: resolved.x + resolved.width / 2 - actual.width / 2,
        y: resolved.y + resolved.height / 2 - actual.height / 2,
      }),
    },
  } as MediaContent;
}

export function setMediaContent(
  snapshot: EditorSnapshot,
  elementId: string,
  content: MediaContent,
) {
  requireEditableMedia(snapshot, elementId);
  return setElementContents(snapshot, [{ elementId, value: content }]);
}
