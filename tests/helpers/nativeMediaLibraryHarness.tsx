import { createRoot } from "react-dom/client";
import { NativeMediaLibrary } from "../../src/components/NativeMediaLibrary";
import { platform } from "../../src/platform";
import type { LibraryBrowserEntry } from "../../src/core/libraryBrowser";
import { savedLibraryEffect } from "../../src/core/libraryEffects";
import { blankEffect } from "../../src/core/effectAuthoring";
import type { EffectDefinition } from "../../src/core/effects";
import "../../src/components/RightSidebar.css";

let inventoryChanged: (() => void) | undefined;
export const mediaLibraryRequests: number[] = [];
export const appliedLibraryEffects: EffectDefinition[] = [];
export const insertedLibraryAssets: string[] = [];
export const verifiedLibraryAssetRequests: string[] = [];
let completeRefresh: (() => void) | undefined;

export function notifyMediaInventoryChanged() {
  inventoryChanged?.();
}

export function finishMediaInventoryRefresh() {
  completeRefresh?.();
}

export function mountNativeMediaLibraryHarness({
  includeFolders = false,
  deferRefresh = true,
  rejectVerifiedAsset = false,
} = {}) {
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
  if (includeFolders) {
    entries[0].asset = {
      version: 1,
      id: "a".repeat(64),
      filename: "item-000.png",
      mediaType: "image",
      type: "image",
      mime: "image/png",
      names: ["item-000.png"],
      bytes: 1,
      width: 8,
      height: 8,
      createdAt: "2026-10-16T00:00:00.000Z",
    };
    entries.unshift(
      {
        path: "images/Brand Assets",
        name: "Brand Assets",
        category: "images",
        kind: "folder",
        managed: false,
      },
      {
        path: "images/Photos",
        name: "Photos",
        category: "images",
        kind: "folder",
        managed: false,
      },
      {
        path: "images/Brand Assets/Logos",
        name: "Logos",
        category: "images",
        kind: "folder",
        managed: false,
      },
      {
        path: "images/Brand Assets/Logos/Exports",
        name: "Exports",
        category: "images",
        kind: "folder",
        managed: false,
      },
    );
  }
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
  platform.getAsset = async (id) => {
    verifiedLibraryAssetRequests.push(id);
    if (rejectVerifiedAsset) throw new Error("Asset hash mismatch: managed file changed");
    const asset = entries.find(entry => entry.asset?.id === id)?.asset;
    if (!asset) throw new Error("Asset not found");
    return asset;
  };
  platform.libraryBrowser = async (request) => {
    if (request.type !== "list") return { entries: [], total: 0, folders: [] };
    mediaLibraryRequests.push(request.offset);
    if (deferRefresh && request.offset === 0 && firstPageLoaded) {
      await new Promise<void>((resolve) => {
        completeRefresh = resolve;
      });
      completeRefresh = undefined;
    }
    firstPageLoaded = true;
    const visibleEntries = includeFolders
      ? entries.filter(
          (entry) =>
            entry.path.split("/").slice(0, -1).join("/") ===
            `images${request.folder ? "/" + request.folder : ""}`,
        )
      : entries;
    return {
      entries:
        request.category === "Effects"
          ? effects
          : request.category === "images"
            ? visibleEntries.slice(
                request.offset,
                request.offset + request.limit,
              )
            : entries
                .slice(0, 6)
                .map((entry) => ({ ...entry, category: "video" })),
      total:
        request.category === "Effects"
          ? effects.length
          : request.category === "images"
            ? visibleEntries.length
            : 6,
      folders: includeFolders
        ? entries
            .filter((entry) => entry.kind === "folder")
            .map((entry) => entry.path)
        : [],
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
  if (includeFolders) host.className = "right-sidebar sidebar-primary";
  createRoot(host).render(
    <section
      className={includeFolders ? "asset-library" : undefined}
      style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}
    >
      <NativeMediaLibrary
        refresh={0}
        onInsert={(asset) => insertedLibraryAssets.push(asset.names[0])}
        onApplyEffect={(definition) => appliedLibraryEffects.push(definition)}
      />
    </section>,
  );
}
