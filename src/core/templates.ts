import type {
  Deck,
  PresentationDocument,
  Slide,
  TemplatePage,
} from "./document";
import { slideSchema } from "./document";
import { walkElements } from "./element";
import { cloneSubtree } from "./scene";
import { uid } from "./ids";

/** Template editing uses the existing visual editor; slide-only fields stay out of persistence. */
export function templateEditorPage(page: TemplatePage): Slide {
  return { ...page, notes: "" };
}

export function editablePage(
  document: PresentationDocument,
  id: string,
): Slide | undefined {
  return (
    document.slides[id] ??
    (document.templates[id] && templateEditorPage(document.templates[id]))
  );
}

function inheritedEffectResources(page: TemplatePage) {
  const required = new Set(
    walkElements(page.nodes.flatMap((root) => root.children)).flatMap(
      (element) => (element.effects ?? []).map((effect) => effect.resourceId),
    ),
  );
  return Object.fromEntries(
    Object.entries(page.effectResources ?? {}).filter(([id]) =>
      required.has(id),
    ),
  );
}

export interface ResolvedSlide {
  slide: Slide;
  sources: ReadonlyMap<string, "template" | "slide">;
}

/** Pure composition in global Layer order. The resolved tree is never persisted. */
export function resolveVisualSlide(
  deck: Deck,
  slide: Slide,
  templates: Readonly<Record<string, TemplatePage>>,
): ResolvedSlide {
  const sources = new Map<string, "template" | "slide">();
  for (const element of walkElements(slide.nodes.flatMap((r) => r.children)))
    sources.set(element.id, "slide");
  const templateId = deck.slideMeta[slide.id]?.templateId;
  if (!templateId) return { slide, sources };
  const template = templates[templateId];
  if (!template) throw new Error("Missing template: " + templateId);
  const rootIds = new Set(deck.layers.map((layer) => layer.id));
  for (const element of walkElements(
    template.nodes.flatMap((r) => r.children),
  )) {
    if (sources.has(element.id) || rootIds.has(element.id))
      throw new Error("Ambiguous resolved Element ID: " + element.id);
    sources.set(element.id, "template");
  }
  const resources = { ...slide.effectResources };
  for (const [id, definition] of Object.entries(
    inheritedEffectResources(template),
  )) {
    if (
      resources[id] &&
      JSON.stringify(resources[id]) !== JSON.stringify(definition)
    )
      throw new Error("Conflicting template effect resource: " + id);
    resources[id] = definition;
  }
  return {
    sources,
    slide: {
      ...slide,
      background: template.background,
      ...(Object.keys(resources).length ? { effectResources: resources } : {}),
      nodes: deck.layers.map(({ id }, index) => {
        const local = slide.nodes[index],
          inherited = template.nodes[index];
        if (local?.id !== id || inherited?.id !== id)
          throw new Error("Invalid template Layer roots");
        return {
          ...local,
          children: [...inherited.children, ...local.children],
        };
      }),
    },
  };
}

export function resolveSlide(
  document: PresentationDocument,
  id: string,
): ResolvedSlide {
  const slide = document.slides[id];
  if (!slide) throw new Error("Unknown slide: " + id);
  return resolveVisualSlide(document.deck, slide, document.templates);
}

/** Clone inherited content only; local IDs, Motion, and content-addressed assets survive. */
export function makeIndependentSlide(
  deck: Deck,
  slide: Slide,
  templates: Readonly<Record<string, TemplatePage>>,
  newId: () => string = uid,
): Slide {
  const templateId = deck.slideMeta[slide.id]?.templateId;
  if (!templateId) return slide;
  const template = templates[templateId];
  if (!template) throw new Error("Missing template");
  const resources = { ...slide.effectResources };
  const resourceIds = new Map<string, string>();
  for (const [id, definition] of Object.entries(
    inheritedEffectResources(template),
  )) {
    const target =
      resources[id] &&
      JSON.stringify(resources[id]) !== JSON.stringify(definition)
        ? newId()
        : id;
    resourceIds.set(id, target);
    resources[target] = structuredClone(definition);
  }
  const nodes = slide.nodes.map((root, index) => {
    const inherited = template.nodes[index];
    if (inherited?.id !== root.id)
      throw new Error("Invalid template Layer roots");
    const children = inherited.children.map((element) =>
      cloneSubtree(element, newId),
    );
    for (const element of walkElements(children))
      for (const effect of element.effects ?? [])
        effect.resourceId =
          resourceIds.get(effect.resourceId) ?? effect.resourceId;
    return { ...root, children: [...children, ...root.children] };
  });
  return slideSchema.parse({
    ...slide,
    background: template.background,
    nodes,
    ...(Object.keys(resources).length ? { effectResources: resources } : {}),
  });
}

export function templateLabel(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("Invalid template ordinal");
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}

export function nextTemplateLabel(deck: Deck): string {
  const highest = Math.max(
    ...Object.values(deck.templateMeta).map(({ label }) =>
      [...label].reduce(
        (value, character) => value * 26 + character.charCodeAt(0) - 64,
        0,
      ),
    ),
  );
  return templateLabel(highest);
}
