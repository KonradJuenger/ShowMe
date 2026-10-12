export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransformBox extends Box {
  rotation: number;
}

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function rotateVector(dx: number, dy: number, degrees: number): Point {
  const angle = radians(degrees),
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

export function inverseRotateVector(dx: number, dy: number, degrees: number): Point {
  return rotateVector(dx, dy, -degrees);
}

export function centerOf(value: Box): Point {
  return { x: value.x + value.width / 2, y: value.y + value.height / 2 };
}

export function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const offset = rotateVector(point.x - center.x, point.y - center.y, degrees);
  return { x: center.x + offset.x, y: center.y + offset.y };
}

export function cornersOf(value: TransformBox): Point[] {
  const center = centerOf(value),
    points = [
      { x: value.x, y: value.y },
      { x: value.x + value.width, y: value.y },
      { x: value.x + value.width, y: value.y + value.height },
      { x: value.x, y: value.y + value.height },
    ];
  if (Math.abs(value.rotation % 360) < 1e-9) return points;
  return points.map((point) => rotatePoint(point, center, value.rotation));
}

export function boundsOf(values: TransformBox[]): Box {
  if (!values.length) return { x: 0, y: 0, width: 0, height: 0 };
  const points = values.flatMap(cornersOf),
    xs = points.map((point) => point.x),
    ys = points.map((point) => point.y),
    x = Math.min(...xs),
    y = Math.min(...ys),
    right = Math.max(...xs),
    bottom = Math.max(...ys);
  return { x, y, width: right - x, height: bottom - y };
}

export function boxCorners(box: Box): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

function axesFor(points: Point[]): Point[] {
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length],
      edge = { x: next.x - point.x, y: next.y - point.y },
      length = Math.hypot(edge.x, edge.y) || 1;
    return { x: -edge.y / length, y: edge.x / length };
  });
}

function projection(points: Point[], axis: Point) {
  const values = points.map((point) => point.x * axis.x + point.y * axis.y);
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function polygonsIntersect(a: Point[], b: Point[]): boolean {
  for (const axis of [...axesFor(a), ...axesFor(b)]) {
    const pa = projection(a, axis),
      pb = projection(b, axis);
    if (pa.max < pb.min || pb.max < pa.min) return false;
  }
  return true;
}

export function transformIntersectsBox(value: TransformBox, box: Box): boolean {
  return polygonsIntersect(cornersOf(value), boxCorners(box));
}

export function transformContainedByBox(value: TransformBox, box: Box): boolean {
  return cornersOf(value).every(({ x, y }) =>
    x >= box.x && x <= box.x + box.width &&
    y >= box.y && y <= box.y + box.height,
  );
}

export function smartSnapAxis(
  position: number,
  size: number,
  targets: number[],
  tolerance: number,
) {
  const points = [position, position + size / 2, position + size];
  let distance = tolerance + 1,
    adjustment = 0,
    guide: number | undefined;
  for (const point of points)
    for (const target of targets) {
      const delta = target - point;
      if (Math.abs(delta) < distance) {
        distance = Math.abs(delta);
        adjustment = delta;
        guide = target;
      }
    }
  return distance <= tolerance
    ? { value: position + adjustment, guide }
    : { value: position, guide: undefined };
}

export function resizeBox(
  start: Box,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: { keepRatio?: boolean; minSize?: number } = {},
): Box {
  const minSize = options.minSize ?? 10;
  let left = start.x,
    right = start.x + start.width,
    top = start.y,
    bottom = start.y + start.height;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;

  if (options.keepRatio) {
    const ratio = Math.max(1e-9, start.width / start.height),
      horizontal = handle.includes("e") || handle.includes("w"),
      vertical = handle.includes("n") || handle.includes("s"),
      proposedWidth = Math.max(minSize, right - left),
      proposedHeight = Math.max(minSize, bottom - top);
    if (horizontal && vertical) {
      if (proposedWidth / proposedHeight > ratio) {
        const height = proposedWidth / ratio;
        if (handle.includes("n")) top = bottom - height;
        else bottom = top + height;
      } else {
        const width = proposedHeight * ratio;
        if (handle.includes("w")) left = right - width;
        else right = left + width;
      }
    } else if (horizontal) {
      const height = proposedWidth / ratio,
        centerY = start.y + start.height / 2;
      top = centerY - height / 2;
      bottom = centerY + height / 2;
    } else if (vertical) {
      const width = proposedHeight * ratio,
        centerX = start.x + start.width / 2;
      left = centerX - width / 2;
      right = centerX + width / 2;
    }
  }

  if (right - left < minSize) {
    if (handle.includes("w")) left = right - minSize;
    else right = left + minSize;
  }
  if (bottom - top < minSize) {
    if (handle.includes("n")) top = bottom - minSize;
    else bottom = top + minSize;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resizeTransform<T extends TransformBox>(
  value: T,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: { keepRatio?: boolean; minSize?: number } = {},
): T {
  const localDelta = inverseRotateVector(dx, dy, value.rotation),
    resized = resizeBox(
      { x: 0, y: 0, width: value.width, height: value.height },
      handle,
      localDelta.x,
      localDelta.y,
      options,
    ),
    originalCenter = centerOf(value),
    localCenterOffset = {
      x: resized.x + resized.width / 2 - value.width / 2,
      y: resized.y + resized.height / 2 - value.height / 2,
    },
    worldCenterOffset = rotateVector(
      localCenterOffset.x,
      localCenterOffset.y,
      value.rotation,
    ),
    nextCenter = {
      x: originalCenter.x + worldCenterOffset.x,
      y: originalCenter.y + worldCenterOffset.y,
    };
  return {
    ...value,
    x: nextCenter.x - resized.width / 2,
    y: nextCenter.y - resized.height / 2,
    width: resized.width,
    height: resized.height,
  };
}

export function scaleTransformToBox<T extends TransformBox>(
  value: T,
  start: Box,
  next: Box,
): T {
  const sx = next.width / Math.max(1e-9, start.width),
    sy = next.height / Math.max(1e-9, start.height),
    itemCenter = centerOf(value),
    nextCenter = {
      x: next.x + (itemCenter.x - start.x) * sx,
      y: next.y + (itemCenter.y - start.y) * sy,
    },
    width = Math.max(1, value.width * sx),
    height = Math.max(1, value.height * sy);
  return {
    ...value,
    x: nextCenter.x - width / 2,
    y: nextCenter.y - height / 2,
    width,
    height,
  };
}

export function rotateTransformAround<T extends TransformBox>(
  value: T,
  center: Point,
  deltaDegrees: number,
): T {
  const itemCenter = centerOf(value),
    rotated = rotatePoint(itemCenter, center, deltaDegrees);
  return {
    ...value,
    x: rotated.x - value.width / 2,
    y: rotated.y - value.height / 2,
    rotation: value.rotation + deltaDegrees,
  };
}

export function uniformResizeFactor(
  handle: ResizeHandle,
  dx: number,
  dy: number,
  basis: number,
) {
  let outward = 0;
  switch (handle) {
    case "n":
      outward = -dy;
      break;
    case "ne":
      outward = (dx - dy) / 2;
      break;
    case "e":
      outward = dx;
      break;
    case "se":
      outward = (dx + dy) / 2;
      break;
    case "s":
      outward = dy;
      break;
    case "sw":
      outward = (-dx + dy) / 2;
      break;
    case "w":
      outward = -dx;
      break;
    case "nw":
      outward = (-dx - dy) / 2;
      break;
  }
  return Math.max(0.05, 1 + outward / Math.max(1e-9, basis));
}
