import type { Platform, SystemFontFamily } from "./api";
import {
  collectSystemFontFamilies,
  fallbackSystemFonts,
  mergeSystemFontFamilies,
  type LocalFontFace,
} from "./systemFonts";

// Electron never imports the browser adapter, which creates a development-only IndexedDB.
const adapter: Platform = window.desktop ?? (await import("./browser")).browser;

type QueryLocalFonts = () => Promise<LocalFontFace[]>;

let systemFontsPromise: Promise<SystemFontFamily[]> | null = null;
let managedFontsPromise: Promise<SystemFontFamily[]> | null = null;
let managedFontDocumentId: string | undefined;
const loadedManagedFonts = new Set<string>();
const installedManagedFaces = new Set<FontFace>();

async function installManagedFonts(
  families: SystemFontFamily[],
  scope = managedFontDocumentId,
) {
  if (typeof FontFace === "undefined" || !document.fonts) return;
  for (const family of families) {
    for (const source of family.sources ?? []) {
      const key = `${source.id}:${family.family}:${source.weight}:${source.italic ? 1 : 0}`;
      if (loadedManagedFonts.has(key)) continue;
      try {
        const bytes = Uint8Array.from(source.data);
        const face = new FontFace(family.family, bytes.buffer, {
          weight: String(source.weight),
          style: source.italic ? "italic" : "normal",
        });
        await face.load();
        if (scope !== managedFontDocumentId) return;
        document.fonts.add(face);
        installedManagedFaces.add(face);
        loadedManagedFonts.add(key);
      } catch (error) {
        console.warn(`Could not load managed font ${family.family}`, error);
      }
    }
  }
}

function loadManagedFonts(documentId = managedFontDocumentId) {
  if (!window.desktop?.managedFonts)
    return Promise.resolve([] as SystemFontFamily[]);
  if (documentId !== managedFontDocumentId) {
    for (const face of installedManagedFaces) document.fonts.delete(face);
    installedManagedFaces.clear();
    loadedManagedFonts.clear();
    managedFontsPromise = null;
    systemFontsPromise = null;
    managedFontDocumentId = documentId;
  }
  if (managedFontsPromise) return managedFontsPromise;
  managedFontsPromise = window.desktop
    .managedFonts(documentId)
    .then(async (families) => {
      await installManagedFonts(families, documentId);
      return families;
    })
    .catch((error) => {
      managedFontsPromise = null;
      console.warn("Could not load managed fonts", error);
      return [];
    });
  return managedFontsPromise;
}

function loadSystemFonts() {
  if (systemFontsPromise) return systemFontsPromise;
  systemFontsPromise = (async () => {
    const managedPromise = loadManagedFonts();
    const queryLocalFonts = (
      window as typeof window & { queryLocalFonts?: QueryLocalFonts }
    ).queryLocalFonts;

    let systemFamilies: SystemFontFamily[] = [];
    if (typeof queryLocalFonts === "function") {
      try {
        systemFamilies = collectSystemFontFamilies(
          await queryLocalFonts.call(window),
        );
      } catch (error) {
        console.warn("Could not enumerate installed fonts", error);
      }
    }

    const managedFamilies = await managedPromise;
    return mergeSystemFontFamilies(
      systemFamilies.length ? systemFamilies : fallbackSystemFonts,
      managedFamilies,
    );
  })();
  return systemFontsPromise;
}

async function refreshManagedFonts() {
  managedFontsPromise = null;
  systemFontsPromise = null;
  return loadManagedFonts();
}

export const platform: Platform = {
  ...adapter,
  managedFonts: loadManagedFonts,
  async renderProjection(documentId, slideId) {
    const projection = await adapter.renderProjection!(documentId, slideId);
    await loadManagedFonts(documentId);
    return projection;
  },
  async documentProjection(documentId, slideId) {
    const projection = await adapter.documentProjection!(documentId, slideId);
    await loadManagedFonts(documentId);
    return projection;
  },
  systemFonts: loadSystemFonts,
  async chooseMediaLibrary() {
    const result = await adapter.chooseMediaLibrary();
    if (result) await refreshManagedFonts();
    return result;
  },
  async resetMediaLibrary() {
    const result = await adapter.resetMediaLibrary();
    await refreshManagedFonts();
    return result;
  },
  async openDocument() {
    const result = await adapter.openDocument();
    if (result && window.desktop) await refreshManagedFonts();
    return result;
  },
};

// Managed Library fonts must be available to the editor and presenter even if the OS
// does not have them installed. Installed system fonts are enumerated only when the
// editor opens the font picker, preserving Local Font Access user activation.
if (window.desktop) {
  void loadManagedFonts();
  adapter.onFontInventoryChanged?.(() => {
    void refreshManagedFonts().catch((error) =>
      console.error("Library font refresh failed", error),
    );
  });
  adapter.onImageReadiness?.((status) => {
    if (status === null)
      void refreshManagedFonts().catch((error) =>
        console.error("Library font refresh failed", error),
      );
  });
}

if (!new URLSearchParams(window.location.search).has("present"))
  void import("../components/fontPickerRuntime").then(
    ({ installFontPickerRuntime }) => installFontPickerRuntime(loadSystemFonts),
  );
