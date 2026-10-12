import { resolveTextTypography } from "./textTypography";
import type { AcceptedTransaction } from "./documentTransactions";
import type { PresentationDocument } from "./document";
import type { DocumentOperation } from "./documentOperations";
import { editablePage } from "./templates";
import { findElement } from "./scene";

/** Advisory only. Unrecognized operations always request broad work. */
export function documentImpact(
  operations: readonly DocumentOperation[],
  document: PresentationDocument,
  before?: PresentationDocument,
) {
  let dependencies = false,
    media = false,
    visual = false,
    unknown = false;
  let slides: Set<string> | null = new Set();
  for (const operation of operations) {
    if ("slideId" in operation && slides) {
      slides.add(operation.slideId);
      if (document.templates[operation.slideId])
        for (const [id, meta] of Object.entries(document.deck.slideMeta))
          if (meta.templateId === operation.slideId) slides.add(id);
    } else slides = null;
    switch (operation.type) {
      case "slide.notes.set":
      case "deck.guides.set":
        break;
      case "slide.background.set":
        visual = true;
        break;
      case "elements.appearance.set": {
        visual = true;
        if (
          operation.changes.some((change) =>
            Object.keys(change.value).some(
              (key) =>
                ![
                  "opacity",
                  "fill",
                  "strokeColor",
                  "strokeWidth",
                  "radius",
                ].includes(key),
            ),
          )
        )
          dependencies = media = true;
        break;
      }
      case "elements.geometry.set": {
        visual = true;
        if (
          operation.changes.some(
            (change) =>
              !["rect", "ellipse"].includes(change.value.type) ||
              Object.keys(change.value).some((key) => key !== "type"),
          )
        )
          dependencies = media = true;
        break;
      }
      case "elements.content.set": {
        visual = true;
        if (!before) {
          dependencies = media = true;
          break;
        }
        for (const change of operation.changes) {
          const oldElement = findElement(
            editablePage(before, operation.slideId)!,
            change.elementId,
          );
          const nextElement = findElement(
            editablePage(document, operation.slideId)!,
            change.elementId,
          );
          const signature = (
            content: typeof change.value,
            source: PresentationDocument,
          ) => {
            if (!content) return null;
            if (content.type === "text") {
              const style = resolveTextTypography(source.deck, content);
              return [
                style.fontFamily,
                style.bold ? Math.max(700, style.fontWeight) : style.fontWeight,
                style.italic,
              ];
            }
            if (["image", "svg", "video"].includes(content.type))
              return content.assetId;
            unknown = dependencies = media = true;
            slides = null;
            return "unknown";
          };
          if (
            !oldElement ||
            !nextElement ||
            JSON.stringify(signature(oldElement.content, before)) !==
              JSON.stringify(signature(change.value, document))
          )
            dependencies = true;
          if (
            !oldElement ||
            !nextElement ||
            oldElement.content?.type !== "text" ||
            change.value?.type !== "text" ||
            nextElement.effects?.length ||
            nextElement.cssClasses?.length ||
            document.deck.stylesheet
          )
            media = true;
        }
        break;
      }
      case "elements.frame.set": {
        visual = true;
        const page = editablePage(document, operation.slideId);
        const frameKeys = [
          "x",
          "y",
          "width",
          "height",
          "rotation",
          "flipX",
          "flipY",
          "scaleX",
          "scaleY",
          "originX",
          "originY",
        ];
        if (
          operation.changes.some((change) =>
            Object.keys(change.value).some((key) => !frameKeys.includes(key)),
          )
        )
          dependencies = media = true;
        if (document.deck.stylesheet) media = true;
        // Only known primitive leaf shapes can omit media planning. Containers,
        // media, custom Effects and future content kinds conservatively replan.
        if (
          operation.changes.some((change) => {
            const element = page && findElement(page, change.elementId);
            return (
              !element ||
              element.container ||
              element.children.length > 0 ||
              !!element.effects?.length ||
              !!element.cssClasses?.length ||
              element.content !== null ||
              !["rect", "ellipse"].includes(element.geometry.type)
            );
          })
        )
          media = true;
        break;
      }
      case "elements.reorder":
      case "elements.reparent":
      case "elements.container.set":
      case "slide.motion.set":
        visual = true;
        media = true;
        break;
      case "slide.effects.set":
      case "elements.insert":
      case "elements.remove":
      case "elements.replace":
      case "elements.frame":
      case "elements.unframe":
        dependencies = media = visual = true;
        break;
      default:
        unknown = true;
        slides = null;
        dependencies = true;
        media = true;
        visual = true;
    }
  }
  const presentation = unknown
    ? "deck"
    : !visual
      ? "none"
      : operations.every((op) =>
            [
              "elements.frame.set",
              "elements.appearance.set",
              "elements.geometry.set",
              "elements.content.set",
              "slide.background.set",
              "slide.notes.set",
            ].includes(op.type),
          )
        ? "content"
        : operations.every(
              (op) =>
                "slideId" in op &&
                ![
                  "slide.create",
                  "slide.delete",
                  "slide.meta.set",
                  "slide.reorder",
                ].includes(op.type),
            )
          ? "motion"
          : "deck";
  return {
    dependencies,
    media,
    visual,
    slides: slides ? [...slides] : null,
    presentation,
    dependencyPages:
      !unknown && operations.every((op) => "slideId" in op)
        ? [
            ...new Set(
              operations.map((op) => (op as { slideId: string }).slideId),
            ),
          ]
        : undefined,
  };
}
const acceptedImpacts = new WeakMap<
  AcceptedTransaction,
  ReturnType<typeof documentImpact>
>();
export function recordAcceptedImpact(
  accepted: AcceptedTransaction,
  before: PresentationDocument,
  after: PresentationDocument,
) {
  try {
    acceptedImpacts.set(
      accepted,
      documentImpact(accepted.operations, after, before),
    );
  } catch {
    /* Advisory work must never reject a semantic transaction. */
  }
}
export function acceptedImpact(
  accepted: AcceptedTransaction,
  document: PresentationDocument,
) {
  return (
    acceptedImpacts.get(accepted) ??
    documentImpact(accepted.operations, document)
  );
}
