import { patchTextContent, type TextContent } from "../../../src/core/text";
import { expect, it } from "vitest";
import path from "node:path";
import { storedDocument } from "../../helpers/storage";
import {
  setSlideNotes,
  insertElements,
} from "../../../src/core/editorCommands";
import { createTextElement } from "../../../src/core/text";
import { fontStorageService } from "../../../electron/fontIntegration";
import { nonPortableFontFamilies } from "../../../src/core/fonts";
import {
  librarySavePath,
  isInsideLibrary,
} from "../../../electron/libraryLifecycle";

it("Managed Library is the default and save format follows the separate presentations folder", async () => {
  const { storage, root } = await storedDocument();
  expect(storage.lifecycleMode).toBe("managed");
  const presentations = path.join(root, "presentations");
  const inside = path.join(presentations, "projects", "deck.smp");
  expect(isInsideLibrary(presentations, inside)).toBe(true);
  expect(librarySavePath(presentations, inside, false)).toBe(
    inside.replace(/\.smp$/, ".sme"),
  );
  expect(
    librarySavePath(presentations, path.join(root, "deck.sme"), false),
  ).toBe(path.join(root, "deck.smp"));
  expect(
    librarySavePath(
      presentations,
      path.join(storage.assetRoot, "deck.sme"),
      false,
    ),
  ).toBe(path.join(storage.assetRoot, "deck.smp"));
  expect(librarySavePath(presentations, inside, true)).toBe(inside);
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
