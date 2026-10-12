import { expect, it } from "vitest";
import { DocumentAuthority } from "../../../src/core/documentAuthority";
import { newPresentationDocument } from "../../../src/core/document";
import { createTextElement, type TextContent } from "../../../src/core/text";
import { resolveTextTypography } from "../../../src/core/textTypography";
import type { DocumentOperation } from "../../../src/core/documentOperations";
import { editing } from "../../helpers/document";
import { insertElements } from "../../../src/core/editorCommands";
import {
  applyTextStyle,
  createTextStyleFromElement,
  setTextStyle,
} from "../../../src/core/textStyleCommands";

function fixture() {
  const document = newPresentationDocument("Authority Styles");
  const style = {
    id: "custom",
    name: "Custom",
    typography: { ...document.deck.textStyles[0].typography },
  };
  document.deck.textStyles.push(style);
  const slideId = document.deck.slideIds[0];
  const a = createTextElement("a");
  a.content = {
    ...(a.content as TextContent),
    autoSize: "none",
    format: { kind: "style", styleId: style.id, overrides: { fontSize: 90 } },
  };
  document.slides[slideId].nodes[0].children = [a];
  const owner = new DocumentAuthority(document);
  async function commit(
    actor: string,
    operations: DocumentOperation[],
    baseRevision = owner.revision,
  ) {
    const scopes = [
      { kind: "deck" as const },
      { kind: "element" as const, slideId, elementId: "a" },
    ];
    const acquired = owner.acquire(actor, scopes);
    if (acquired.denied) throw new Error("Lease denied");
    const leaseTokens = acquired.grants.map((g) => g.token);
    try {
      return await owner.commit(actor, {
        transactionId: crypto.randomUUID(),
        documentId: document.documentId,
        epoch: owner.epoch,
        baseRevision,
        leaseTokens,
        operations,
      });
    } finally {
      owner.release(actor, leaseTokens);
    }
  }
  return { document, style, slideId, a, owner, commit };
}

it("style deletion and appearance-preserving detachment undo and redo atomically", async () => {
  const { owner, style, slideId, a, commit } = fixture();
  const before = resolveTextTypography(
    owner.document.deck,
    a.content as TextContent,
  );
  await commit("A", [
    { type: "text-style.set", styleId: style.id, value: null },
  ]);
  const removed = owner.document.slides[slideId].nodes[0].children[0]
    .content as TextContent;
  expect(removed.format).toEqual({ kind: "local", typography: before });
  expect(owner.document.deck.textStyles).toHaveLength(2);
  await owner.undo("A");
  expect(owner.document.deck.textStyles).toHaveLength(3);
  expect(owner.document.slides[slideId].nodes[0].children[0].content).toEqual(
    a.content,
  );
  await owner.redo("A");
  expect(
    (owner.document.slides[slideId].nodes[0].children[0].content as TextContent)
      .format,
  ).toEqual(removed.format);
});

it("style updates undo normalized overrides as well as the shared definition", async () => {
  const { owner, style, slideId, commit } = fixture();
  await commit("A", [
    {
      type: "text-style.set",
      styleId: style.id,
      value: { ...style, typography: { ...style.typography, fontSize: 90 } },
    },
  ]);
  expect(
    (owner.document.slides[slideId].nodes[0].children[0].content as TextContent)
      .format,
  ).toMatchObject({ overrides: {} });
  await owner.undo("A");
  expect(owner.document.deck.textStyles.at(-1)).toEqual(style);
  expect(
    (owner.document.slides[slideId].nodes[0].children[0].content as TextContent)
      .format,
  ).toMatchObject({ overrides: { fontSize: 90 } });
  await owner.redo("A");
  expect(owner.document.deck.textStyles.at(-1)!.typography.fontSize).toBe(90);
});

it("rejects stale same-style writes and unsafe actor undo while unrelated definitions remain independent", async () => {
  const { owner, style, commit, document } = fixture();
  const changed = {
    ...style,
    typography: { ...style.typography, color: "#ff0000" },
  };
  await commit("A", [
    { type: "text-style.set", styleId: style.id, value: changed },
  ]);
  await expect(
    commit(
      "B",
      [{ type: "text-style.set", styleId: style.id, value: style }],
      0,
    ),
  ).rejects.toThrow("Stale");
  const other = document.deck.textStyles[1];
  await commit(
    "B",
    [
      {
        type: "text-style.set",
        styleId: other.id,
        value: {
          ...other,
          typography: { ...other.typography, color: "#0000ff" },
        },
      },
    ],
    0,
  );
  await commit("B", [
    {
      type: "text-style.set",
      styleId: style.id,
      value: { ...changed, name: "Renamed" },
    },
  ]);
  await expect(owner.undo("A")).rejects.toThrow("no longer safe");
  expect(owner.document.deck.textStyles.at(-1)!.name).toBe("Renamed");
});

it("does not undo through newer edits to a detached element's formatting", async () => {
  const { owner, style, slideId, commit } = fixture();
  await commit("A", [
    { type: "text-style.set", styleId: style.id, value: null },
  ]);
  const current = owner.document.slides[slideId].nodes[0].children[0]
    .content as TextContent;
  if (current.format.kind !== "local")
    throw new Error("Expected detached text");
  await commit("B", [
    {
      type: "elements.content.set",
      slideId,
      changes: [
        {
          elementId: "a",
          value: {
            ...current,
            format: {
              kind: "local",
              typography: { ...current.format.typography, color: "#0000ff" },
            },
          },
        },
      ],
    },
  ]);
  await expect(owner.undo("A")).rejects.toThrow("no longer safe");
});

it("requires measured frames for shared auto-size changes and preserves exact frames through undo and redo", async () => {
  const { document, style, slideId, a } = fixture();
  const original = a.content as TextContent;
  a.content = { ...original, autoSize: "height" };
  const owner = new DocumentAuthority(document);
  const edit: DocumentOperation = {
    type: "text-style.set",
    styleId: style.id,
    value: { ...style, typography: { ...style.typography, lineHeight: 2 } },
  };
  const acquired = owner.acquire("A", [
    { kind: "deck" },
    { kind: "element", slideId, elementId: "a" },
  ]);
  if (acquired.denied) throw new Error("Lease denied");
  const commit = (operation: DocumentOperation) =>
    owner.commit("A", {
      transactionId: crypto.randomUUID(),
      documentId: document.documentId,
      epoch: owner.epoch,
      baseRevision: owner.revision,
      leaseTokens: acquired.grants.map((g) => g.token),
      operations: [operation],
    });
  await expect(commit(edit)).rejects.toThrow("measured auto-size");
  const frame = { ...a.frame, height: 364 };
  await commit({
    ...edit,
    layouts: {
      [slideId]: {
        a: { expectedContent: a.content!, expectedFrame: a.frame, frame },
      },
    },
  });
  owner.release(
    "A",
    acquired.grants.map((g) => g.token),
  );
  expect(owner.document.slides[slideId].nodes[0].children[0].frame).toEqual(
    frame,
  );
  await owner.undo("A");
  expect(owner.document.slides[slideId].nodes[0].children[0].frame).toEqual(
    a.frame,
  );
  await owner.redo("A");
  expect(owner.document.slides[slideId].nodes[0].children[0].frame).toEqual(
    frame,
  );
});

it("EditorSession style creation and element style formatting use accepted history and durability", async () => {
  const durable: unknown[] = [];
  const { session, runtime } = await editing(async (...args) => {
    durable.push(args);
  });
  const element = createTextElement("a");
  session.apply(
    insertElements(
      session.snapshot!,
      [element],
      session.snapshot!.slide.nodes[0].id,
    ),
  );
  await session.flush();
  session.apply(
    createTextStyleFromElement(session.snapshot!, "a", "Custom", "custom"),
  );
  await session.flush();
  expect(runtime.authority.document.deck.textStyles).toHaveLength(3);
  expect(durable).toHaveLength(2);
  await session.undo();
  await session.flush();
  expect(runtime.authority.document.deck.textStyles).toHaveLength(2);
  await session.undo(true);
  await session.flush();
  expect(runtime.authority.document.deck.textStyles.at(-1)!.id).toBe("custom");
  session.apply(applyTextStyle(session.snapshot!, ["a"], null));
  await session.flush();
  await session.undo();
  await session.flush();
  const current = runtime.authority.document.slides[session.snapshot!.slide.id]
    .nodes[0].children[0].content as TextContent;
  expect(current.format).toEqual({
    kind: "style",
    styleId: "custom",
    overrides: {},
  });
  session.apply(
    setTextStyle(session.snapshot!, { styleId: "custom", value: null }),
  );
  await session.flush();
  expect(runtime.authority.document.deck.textStyles).toHaveLength(2);
});

it("deleting a style cannot convert text held by another actor's active editing lease", async () => {
  const { owner, style, slideId, document } = fixture();
  const peer = owner.acquire("B", [
    { kind: "element", slideId, elementId: "a" },
  ]);
  const acquired = owner.acquire("A", [{ kind: "deck" }]);
  if (peer.denied || acquired.denied) throw new Error("Lease denied");
  await expect(
    owner.commit("A", {
      transactionId: crypto.randomUUID(),
      documentId: document.documentId,
      epoch: owner.epoch,
      baseRevision: owner.revision,
      leaseTokens: acquired.grants.map((g) => g.token),
      operations: [{ type: "text-style.set", styleId: style.id, value: null }],
    }),
  ).rejects.toThrow("active collaborator lease");
  expect(owner.document.deck.textStyles.at(-1)!.id).toBe(style.id);
});
