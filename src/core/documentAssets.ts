import type { PresentationDocument } from "./document";
import { walkElements } from "./element";

/** Derived from canonical contents; shared by packages and library liveness. */
export function documentAssetIds(
  document: PresentationDocument,
  pageIds?: readonly string[],
): string[] {
  return [
    ...new Set(
      (pageIds
        ? pageIds.flatMap((id) => {
            const page = document.slides[id] ?? document.templates[id];
            return page ? [page] : [];
          })
        : [
            ...Object.values(document.slides),
            ...Object.values(document.templates),
          ]
      ).flatMap((page) =>
        walkElements(page.nodes.flatMap((root) => root.children)).flatMap(
          (element) =>
            element.content && "assetId" in element.content
              ? [element.content.assetId]
              : [],
        ),
      ),
    ),
  ].sort();
}
