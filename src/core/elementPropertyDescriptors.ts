import { appearanceSchema, frameSchema, type Element } from "./element";
import { numericEffectParameter, type EffectResources } from "./effects";
import type { TextStyleSource } from "./textTypography";
export const unavailable = Symbol("unavailable");
export type SelectionPropertyValue<T> =
  { state: "value"; value: T } | { state: "mixed" } | { state: "unavailable" };
export interface ElementProperty<T> {
  label: string;
  read(element: Element, source?: TextStyleSource): T | typeof unavailable;
  write(element: Element, value: T, source?: TextStyleSource): Element;
  block:
    "frame" | "appearance" | "geometry" | "content" | "container" | "effects";
  supportsMultiEdit: boolean;
  animation: {
    animatable: boolean;
    motion: boolean;
    interpolation: "number" | "color" | "discrete";
    target: "self" | "content";
  };
}
export function property<T>(
  label: string,
  block: ElementProperty<T>["block"],
  read: ElementProperty<T>["read"],
  write: ElementProperty<T>["write"],
  interpolation: "number" | "color" | "discrete" = "number",
): ElementProperty<T> {
  return {
    label,
    block,
    read,
    write: (element, value, source) =>
      read(element, source) === unavailable
        ? element
        : write(element, value, source),
    supportsMultiEdit: true,
    animation: {
      animatable: interpolation !== "discrete",
      motion: false,
      interpolation,
      target: block === "content" ? "content" : "self",
    },
  };
}
export function frame<K extends keyof Element["frame"]>(key: K, label: string) {
  const descriptor = property(
    label,
    "frame",
    (e) => e.frame[key],
    (e, value: Element["frame"][K]) => ({
      ...e,
      frame: frameSchema.parse({ ...e.frame, [key]: value }),
    }),
    key === "flipX" || key === "flipY" ? "discrete" : "number",
  );
  descriptor.animation.motion = [
    "x",
    "y",
    "rotation",
    "scaleX",
    "scaleY",
  ].includes(key);
  return descriptor;
}
export function appearance<K extends keyof Element["appearance"]>(
  key: K,
  label: string,
  interpolation: "number" | "color" = "number",
) {
  const descriptor = property(
    label,
    "appearance",
    (e) => e.appearance[key],
    (e, value: Element["appearance"][K]) => ({
      ...e,
      appearance: appearanceSchema.parse({ ...e.appearance, [key]: value }),
    }),
    interpolation,
  );
  descriptor.animation.motion = key === "opacity";
  return descriptor;
}

export const elementTransformProperties = {
  "transform.x": frame("x", "X"),
  "transform.y": frame("y", "Y"),
  "transform.width": frame("width", "Width"),
  "transform.height": frame("height", "Height"),
  "transform.rotation": frame("rotation", "Rotation"),
  "transform.scaleX": frame("scaleX", "Scale X"),
  "transform.scaleY": frame("scaleY", "Scale Y"),
  "transform.originX": frame("originX", "Origin X"),
  "transform.originY": frame("originY", "Origin Y"),
  "transform.flipX": frame("flipX", "Flip horizontal"),
  "transform.flipY": frame("flipY", "Flip vertical"),
  "appearance.opacity": appearance("opacity", "Opacity"),
};

/** Same numeric descriptor contract for declared instance parameters. */
export function motionPropertyDescriptor(
  element: Element,
  address: string,
  resources?: EffectResources,
): ElementProperty<number> | undefined {
  if (Object.hasOwn(elementTransformProperties, address))
    return elementTransformProperties[
      address as keyof typeof elementTransformProperties
    ] as ElementProperty<number>;
  const binding = numericEffectParameter(element, address, resources);
  if (!binding) return undefined;
  const { instance, parameter } = binding;
  return {
    label: parameter.label,
    block: "effects",
    supportsMultiEdit: false,
    animation: {
      animatable: true,
      motion: true,
      interpolation: "number",
      target: "content",
    },
    read: (e) => {
      const value = e.effects?.find((i) => i.id === instance.id)?.parameters[
        parameter.key
      ];
      return typeof value === "number" ? value : parameter.default;
    },
    write: (e, value) => {
      if (!Number.isFinite(value))
        throw new Error("Effect parameter must be finite");
      return {
        ...e,
        effects: e.effects?.map((i) =>
          i.id === instance.id
            ? { ...i, parameters: { ...i.parameters, [parameter.key]: value } }
            : i,
        ),
      };
    },
  };
}
