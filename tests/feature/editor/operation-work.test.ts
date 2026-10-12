import { slideSchema } from "../../../src/core/document";
import {
  applyValidatedDocumentOperations,
  type DocumentOperation,
} from "../../../src/core/documentOperations";
import { createTextElement, type TextContent } from "../../../src/core/text";
import { expect, it, vi } from "vitest";
import { DocumentAuthority } from "../../../src/core/documentAuthority";
import {
  newPresentationDocument,
  presentationDocumentSchema,
} from "../../../src/core/document";
import { applyDocumentOperations } from "../../../src/core/documentOperations";
import { createBasicShape } from "../../../src/core/elementFactory";

it("authority evaluates a structural multi-operation transaction once with scoped page validation", async () => {
  const document = newPresentationDocument("Work");
  const slideId = document.deck.slideIds[0];
  const authority = new DocumentAuthority(document);
  const grants = authority.acquire("local", [
    { kind: "structure", slideId, parentId: document.deck.layers[0].id },
    { kind: "element", slideId, elementId: "shape" },
  ]);
  if (grants.denied) throw new Error("Lease denied");
  const shape = createBasicShape("shape", "rectangle");
  const validation = vi.spyOn(presentationDocumentSchema, "parse");
  try {
    await authority.commit("local", {
      transactionId: "insert-move",
      documentId: document.documentId,
      epoch: authority.epoch,
      baseRevision: 0,
      leaseTokens: grants.grants.map((g) => g.token),
      operations: [
        {
          type: "elements.insert",
          slideId,
          parentId: document.deck.layers[0].id,
          elements: [shape],
        },
        {
          type: "elements.frame.set",
          slideId,
          changes: [{ elementId: shape.id, value: { ...shape.frame, x: 50 } }],
        },
      ],
    });
    expect(validation).not.toHaveBeenCalled();
    expect(
      authority.document.slides[slideId].nodes[0].children[0].frame.x,
    ).toBe(50);
  } finally {
    validation.mockRestore();
  }
  await authority.undo("local");
  expect(authority.document.slides[slideId].nodes[0].children).toEqual([]);
});

it("canonical replay visits one evolving candidate and rejects without partial publication", () => {
  const document = newPresentationDocument("Work");
  const slideId = document.deck.slideIds[0];
  const states: string[] = [];
  const next = applyDocumentOperations(
    document,
    [
      { type: "slide.notes.set", slideId, notes: "one" },
      { type: "slide.notes.set", slideId, notes: "two" },
    ],
    {
      before: (before) => {
        states.push(before.slides[slideId].notes);
      },
    },
  );
  expect(states).toEqual(["", "one"]);
  expect(next.slides[slideId].notes).toBe("two");
  expect(() =>
    applyDocumentOperations(document, [
      { type: "slide.notes.set", slideId, notes: "one" },
      { type: "slide.notes.set", slideId: "missing", notes: "two" },
    ]),
  ).toThrow();
  expect(document.slides[slideId].notes).toBe("");
});

it("page edits validate one slide at 10, 100 and 400 slides and retain cross-page identity checks", () => {
  for (const count of [10, 100, 400]) {
    const document = newPresentationDocument("Scoped");
    const base = document.slides[document.deck.slideIds[0]],
      meta = document.deck.slideMeta[base.id];
    base.nodes[0].children = [createBasicShape("shape", "rectangle")];
    document.deck.slideIds = Array.from({ length: count }, (_, i) => "s" + i);
    document.deck.slideMeta = Object.fromEntries(
      document.deck.slideIds.map((id) => [id, { ...meta }]),
    );
    document.slides = Object.fromEntries(
      document.deck.slideIds.map((id) => [
        id,
        { ...structuredClone(base), id },
      ]),
    );
    presentationDocumentSchema.parse(document);
    const full = vi.spyOn(presentationDocumentSchema, "parse"),
      pages = vi.spyOn(slideSchema, "parse");
    try {
      applyDocumentOperations(document, [
        {
          type: "elements.frame.set",
          slideId: "s0",
          changes: [
            {
              elementId: "shape",
              value: { ...base.nodes[0].children[0].frame, x: 50 },
            },
          ],
        },
      ]);
      expect(full).not.toHaveBeenCalled();
      expect(pages).toHaveBeenCalledTimes(1);
      const template = document.deck.defaultTemplateId!;
      expect(() =>
        applyDocumentOperations(document, [
          {
            type: "elements.insert",
            slideId: template,
            parentId: document.deck.layers[0].id,
            elements: [createBasicShape("shape", "rectangle")],
          },
        ]),
      ).toThrow("Ambiguous resolved Element identity");
    } finally {
      full.mockRestore();
      pages.mockRestore();
    }
  }
});

it("trusted inverse history reaches the same endpoint as validated revision-by-revision replay", () => {
  let document = newPresentationDocument("Replay");
  const id = document.deck.slideIds[0];
  const inverse: DocumentOperation[][] = [];
  let seed = 13;
  const original = document;
  for (let i = 0; i < 100; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    inverse.push([
      {
        type: "slide.notes.set",
        slideId: id,
        notes: document.slides[id].notes,
      },
    ]);
    document = applyDocumentOperations(document, [
      { type: "slide.notes.set", slideId: id, notes: String(seed) },
    ]);
  }
  let control = document;
  for (const operations of inverse.slice().reverse())
    control = applyDocumentOperations(control, operations);
  const full = vi.spyOn(presentationDocumentSchema, "parse"),
    pages = vi.spyOn(slideSchema, "parse");
  try {
    expect(
      applyValidatedDocumentOperations(
        document,
        inverse.slice().reverse().flat(),
        undefined,
        true,
      ),
    ).toEqual(control);
    expect(control).toEqual(original);
    expect(full).not.toHaveBeenCalled();
    expect(pages).toHaveBeenCalledTimes(1);
  } finally {
    full.mockRestore();
    pages.mockRestore();
  }
});

it("scoped element content retains dangling style rejection at the full boundary", () => {
  const document = newPresentationDocument("Styles"),
    id = document.deck.slideIds[0],
    element = createTextElement("text");
  document.slides[id].nodes[0].children = [element];
  const content = {
    ...(element.content as TextContent),
    format: { kind: "style" as const, styleId: "missing", overrides: {} },
  };
  const missingPage = structuredClone(document);
  delete missingPage.slides[id];
  expect(() => presentationDocumentSchema.parse(missingPage)).toThrow(
    "Missing slide",
  );
  const malformed = structuredClone(document);
  malformed.slides[id].nodes[0].children[0].content = content;
  expect(() => presentationDocumentSchema.parse(malformed)).toThrow(
    "Dangling Text Style reference",
  );
  expect(() =>
    applyDocumentOperations(document, [
      {
        type: "elements.content.set",
        slideId: id,
        changes: [{ elementId: element.id, value: content }],
      },
    ]),
  ).toThrow("Dangling Text Style reference");
});

it("stale conflict decisions match full validated replay across seeded mixed histories", async () => {
  let seed = 29;
  const outcomes = new Set<string>();
  for (let scenario = 0; scenario < 12; scenario++) {
    const document = newPresentationDocument("Conflicts"),
      id = document.deck.slideIds[0],
      shape = createBasicShape("shape", "rectangle");
    document.slides[id].nodes[0].children = [shape];
    const fast = new DocumentAuthority(document),
      control = new DocumentAuthority(document);
    (
      control as unknown as {
        documentAtRevision: (revision: number) => typeof document | null;
      }
    ).documentAtRevision = (revision) => {
      const accepted = control.acceptedAfter(revision);
      if (!accepted) return null;
      let current = control.document;
      for (const transaction of accepted.slice().reverse())
        current = applyDocumentOperations(
          current,
          transaction.inverseOperations,
        );
      return current;
    };
    async function commit(
      owner: DocumentAuthority,
      operations: DocumentOperation[],
      baseRevision = owner.revision,
    ) {
      const grant = owner.acquire("local", [
        { kind: "notes", slideId: id },
        { kind: "element", slideId: id, elementId: "shape" },
      ]);
      if (grant.denied) throw new Error("Lease denied");
      const tokens = grant.grants.map((item) => item.token);
      try {
        await owner.commit("local", {
          transactionId: crypto.randomUUID(),
          documentId: document.documentId,
          epoch: owner.epoch,
          baseRevision,
          leaseTokens: tokens,
          operations,
        });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        owner.release("local", tokens);
      }
    }
    for (let step = 0; step < 25; step++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const operation: DocumentOperation =
        scenario % 3 === 0 || (scenario % 3 === 2 && seed % 2)
          ? { type: "slide.notes.set", slideId: id, notes: String(seed) }
          : {
              type: "elements.frame.set",
              slideId: id,
              changes: [
                {
                  elementId: "shape",
                  value: { ...shape.frame, x: seed % 1000 },
                },
              ],
            };
      expect(await commit(fast, [operation])).toBe(
        await commit(control, [operation]),
      );
    }
    const stale: DocumentOperation =
      seed % 3
        ? { type: "slide.notes.set", slideId: id, notes: "Stale" }
        : {
            type: "elements.frame.set",
            slideId: id,
            changes: [{ elementId: "shape", value: { ...shape.frame, x: 14 } }],
          };
    const outcome = await commit(fast, [stale], scenario);
    outcomes.add(outcome);
    expect(outcome).toBe(await commit(control, [stale], scenario));
    expect(fast.document).toEqual(control.document);
  }
  expect(outcomes.has("accepted")).toBe(true);
  expect([...outcomes].some((outcome) => outcome !== "accepted")).toBe(true);
});
