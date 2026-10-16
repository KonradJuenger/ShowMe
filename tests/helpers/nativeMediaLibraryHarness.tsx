import { createRoot } from "react-dom/client";
import { NativeMediaLibrary } from "../../src/components/NativeMediaLibrary";
import { platform } from "../../src/platform";
import type { LibraryBrowserEntry } from "../../src/core/libraryBrowser";
import { savedLibraryEffect } from "../../src/core/libraryEffects";
import { blankEffect } from "../../src/core/effectAuthoring";
import type { EffectDefinition } from "../../src/core/effects";

let inventoryChanged: (() => void) | undefined;
export const mediaLibraryRequests: number[] = [];
export const appliedLibraryEffects: EffectDefinition[] = [];
let completeRefresh: (() => void) | undefined;

export function notifyMediaInventoryChanged() {
  inventoryChanged?.();
}

export function finishMediaInventoryRefresh() {
  completeRefresh?.();
}

export function mountNativeMediaLibraryHarness() {
  const entries: LibraryBrowserEntry[] = Array.from(
    { length: 360 },
    (_, index) => ({
      path: `images/item-${String(index).padStart(3, "0")}.png`,
      name: `item-${String(index).padStart(3, "0")}.png`,
      category: "images",
      kind: "file",
      managed: false,
    }),
  );
  const effect = savedLibraryEffect({
    ...blankEffect("css-js"),
    name: "Library Glow",
  });
  const effects: LibraryBrowserEntry[] = [
    {
      path: "Effects/glow.txt",
      name: effect.definition.name,
      category: "Effects",
      kind: "file",
      managed: true,
      effect,
    },
    {
      path: "Effects/broken.txt",
      name: "broken.txt",
      category: "Effects",
      kind: "file",
      managed: false,
    },
  ];
  let firstPageLoaded = false;
  platform.libraryBrowser = async (request) => {
    if (request.type !== "list") return { entries: [], total: 0, folders: [] };
    mediaLibraryRequests.push(request.offset);
    if (request.offset === 0 && firstPageLoaded) {
      await new Promise<void>((resolve) => {
        completeRefresh = resolve;
      });
      completeRefresh = undefined;
    }
    firstPageLoaded = true;
    return {
      entries:
        request.category === "Effects"
          ? effects
          : request.category === "images"
            ? entries.slice(request.offset, request.offset + request.limit)
            : entries
                .slice(0, 6)
                .map((entry) => ({ ...entry, category: "audio" })),
      total:
        request.category === "Effects"
          ? effects.length
          : request.category === "images"
            ? entries.length
            : 6,
      folders: [],
    };
  };
  platform.onMediaInventoryChanged = (listener) => {
    inventoryChanged = listener;
    return () => {
      inventoryChanged = undefined;
    };
  };
  const host = document.createElement("section");
  host.setAttribute("aria-label", "Media scroll test");
  host.style.cssText =
    "position:fixed;inset:0 auto auto 0;width:320px;height:560px;display:flex;background:white;z-index:10000";
  document.body.append(host);
  createRoot(host).render(
    <NativeMediaLibrary
      refresh={0}
      onInsert={() => {}}
      onApplyEffect={(definition) => appliedLibraryEffects.push(definition)}
    />,
  );
}
