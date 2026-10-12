import { expect, it } from "vitest";
import path from "node:path";
import { storedDocument, storageAt } from "../../helpers/storage";
import { createTextElement, type TextContent } from "../../../src/core/text";
import { insertElements } from "../../../src/core/editorCommands";
import {
  applyTextStyle,
  setTextStyle,
} from "../../../src/core/textStyleCommands";
import { resolveTextTypography } from "../../../src/core/textTypography";

it("style definitions and overrides survive native package open and cold durable recovery with inherited font warnings", async () => {
  const { storage, root, session, id, runtime } = await storedDocument();
  const heading = session.snapshot!.deck.textStyles[0];
  session.apply(
    insertElements(
      session.snapshot!,
      [createTextElement("a")],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  session.apply(
    applyTextStyle(
      setTextStyle(session.snapshot!, {
        styleId: heading.id,
        value: {
          ...heading,
          typography: {
            ...heading.typography,
            fontFamily: "Missing Style Face",
            fontSize: 80,
          },
        },
      }),
      ["a"],
      heading.id,
    ),
  );
  await session.flush();
  expect(storage.packageFontWarnings(id)).toEqual(["Missing Style Face"]);
  const packagePath = await storage.packageDocument(
    id,
    path.join(root, "styled.smp"),
  );
  const opened = await storage.openPackage(packagePath);
  const roundtrip = storage.documentRuntime(opened.id).authority.document;
  expect(roundtrip.deck.textStyles).toEqual(
    runtime.authority.document.deck.textStyles,
  );
  const content = Object.values(roundtrip.slides)[0].nodes[0].children[0]
    .content as TextContent;
  expect(resolveTextTypography(roundtrip.deck, content)).toMatchObject({
    fontSize: 80,
    fontFamily: "Missing Style Face",
  });
  const cold = await storageAt(root);
  const recovered = await cold.recoverUntitled(id);
  const recovery = cold.documentRuntime(recovered.id).authority.document;
  expect(recovery.deck.textStyles).toEqual(
    runtime.authority.document.deck.textStyles,
  );
  expect(
    Object.values(recovery.slides)[0].nodes[0].children[0].content,
  ).toEqual(content);
});
