import type { Point } from "./geometry";
import type { Element } from "./element";

export type BasicShape = "rectangle" | "ellipse";

export const BASIC_SHAPE_SIZE = {
  width: 640,
  height: 360,
} as const;

export function createBasicShape(
  id: string,
  shape: BasicShape,
  origin: Point = { x: 160, y: 160 },
): Element {
  return {
    id,
    frame: { scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
      x: origin.x,
      y: origin.y,
      width: BASIC_SHAPE_SIZE.width,
      height: BASIC_SHAPE_SIZE.height,
      rotation: 0,
      flipX: false,
      flipY: false,
    },
    geometry: { type: shape === "ellipse" ? "ellipse" : "rect" },
    appearance: {
      opacity: 1,
      fill: "#858f9c",
      strokeColor: "#000000",
      strokeWidth: 0,
      radius: 0,
    },
    content: null,
    container: false,
    clipChildren: false,
    children: [],
  };
}

export function createEmptyFrame(
  id: string,
  origin: Point = { x: 160, y: 160 },
): Element {
  return {
    id,
    frame: { scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
      x: origin.x,
      y: origin.y,
      width: BASIC_SHAPE_SIZE.width,
      height: BASIC_SHAPE_SIZE.height,
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
    clipChildren: true,
    children: [],
  };
}

export function createContainerElement(
  id: string,
  children: Element[] = [],
  origin: Point = { x: 0, y: 0 },
): Element {
  return {
    id,
    frame: { scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
      x: origin.x,
      y: origin.y,
      width: BASIC_SHAPE_SIZE.width,
      height: BASIC_SHAPE_SIZE.height,
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
    children,
  };
}
