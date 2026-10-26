import { parsePowerPoint } from "../core/powerpointImport";
import { createPowerPointSlides } from "../core/powerpointImportCommands";
import { prepareMediaAsset } from "./mediaEnrichment";
import { EditorSession } from "../core/editorSession";
import { editorTransport } from "../platform/editorTransport";
import { platform } from "../platform";

export async function importPowerPointPresentation(file: File) {
  const imported = await parsePowerPoint(file);
  const media = imported.flatMap((slide) => slide.media);
  const files = media.map(
    (image) =>
      new File([new Uint8Array(image.bytes).buffer], image.name, {
        type: image.mimeType,
      }),
  );
  const document = await platform.createDocument(
    file.name.replace(/\.pptx$/i, "").slice(0, 200) || "Imported PowerPoint",
  );
  if (!document) return null;
  try {
    const assets = files.length ? await platform.importDroppedFiles(files) : [];
    const prepared = await Promise.all(assets.map(prepareMediaAsset));
    if (prepared.length !== media.length)
      throw new Error("Could not import all media from the PowerPoint file");
    // The editor mounts only after this session finishes. Both use the same
    // transport/authority and durable transaction path.
    const session = new EditorSession(document.id, editorTransport(platform));
    try {
      await session.loadProjection();
      const blankId = session.snapshot!.slide.id;
      let afterId = blankId;
      let assetIndex = 0;
      session.beginHistoryGroup();
      // Respect the current transaction operation limit without limiting deck size.
      for (let index = 0; index < imported.length; index += 128) {
        const chunk = imported.slice(index, index + 128);
        const count = chunk.reduce((sum, slide) => sum + slide.media.length, 0);
        const result = createPowerPointSlides(
          session.snapshot!,
          chunk,
          prepared.slice(assetIndex, assetIndex + count),
          afterId,
          index === 0,
        );
        assetIndex += count;
        afterId = result.lastSlideId;
        session.apply(result.snapshot);
        await session.flush();
        if (session.lastError) throw session.lastError;
      }
      return {
        document,
        warnings: [...new Set(imported.flatMap((slide) => slide.warnings))],
      };
    } finally {
      try {
        await session.endHistoryGroup();
      } finally {
        session.dispose();
      }
    }
  } catch (error) {
    await platform.closeDocument?.(document.id);
    throw error;
  }
}
