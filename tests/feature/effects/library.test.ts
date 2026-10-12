import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { EffectLibraryStorage } from "../../../electron/effectLibrary";
import { blankEffect } from "../../../src/core/effectAuthoring";
import {
  libraryEffectFilename,
  libraryEffectSchema,
  savedLibraryEffect,
  editEffectLibrary,
} from "../../../src/core/libraryEffects";
import { storedDocument } from "../../helpers/storage";

it("text effect filenames retain ShowMe names, sanitize paths and use a stable identity hash", () => {
  const asset = savedLibraryEffect({
    ...blankEffect("css-js"),
    name: "Moving Glass",
  });
  const filename = libraryEffectFilename(asset);
  expect(filename).toMatch(/^Moving Glass-[a-f0-9]{8}\.txt$/);
  const renamed = savedLibraryEffect(
    { ...asset.definition, name: "../Glass: glow?" },
    asset,
  );
  expect(libraryEffectFilename(renamed).split("-").at(-1)).toBe(
    filename.split("-").at(-1),
  );
  expect(libraryEffectFilename(renamed)).not.toMatch(/[<>:"/\\|?*]/);
  expect(
    [...libraryEffectFilename(renamed)].every(
      (character) => character.charCodeAt(0) >= 32,
    ),
  ).toBe(true);
  expect(libraryEffectSchema.safeParse({ ...asset, version: 2 }).success).toBe(
    false,
  );
});

it("desktop save, edit, rename, move and delete use one named text file with stable identity", async () => {
  const { root } = await storedDocument();
  const directory = path.join(root, "effects");
  const storage = new EffectLibraryStorage(directory);
  const first = (
    await storage.run({
      type: "save",
      definition: { ...blankEffect("css-js"), name: "Soft Glow" },
    })
  ).entries[0].asset;
  const file = path.join(directory, libraryEffectFilename(first));
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(first);
  const edited = (
    await storage.run({
      type: "save",
      id: first.id,
      revision: first.revision,
      definition: {
        ...first.definition,
        name: "Bright Glow",
        source: ":scope { opacity: 0.8; }",
      },
    })
  ).entries[0].asset;
  expect(edited.id).toBe(first.id);
  expect(edited.revision).toBe(2);
  expect(await fs.readdir(directory)).toEqual([libraryEffectFilename(edited)]);
  expect(
    JSON.parse(await fs.readFile(await storage.file(edited.id), "utf8")),
  ).toEqual(edited);
  await storage.run({
    type: "move",
    id: edited.id,
    revision: edited.revision,
    folder: "Favorites/Glow",
  });
  const reopened = new EffectLibraryStorage(directory);
  expect((await reopened.list()).entries).toEqual([
    { asset: edited, folder: "Favorites/Glow" },
  ]);
  expect(await reopened.file(edited.id)).toBe(
    path.join(directory, "Favorites/Glow", libraryEffectFilename(edited)),
  );
  expect(
    (
      await reopened.run({
        type: "delete",
        id: edited.id,
        revision: edited.revision,
      })
    ).entries,
  ).toEqual([]);
  expect(await fs.readdir(path.join(directory, "Favorites/Glow"))).toEqual([]);
});

it("same-name effects stay independent, duplicates receive new identities and stale mutations fail", async () => {
  const { root } = await storedDocument();
  const storage = new EffectLibraryStorage(path.join(root, "effects"));
  const definition = { ...blankEffect("css-js"), name: "Glow" };
  await storage.run({ type: "save", definition });
  const library = await storage.run({ type: "save", definition });
  const [first, second] = library.entries.map((entry) => entry.asset);
  expect(first.id).not.toBe(second.id);
  expect(libraryEffectFilename(first)).not.toBe(libraryEffectFilename(second));
  await storage.run({
    type: "save",
    id: first.id,
    revision: first.revision,
    definition,
  });
  await expect(
    storage.run({ type: "delete", id: first.id, revision: first.revision }),
  ).rejects.toThrow("changed");
  expect((await storage.list()).entries).toHaveLength(2);
  expect(
    editEffectLibrary(library, {
      type: "delete",
      id: second.id,
      revision: second.revision,
    }).entries,
  ).toHaveLength(1);
});

it("failed writes retain the previous effect and release the lock for subsequent edits", async () => {
  const { root } = await storedDocument();
  const directory = path.join(root, "effects");
  const storage = new EffectLibraryStorage(directory);
  const asset = (
    await storage.run({ type: "save", definition: blankEffect("css-js") })
  ).entries[0].asset;
  const failing = new EffectLibraryStorage(directory, async () => {
    throw new Error("Disk full");
  });
  await expect(
    failing.run({
      type: "save",
      id: asset.id,
      revision: asset.revision,
      definition: { ...asset.definition, name: "Changed" },
    }),
  ).rejects.toThrow("Disk full");
  expect((await storage.list()).entries[0].asset).toEqual(asset);
  await storage.run({ type: "delete", id: asset.id, revision: asset.revision });
  expect(await fs.readdir(directory)).toEqual([]);
});

it("desktop library ignores disposable old effect files and refuses invalid folders", async () => {
  const { root } = await storedDocument();
  const directory = path.join(root, "effects");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "old.effect"),
    "not a supported file",
  );
  const storage = new EffectLibraryStorage(directory);
  expect((await storage.list()).entries).toEqual([]);
  await expect(
    storage.run({ type: "folder", folder: "../outside" }),
  ).rejects.toThrow();
  await expect(
    storage.run({ type: "folder", folder: "CON" }),
  ).rejects.toThrow();
});
