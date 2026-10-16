import { patchTextContent, type TextContent } from "../../../src/core/text";
import { expect, it } from "vitest";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { storedDocument } from "../../helpers/storage";
import {
  setSlideNotes,
  insertElements,
} from "../../../src/core/editorCommands";
import { createTextElement } from "../../../src/core/text";
import { createMediaElement } from "../../../src/core/media";
import { fontStorageService } from "../../../electron/fontIntegration";
import { nonPortableFontFamilies } from "../../../src/core/fonts";
import {
  librarySavePath,
  isInsideRoot,
} from "../../../electron/libraryLifecycle";

it("Managed Library keeps explicit portable saves and redirects only unsafe native saves", async () => {
  const { storage, root } = await storedDocument();
  expect(storage.lifecycleMode).toBe("managed");
  const showMeRoot = path.join(root, "Studio Shared");
  const inside = path.join(showMeRoot, "projects", "deep", "deck.smp");
  const outside = path.join(root, "external", "deck.sme");
  expect(isInsideRoot(showMeRoot, inside)).toBe(true);
  expect(isInsideRoot(showMeRoot, outside)).toBe(false);
  expect(librarySavePath(showMeRoot, inside, false)).toBe(inside);
  expect(librarySavePath(showMeRoot, outside, false)).toBe(
    outside.replace(/\.sme$/, ".smp"),
  );
  expect(librarySavePath(showMeRoot, inside, true)).toBe(inside);
  expect(
    librarySavePath(
      showMeRoot,
      path.join(showMeRoot, "projects", "deck.sme"),
      false,
    ),
  ).toBe(path.join(showMeRoot, "projects", "deck.sme"));
});

it("packages include notes by default and removal affects only the shared snapshot", async () => {
  const { storage, root, session, id } = await storedDocument();
  session.apply(setSlideNotes(session.snapshot!, "Private notes"));
  await session.flush();
  const full = await storage.packageDocument(id, path.join(root, "full.smp"));
  const stripped = await storage.packageDocument(
    id,
    path.join(root, "stripped.smp"),
    false,
    true,
  );
  const a = await storage.openPackage(full);
  const b = await storage.openPackage(stripped);
  expect(
    Object.values(storage.documentRuntime(a.id).authority.document.slides)[0]
      .notes,
  ).toBe("Private notes");
  expect(
    Object.values(storage.documentRuntime(b.id).authority.document.slides)[0]
      .notes,
  ).toBe("");
  expect(session.snapshot!.slide.notes).toBe("Private notes");
});

it("font portability warns for non-safe unbundled faces and normal packaging does not require local font files", async () => {
  expect(
    nonPortableFontFamilies([
      { family: "Arial", weight: 400, italic: false },
      { family: "Times New Roman", weight: 400, italic: false },
      { family: "Courier New", weight: 400, italic: false },
      { family: "Missing Face", weight: 400, italic: false },
    ]),
  ).toEqual(["Missing Face"]);
  expect(
    nonPortableFontFamilies(
      [{ family: "Bundled", weight: 400, italic: false }],
      [{ family: "Bundled", weight: 400, italic: false }],
    ),
  ).toEqual([]);
  const { storage, root, session, id } = await storedDocument();
  const text = createTextElement("portable-text");
  text.content = patchTextContent(text.content as TextContent, {
    fontFamily: "Missing Face",
  });
  session.apply(
    insertElements(
      session.snapshot!,
      [text],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  storage.fonts = fontStorageService;
  expect(storage.packageFontWarnings(id)).toEqual(["Missing Face"]);
  await expect(
    storage.packageDocument(id, path.join(root, "missing-font.smp")),
  ).resolves.toBeTruthy();
});

import {
  readArchiveEntry,
  readStoredZipFile,
} from "../../../electron/packageArchive";
import {
  parsePackageManifest,
  parsePackagedAssetMetadata,
} from "../../../src/core/package";
import {
  libraryIndex,
  managedFilename,
} from "../../../electron/mediaLibrary";
import { setLibraryProtection } from "../../../electron/libraryProtection";
import { hashFile } from "../../../electron/storage/io";

it("packages flatten nested Library media and strip cleanup protection metadata", async () => {
  const { storage, root, session, id } = await storedDocument();
  const imageSource = path.join(root, "reference.png");
  const videoSource = path.join(root, "clip.mp4");
  await writeFile(imageSource, Buffer.from("nested image payload"));
  await writeFile(videoSource, Buffer.from("nested video payload"));

  const image = {
    ...(await storage.importFile(imageSource, "project-a/reference")),
    width: 80,
    height: 60,
  };
  const video = {
    ...(await storage.importFile(videoSource, "project-b/clips")),
    width: 160,
    height: 90,
    duration: 1,
  };
  await storage.updateAsset(image);
  await storage.updateAsset(video);

  session.apply(
    insertElements(
      session.snapshot!,
      [
        createMediaElement("nested-image", image),
        createMediaElement("nested-video", video),
      ],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();

  await setLibraryProtection(
    storage.assetRoot,
    `images/project-a/reference/${image.filename}`,
    true,
  );
  await libraryIndex(storage.assetRoot)!.refresh();

  const imageFilename = managedFilename("reference.png", image.id);
  const videoFilename = managedFilename("clip.mp4", video.id);
  const file = await storage.packageDocument(
    id,
    path.join(root, "flattened.smp"),
  );
  const archive = await readStoredZipFile(file);
  try {
    const manifestEntry = archive.entries.get("manifest.json");
    expect(manifestEntry).toBeDefined();
    const manifest = parsePackageManifest(
      JSON.parse(
        (await readArchiveEntry(manifestEntry!)).toString("utf8"),
      ),
    );
    const names = [...archive.entries.keys()];
    expect(names).toContain(`images/${imageFilename}`);
    expect(names).toContain(`video/${videoFilename}`);
    expect(
      names.some(
        (name) =>
          name.includes("project-a/") ||
          name.includes("reference/") ||
          name.includes("project-b/") ||
          name.includes("clips/"),
      ),
    ).toBe(false);
    expect(names.some((name) => name.includes("~p"))).toBe(false);

    const imageManifest = manifest.assets.find((item) => item.id === image.id)!;
    const videoManifest = manifest.assets.find((item) => item.id === video.id)!;
    expect(imageManifest.originalPath).toBe(`images/${imageFilename}`);
    expect(videoManifest.originalPath).toBe(`video/${videoFilename}`);

    const imageMetadata = parsePackagedAssetMetadata(
      JSON.parse(
        (
          await readArchiveEntry(
            archive.entries.get(imageManifest.metadataPath)!,
          )
        ).toString("utf8"),
      ),
    );
    const videoMetadata = parsePackagedAssetMetadata(
      JSON.parse(
        (
          await readArchiveEntry(
            archive.entries.get(videoManifest.metadataPath)!,
          )
        ).toString("utf8"),
      ),
    );
    expect(imageMetadata).toMatchObject({
      id: image.id,
      filename: imageFilename,
      mediaType: "image",
    });
    expect(videoMetadata).toMatchObject({
      id: video.id,
      filename: videoFilename,
      mediaType: "video",
    });
    expect(
      await hashFile(archive.entries.get(imageManifest.originalPath)!.file),
    ).toBe(image.id);
    expect(
      await hashFile(archive.entries.get(videoManifest.originalPath)!.file),
    ).toBe(video.id);
  } finally {
    await archive.dispose();
  }

  await expect(storage.openPackage(file)).resolves.toMatchObject({
    location: path.resolve(file),
  });
});
