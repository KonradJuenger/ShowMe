import { expect, it } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { storedDocument, storageAt } from "../../helpers/storage";
import {
  createTextElement,
  patchTextContent,
  updateText,
  type TextContent,
} from "../../../src/core/text";
import { insertElements } from "../../../src/core/editorCommands";
import {
  captureElementsClipboard,
  parseElementsClipboardText,
  serializeElementsClipboard,
} from "../../../src/core/clipboard";
import { RecoveryJournal } from "../../../electron/storage/recoveryJournal";
import { plainText } from "../../../src/core/textRuns";
import {
  readStoredZipFile,
  readArchiveEntry,
  writeStoredZipFile,
} from "../../../electron/packageArchive";
import {
  createSlideTransferBundle,
  parseSlideTransferBundle,
} from "../../../src/core/slideTransfer";

const runs = [
  { text: "Hello " },
  { text: "world", fontWeight: 700 },
  { text: "\nregular", fontWeight: 400 },
];
async function fixture() {
  const result = await storedDocument();
  const element = createTextElement("rich");
  element.content = patchTextContent(element.content as TextContent, { runs });
  result.session.apply(
    insertElements(
      result.session.snapshot!,
      [element],
      result.session.snapshot!.slide.nodes[0].id,
    ),
  );
  await result.session.flush();
  return result;
}

it("preserves rich text across native save, package open and cold durable recovery", async () => {
  const { storage, root, session, id } = await fixture();
  const slideId = session.snapshot!.slide.id;
  const file = path.join(root, "Rich.sme"),
    packaged = path.join(root, "Rich.smp");
  await storage.saveDocument(id, file);
  const reader = await storageAt(root, "reader"),
    opened = await reader.openDocument(file);
  const content = reader.documentRuntime(opened.id).authority.document.slides[
    slideId
  ].nodes[0].children[0].content as TextContent;
  expect(content.runs).toEqual(runs);
  expect(content).not.toHaveProperty("text");
  await storage.packageDocument(id, packaged);
  const other = await storageAt(root, "package-reader"),
    unpacked = await other.openPackage(packaged);
  expect(
    (
      other.documentRuntime(unpacked.id).authority.document.slides[slideId]
        .nodes[0].children[0].content as TextContent
    ).runs,
  ).toEqual(runs);
  session.apply(
    updateText(session.snapshot!, "rich", { runs: [...runs, { text: "!" }] }),
  );
  await session.flush();
  const cold = await storageAt(root),
    recovered = await cold.openDocument(file, "recover");
  expect(
    (
      cold.documentRuntime(recovered.id).authority.document.slides[slideId]
        .nodes[0].children[0].content as TextContent
    ).runs,
  ).toEqual([...runs, { text: "!" }]);
});

it("round trips rich element clipboard content and upgrades the supported v1 clipboard", async () => {
  const { session } = await fixture();
  const payload = captureElementsClipboard(session.snapshot!, {
    scopeId: session.snapshot!.slide.nodes[0].id,
    elementIds: ["rich"],
  })!;
  expect(
    parseElementsClipboardText(serializeElementsClipboard(payload)),
  ).toEqual(payload);
  const old = JSON.parse(JSON.stringify(payload));
  old.version = 1;
  const content = old.roots[0].element.content;
  content.text = plainText(content);
  delete content.runs;
  const upgraded = parseElementsClipboardText(
    "show-me-elements:v1:" + JSON.stringify(old),
  );
  expect((upgraded!.roots[0].element.content as TextContent).runs).toEqual([
    { text: "Hello world\nregular" },
  ]);
  content.runs = [];
  expect(
    parseElementsClipboardText("show-me-elements:v1:" + JSON.stringify(old)),
  ).toBeNull();
});

function downgrade(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(downgrade);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const result = Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, downgrade(item)]),
  );
  if (object.type === "text" && "runs" in object) {
    result.text = plainText(object as unknown as TextContent);
    delete result.runs;
  }
  if (
    object.version === 2 &&
    (object.kind === "showme-presentation" ||
      "nodes" in object ||
      "slideIds" in object)
  )
    result.version = 1;
  return result;
}

it("replays v1 text operations after a v1 recovery checkpoint and checkpoints before current appends", async () => {
  const { root, session, id, runtime } = await fixture();
  const recoveryPath = path.join(
    root,
    "source",
    "recovery",
    id + ".recovery.sme",
  );
  const checkpointPath = path.join(recoveryPath, "checkpoint.json"),
    recordsPath = path.join(recoveryPath, "transactions.jsonl");
  await writeFile(
    checkpointPath,
    JSON.stringify(
      downgrade(JSON.parse(await readFile(checkpointPath, "utf8"))),
    ),
  );
  const records = (await readFile(recordsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => downgrade(JSON.parse(line)));
  await writeFile(
    recordsPath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const journal = new RecoveryJournal();
  const handle = {
    documentId: id,
    fileRevision: null,
    recoveryPath,
    epoch: runtime.authority.epoch,
    revision: runtime.authority.revision,
    savedRevision: runtime.authority.savedRevision,
    filePath: null,
  };
  const base = runtime.authority.document;
  const recovered = await journal.read(handle, base);
  expect(
    (
      recovered.document.slides[session.snapshot!.slide.id].nodes[0].children[0]
        .content as TextContent
    ).runs,
  ).toEqual([{ text: "Hello world\nregular" }]);
  expect(recovered.upgraded).toBe(true);
  const accepted = {
    documentId: id,
    epoch: handle.epoch,
    revision: handle.revision + 1,
    actorId: "local",
    transactionId: crypto.randomUUID(),
    operations: [
      {
        type: "elements.content.set" as const,
        slideId: session.snapshot!.slide.id,
        changes: [
          {
            elementId: "rich",
            value: patchTextContent(
              recovered.document.slides[session.snapshot!.slide.id].nodes[0]
                .children[0].content as TextContent,
              { runs },
            ),
          },
        ],
      },
    ],
  };
  await journal.append(
    handle,
    {
      ...accepted,
      inverseOperations: [
        {
          type: "elements.content.set",
          slideId: session.snapshot!.slide.id,
          changes: [
            {
              elementId: "rich",
              value:
                recovered.document.slides[session.snapshot!.slide.id].nodes[0]
                  .children[0].content!,
            },
          ],
        },
      ],
    },
    recovered.document,
  );
  const after = await journal.read(handle, base);
  expect(after.upgraded).toBe(false);
  expect(
    (
      after.document.slides[session.snapshot!.slide.id].nodes[0].children[0]
        .content as TextContent
    ).runs,
  ).toEqual(runs);
});

it("upgrades supported v1 files, packages and slide transfers without accepting malformed current payloads", async () => {
  const { root, storage, id, runtime } = await fixture();
  const current = runtime.authority.document;
  const file = path.join(root, "Old.sme"),
    packaged = path.join(root, "Old.smp");
  await writeFile(file, JSON.stringify(downgrade(current)));
  const reader = await storageAt(root, "v1-reader"),
    opened = await reader.openDocument(file);
  expect(
    (
      reader.documentRuntime(opened.id).authority.document.slides[
        current.deck.slideIds[0]
      ].nodes[0].children[0].content as TextContent
    ).runs,
  ).toEqual([{ text: "Hello world\nregular" }]);
  const source = await storage.packageDocument(
    id,
    path.join(root, "Current.smp"),
  );
  const archive = await readStoredZipFile(source);
  try {
    const entries = await Promise.all(
      [...archive.entries].map(async ([name, entry]) => {
        let data: Buffer | string = await readArchiveEntry(entry);
        if (name === "manifest.json") {
          const manifest = JSON.parse(data.toString());
          manifest.documentVersion = 1;
          data = JSON.stringify(manifest);
        }
        if (name === "document/presentation.sme")
          data = JSON.stringify(downgrade(JSON.parse(data.toString())));
        return { name, data };
      }),
    );
    await writeStoredZipFile(packaged, entries);
  } finally {
    await archive.dispose();
  }
  const packageReader = await storageAt(root, "v1-package-reader"),
    unpacked = await packageReader.openPackage(packaged);
  expect(
    (
      packageReader.documentRuntime(unpacked.id).authority.document.slides[
        current.deck.slideIds[0]
      ].nodes[0].children[0].content as TextContent
    ).runs,
  ).toEqual([{ text: "Hello world\nregular" }]);
  const bundle = createSlideTransferBundle(
    id,
    current.deck,
    Object.values(current.slides),
    current.templates,
  );
  const old = downgrade(bundle) as Record<string, unknown>;
  old.version = 1;
  const transfer = parseSlideTransferBundle(old);
  expect(
    (
      transfer.slides[0].resolvedSlide.nodes[0].children[0]
        .content as TextContent
    ).runs,
  ).toEqual([{ text: "Hello world\nregular" }]);
  expect(() =>
    parseSlideTransferBundle({
      ...bundle,
      slides: [
        {
          ...bundle.slides[0],
          slide: { ...bundle.slides[0].slide, version: 1 },
        },
      ],
    }),
  ).toThrow();
});
