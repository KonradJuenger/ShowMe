import { expect, it } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { storedDocument, storageAt } from "../helpers/storage";
import { createMediaElement } from "../../src/core/media";
import { insertElements } from "../../src/core/editorCommands";
import { findElement } from "../../src/core/scene";

it("package transfers a media document and its original bytes to an empty library", async () => {
  const { root, storage, session, id } = await storedDocument();
  const bytes = await sharp({
    create: { width: 8, height: 4, channels: 4, background: "#339966" },
  })
    .png()
    .toBuffer();
  const image = path.join(root, "image.png");
  await writeFile(image, bytes);
  const imported = await storage.importFile(image);
  const metadata = await sharp(bytes).metadata();
  const asset = { ...imported, width: metadata.width, height: metadata.height };
  await storage.updateAsset(asset);
  const media = createMediaElement("media", asset);
  session.apply(
    insertElements(
      session.snapshot!,
      [media],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  const file = path.join(root, "Media.smp");
  await storage.packageDocument(id, file);
  const destination = await storageAt(root, "destination");
  const opened = await destination.openPackage(file);
  const document = destination.documentRuntime(opened.id).authority.document;
  expect(
    findElement(document.slides[document.deck.slideIds[0]], media.id)!.content,
  ).toMatchObject({ assetId: asset.id });
  expect(
    await readFile(destination.assetPathForDocument(opened.id, asset.id)),
  ).toEqual(bytes);
});
