import { effectSurface } from "./effectRuntime";
import { elementWorldTransform } from "./elementDomTransform";
import { sceneBackdropBackends } from "./sceneBackdropRegistry";
import { presenceElement } from "../core/presence";
import type { CompositionPlan, VisualGroup } from "./compositionPlan";
import type { Deck, Slide } from "../core/document";

type Bounds = { left: number; top: number; right: number; bottom: number };
type RestoredCard = {
  owner: HTMLElement;
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement;
  bitmap: ImageBitmapRenderingContext;
  group: VisualGroup;
  populated: boolean;
};
const bounds = (g: VisualGroup): Bounds => ({
  left: g.element.frame.x,
  top: g.element.frame.y,
  right: g.element.frame.x + g.element.frame.width,
  bottom: g.element.frame.y + g.element.frame.height,
});
const overlap = (a: Bounds, b: Bounds, padding: number) =>
  a.left - padding < b.right + padding &&
  b.left - padding < a.right + padding &&
  a.top - padding < b.bottom + padding &&
  b.top - padding < a.bottom + padding;

/** Backdrop restoration implements mix(B,R,a) as R overlaid with B at 1-a.
 * R remains entirely native, including fill-before-filter and rounded AA. The
 * current capability is disjoint flat cards over one procedural background;
 * prior cards cannot contribute pixels inside another card's swept bounds.
 * Unsupported overlap, nested alpha and mixed stacks retain the usual backend. */
export function sceneBackdropPlan(
  plan: CompositionPlan,
  slide: Slide,
  deck: Deck,
  padding = 2,
) {
  if (
    !/\bElectron\//.test(navigator.userAgent) ||
    !/\bChrome\/152\./.test(navigator.userAgent) ||
    deck.stylesheet ||
    !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(slide.background)
  )
    return null;
  const background = plan.roots[0];
  if (!background) return null;
  const bg = background.element,
    frame = bg.frame;
  if (
    bg.geometry.type !== "rect" ||
    frame.x ||
    frame.y ||
    frame.width !== deck.width ||
    frame.height !== deck.height ||
    frame.rotation ||
    frame.scaleX !== 1 ||
    frame.scaleY !== 1 ||
    frame.flipX ||
    frame.flipY ||
    bg.appearance.opacity !== 1 ||
    bg.appearance.radius ||
    bg.appearance.strokeWidth ||
    bg.content ||
    bg.children.length ||
    background.inputs.size !== 1
  )
    return null;
  const [effectId, input] = [...background.inputs][0],
    instance = bg.effects!.find((i) => i.id === effectId)!;
  if (
    input.kind !== "none" ||
    instance.placement !== "background" ||
    slide.effectResources![instance.resourceId].kind !== "fragment-glsl"
  )
    return null;
  const glass = new Set<string>(),
    envelopes = new Map<string, Bounds>();
  for (const group of plan.groups.values()) {
    const e = group.element;
    if (e.cssClasses?.length || (e.content && e.content.type !== "text"))
      return null;
    if (
      !group.parentId &&
      (e.frame.rotation ||
        e.frame.scaleX !== 1 ||
        e.frame.scaleY !== 1 ||
        e.frame.flipX ||
        e.frame.flipY ||
        (!group.inputs.size && group.children.length))
    )
      return null;
    if (!group.parentId) envelopes.set(e.id, bounds(group));
    if (!group.inputs.size || group === background) continue;
    if (
      group.parentId ||
      group.inputs.size !== 1 ||
      !(e.appearance.fill || e.appearance.radius) ||
      e.geometry.type !== "rect" ||
      !e.clipChildren ||
      e.appearance.strokeWidth ||
      e.frame.rotation ||
      e.frame.scaleX !== 1 ||
      e.frame.scaleY !== 1 ||
      e.frame.flipX ||
      e.frame.flipY
    )
      return null;
    const [id, entry] = [...group.inputs][0],
      effect = e.effects!.find((i) => i.id === id)!,
      definition = slide.effectResources![effect.resourceId];
    if (
      definition.kind !== "css" ||
      effect.placement !== "content" ||
      entry.kind !== "native" ||
      !entry.operation ||
      !/^\s*:scope\s*\{[^{}]*\}\s*$/.test(definition.source) ||
      /\b(?:var|env|attr|url)\s*\(/i.test(definition.source)
    )
      return null;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(definition.source);
    const rule = sheet.cssRules[0];
    if (!(rule instanceof CSSStyleRule)) return null;
    const style = rule.style;
    if (
      !/^blur\(([\d.]+)px\)(?: saturate\(([\d.]+)%\))?$/.test(
        style.backdropFilter,
      ) ||
      Array.from(style).some(
        (key) =>
          !/^(?:backdrop-filter|background(?:-.*)?|border(?:-.*)?|box-shadow|overflow(?:-.*)?)$/.test(
            key,
          ) || !!style.getPropertyPriority(key),
      )
    )
      return null;
    glass.add(e.id);
  }
  if (!glass.size) return null;
  for (const stage of slide.motion?.stages ?? []) {
    for (const track of stage.tracks)
      if (
        track.property !== "appearance.opacity" ||
        !envelopes.has(track.elementId) ||
        track.elementId === bg.id
      )
        return null;
    for (const block of stage.blocks ?? []) {
      if (!block.binding) continue;
      if (
        block.binding.kind !== "presence" ||
        !envelopes.has(block.binding.elementId) ||
        block.binding.elementId === bg.id
      )
        return null;
      const group = plan.groups.get(block.binding.elementId)!,
        box = envelopes.get(group.element.id)!;
      const schedule = block.presenceSchedule;
      for (const [transition, entrance] of [
        [schedule?.enterTransition, true],
        [schedule?.exitTransition, false],
      ] as const) {
        if (!transition) continue;
        if (
          !["none", "fade", "move"].includes(transition.kind) ||
          (Array.isArray(transition.easing) &&
            (transition.easing[1] < 0 ||
              transition.easing[1] > 1 ||
              transition.easing[3] < 0 ||
              transition.easing[3] > 1))
        )
          return null;
        for (const progress of [0, 1]) {
          const moved = presenceElement(group.element, {
            present: true,
            phase: entrance ? "entering" : "exiting",
            entrance,
            transition,
            transitionProgress: progress,
          });
          box.left = Math.min(box.left, moved.frame.x);
          box.top = Math.min(box.top, moved.frame.y);
          box.right = Math.max(box.right, moved.frame.x + moved.frame.width);
          box.bottom = Math.max(box.bottom, moved.frame.y + moved.frame.height);
        }
      }
    }
  }
  // Cull preceding sources only when they cannot contribute to a restore rect.
  // Native backdrop filtering still sees their actual pixels outside that rect.
  for (const id of glass)
    for (const [other, box] of envelopes) {
      if (other === id || other === bg.id) continue;
      const element = plan.groups.get(other)!.element;
      if (
        element.content?.type === "text" &&
        !element.appearance.fill &&
        !element.appearance.strokeWidth
      )
        continue; // Check native line bounds after fonts are ready.
      const stroke = element.appearance.strokeWidth / 2;
      if (
        overlap(
          envelopes.get(id)!,
          {
            left: box.left - stroke,
            top: box.top - stroke,
            right: box.right + stroke,
            bottom: box.bottom + stroke,
          },
          padding,
        )
      )
        return null;
    }
  return { plan, glass, background, envelopes, padding };
}

/** One shared background snapshot, no DOM backdrop capture or per-card prefix
 * reconstruction. Native paint resolves the material and foreground first.
 * Restoration is clipped to a rectangular paint bound, never the rounded edge. */
export function mountSceneBackdrop(
  root: HTMLElement,
  scene: NonNullable<ReturnType<typeof sceneBackdropPlan>>,
  deck: Deck,
  failed: (error: unknown) => void,
) {
  let disposed = false,
    rejected = false,
    inFlight: Promise<boolean> | undefined;
  const reject = (error: unknown) => {
    if (!disposed && !rejected) {
      rejected = true;
      failed(error);
    }
  };
  const owners = [...root.querySelectorAll<HTMLElement>("[data-element-id]")];
  const node = (id: string) => owners.find((n) => n.dataset.elementId === id)!;
  const bg = node(scene.background.element.id),
    fx = bg.querySelector<HTMLElement>("[data-effect-id]")!;
  const source = document.createElement("canvas");
  source.width = source.height = 1;
  const context = source.getContext("2d")!;
  if (!context) throw new Error("Backdrop restoration is unavailable");
  const cards: RestoredCard[] = [];
  try {
    for (const id of scene.glass) {
      const owner = node(id),
        group = scene.plan.groups.get(id)!;
      const overlay = document.createElement("div");
      overlay.dataset.backdropRestore = "true";
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.cssText = `position:absolute;left:0;top:0;width:${deck.width}px;height:${deck.height}px;pointer-events:none;opacity:0;`;
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.style.cssText = `position:absolute;left:0;top:0;width:${deck.width}px;height:${deck.height}px;`;
      const bitmap = canvas.getContext("bitmaprenderer");
      if (!bitmap) throw new Error("Bitmap restoration is unavailable");
      overlay.append(canvas);
      owner.after(overlay);
      cards.push({ owner, overlay, canvas, bitmap, group, populated: false });
    }
  } catch (error) {
    cards.forEach((c) => c.overlay.remove());
    throw error;
  }
  const validateText = () => {
    if (disposed) return;
    const viewport = root.getBoundingClientRect(),
      scaleX = viewport.width / deck.width,
      scaleY = viewport.height / deck.height;
    if (!(scaleX > 0 && scaleY > 0))
      throw new Error("Native output bounds are unavailable");
    for (const group of scene.plan.roots) {
      if (group.element.content?.type !== "text") continue;
      const owner = node(group.element.id),
        text = owner.querySelector<HTMLElement>("[data-text-content]");
      if (!text) throw new Error("Native text bounds are unavailable");
      const range = document.createRange();
      range.selectNodeContents(text);
      const world = elementWorldTransform(owner, root),
        box = scene.envelopes.get(group.element.id)!;
      // Native line boxes plus an em of overhang conservatively include glyph
      // ink outside the advance box, including italic/combining marks.
      const overhang = parseFloat(getComputedStyle(text).fontSize);
      for (const rect of range.getClientRects()) {
        const ink = {
          left:
            box.left +
            (rect.left - viewport.left) / scaleX -
            world.e -
            overhang,
          top:
            box.top + (rect.top - viewport.top) / scaleY - world.f - overhang,
          right:
            box.right -
            group.element.frame.width +
            (rect.right - viewport.left) / scaleX -
            world.e +
            overhang,
          bottom:
            box.bottom -
            group.element.frame.height +
            (rect.bottom - viewport.top) / scaleY -
            world.f +
            overhang,
        };
        if (
          [...scene.glass].some((id) =>
            overlap(scene.envelopes.get(id)!, ink, scene.padding),
          )
        )
          throw new Error("Native text contributes to a restoration region");
      }
    }
  };
  const ready = document.fonts.ready.then(validateText);
  const fontChanged = () => {
    try {
      validateText();
    } catch (error) {
      reject(error);
    }
  };
  document.fonts.addEventListener("loadingdone", fontChanged);
  // Placement and inverse alpha belong to the current Motion sample, not to
  // the asynchronous bitmap request. Until the first bitmap exists, keep the
  // native card unpainted; publication reveals both parts in the same task.
  const sample = () =>
    cards.filter((card) => {
      const alpha = Number(
        getComputedStyle(
          card.owner.querySelector<HTMLElement>(
            ":scope > [data-composition-alpha]",
          ) ?? card.owner,
        ).opacity,
      );
      const visibility = getComputedStyle(card.owner).visibility;
      const active = visibility === "visible" && alpha < 1;
      // Keep opacity at one even while preparing: lowering it would activate
      // the CSS group-opacity fallback that this native path avoids.
      card.owner.style.contentVisibility =
        (active && !card.populated) ||
        card.owner.dataset.presentationAbsent === "true"
          ? "hidden"
          : "";
      card.overlay.style.visibility = visibility;
      card.overlay.style.opacity =
        active && card.populated ? String(1 - alpha) : "0";
      if (active) {
        const world = elementWorldTransform(card.owner, root),
          { width, height } = card.group.element.frame,
          pad = scene.padding;
        card.overlay.style.clipPath = `inset(${world.f - pad}px ${deck.width - world.e - width - pad}px ${deck.height - world.f - height - pad}px ${world.e - pad}px)`;
      }
      return active;
    });
  const render = async () => {
    sample();
    await ready;
    if (disposed || rejected) return false;
    root.dataset.compositionBackend = "native-backdrop-restore";
    const active = sample();
    for (const card of cards) {
      if (!active.includes(card) && card.populated) {
        card.bitmap.transferFromImageBitmap(null);
        card.canvas.width = card.canvas.height = 1;
        card.populated = false;
      }
    }
    if (!active.length) {
      if (source.width !== 1 || source.height !== 1)
        source.width = source.height = 1;
      return true;
    }
    if (fx.dataset.effectError) throw new Error(fx.dataset.effectError);
    if (fx.dataset.effectReady !== "true") return false;
    effectSurface(fx)?.materialize();
    const shader = fx.querySelector("canvas")!;
    if (!shader.width || !shader.height) return false;
    // A bounded logical RGBA surface footprint, not an estimate of residency.
    // Match the existing shader's actual (possibly capability-reduced) grid.
    if (
      shader.width * shader.height * 4 * (2 * cards.length + 1) >
      256 * 1024 * 1024
    )
      throw new Error("Backdrop restoration exceeds its surface budget");
    if (source.width !== shader.width) source.width = shader.width;
    if (source.height !== shader.height) source.height = shader.height;
    context.resetTransform();
    context.globalAlpha = 1;
    context.fillStyle = root.style.background;
    context.fillRect(0, 0, source.width, source.height);
    context.fillStyle =
      scene.background.element.appearance.fill || "transparent";
    context.fillRect(0, 0, source.width, source.height);
    if (getComputedStyle(shader).visibility === "visible")
      context.drawImage(shader, 0, 0, source.width, source.height);
    const pending = await Promise.allSettled(
      active.map(async (card) => ({
        card,
        bitmap: await createImageBitmap(source),
      })),
    );
    try {
      const failure = pending.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of pending) {
        if (result.status !== "fulfilled") continue;
        const { card, bitmap } = result.value;
        if (!disposed && !rejected) {
          if (card.canvas.width !== source.width)
            card.canvas.width = source.width;
          if (card.canvas.height !== source.height)
            card.canvas.height = source.height;
          card.bitmap.transferFromImageBitmap(bitmap);
          card.populated = true;
        }
      }
    } finally {
      pending.forEach((result) => {
        if (result.status === "fulfilled") result.value.bitmap.close();
      });
    }
    if (!disposed && !rejected) sample();
    return !disposed && !rejected;
  };
  const backend = {
    sample,
    flush() {
      return (inFlight ??= render()
        .catch((error) => {
          reject(error);
          return false;
        })
        .finally(() => {
          inFlight = undefined;
        }));
    },
  };
  sceneBackdropBackends.set(root, backend);
  sample();
  void ready.catch(reject);
  return () => {
    disposed = true;
    document.fonts.removeEventListener("loadingdone", fontChanged);
    sceneBackdropBackends.delete(root);
    delete root.dataset.compositionBackend;
    cards.forEach((c) => {
      if (c.owner.dataset.presentationAbsent !== "true")
        c.owner.style.contentVisibility = "";
      c.overlay.remove();
      c.bitmap.transferFromImageBitmap(null);
      c.canvas.width = c.canvas.height = 1;
    });
    source.width = source.height = 1;
  };
}
