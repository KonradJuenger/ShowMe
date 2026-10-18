import { expect, it } from "vitest";
import {
  AgentProjectionError,
  projectAgentDeck,
  projectAgentElements,
  projectAgentSlide,
} from "../../../src/core/agentProjection";
import { presentationDocumentSchema } from "../../../src/core/document";
import type { DocumentProjection } from "../../../src/core/documentProjection";
import type { Element } from "../../../src/core/element";
import {
  createBasicShape,
  createEmptyFrame,
} from "../../../src/core/elementFactory";
import { effectDefinitionSchema } from "../../../src/core/effects";
import { slideMotionSchema } from "../../../src/core/motionModel";
import { DEFAULT_TRANSITION } from "../../../src/core/slideTransitions";
import { createTextElement } from "../../../src/core/text";
import { DEFAULT_TEXT_TYPOGRAPHY } from "../../../src/core/textTypography";

function text(id: string, value: string): Element {
  const element = createTextElement(id);
  element.name = id + " label";
  element.content = {
    type: "text",
    text: value,
    placeholder: false,
    autoSize: "none",
    format: { kind: "local", typography: { ...DEFAULT_TEXT_TYPOGRAPHY } },
  };
  return element;
}

function fixture(
  titleText = "Revenue grew 26%",
  source = ":scope { opacity: 0.8; }",
): DocumentProjection {
  const layers = [
    {
      id: "main",
      name: "Main",
      hidden: false,
      locked: false,
      color: "#858f9c",
    },
    {
      id: "hidden",
      name: "Hidden",
      hidden: true,
      locked: false,
      color: "#858f9c",
    },
    {
      id: "locked",
      name: "Locked",
      hidden: false,
      locked: true,
      color: "#858f9c",
    },
  ];
  const group = createEmptyFrame("group");
  group.frame = {
    ...group.frame,
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    originX: 0,
    originY: 0,
    rotation: 90,
    scaleX: 2,
    scaleY: 3,
    flipX: true,
  };
  const nested = createBasicShape("nested", "ellipse");
  nested.frame = {
    ...nested.frame,
    x: 10,
    y: 20,
    width: 40,
    height: 10,
    originX: 0,
    originY: 0,
    rotation: 90,
  };
  group.children = [nested];
  const title = text("title", titleText);
  title.content = {
    ...title.content!,
    type: "text",
    text: titleText,
    placeholder: false,
    autoSize: "height",
    format: { kind: "style", styleId: "heading", overrides: { fontSize: 80 } },
  };
  title.effects = [
    {
      id: "instance",
      resourceId: "effect",
      enabled: true,
      placement: "content",
      parameters: { zeta: 0.5, alpha: true },
    },
  ];
  const movie = createBasicShape("movie", "rectangle");
  movie.content = {
    type: "video",
    assetId: "a".repeat(64),
    filename: "private-client-name.mp4",
    mediaType: "video",
    opacity: 0.7,
    lockAspect: true,
    transform: {
      rule: "fit",
      intrinsicWidth: 1920,
      intrinsicHeight: 1080,
      rotation: 0,
      flipX: false,
      flipY: false,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    autoplay: false,
    loop: true,
    mute: false,
    volume: 0.4,
    startTime: 2,
    endTime: 10,
  };
  const document = presentationDocumentSchema.parse({
    kind: "showme-presentation",
    version: 1,
    documentId: "document",
    deck: {
      version: 1,
      id: "document",
      name: "Quarterly results",
      width: 1920,
      height: 1080,
      textStyles: [
        {
          id: "heading",
          name: "Heading",
          defaultKind: "heading",
          typography: { ...DEFAULT_TEXT_TYPOGRAPHY, fontWeight: 700 },
        },
        {
          id: "body",
          name: "Text",
          defaultKind: "text",
          typography: DEFAULT_TEXT_TYPOGRAPHY,
        },
      ],
      stylesheet: "PRIVATE_STYLESHEET_SOURCE",
      transitionDefaults: DEFAULT_TRANSITION,
      slideIds: ["other", "slide"],
      slideMeta: {
        other: {
          name: "Other",
          section: "Intro",
          hidden: true,
          templateId: null,
        },
        slide: {
          name: "Results",
          section: "Performance",
          hidden: false,
          templateId: "template",
        },
      },
      templateIds: ["template"],
      templateMeta: { template: { label: "A" } },
      defaultTemplateId: "template",
      layers,
      guideSets: {},
      defaultGuideSetId: null,
    },
    templates: {
      template: {
        version: 1,
        id: "template",
        background: "#123456",
        nodes: layers.map(({ id }) => ({
          type: "layer",
          id,
          children: id === "main" ? [text("inherited", "Template title")] : [],
        })),
      },
    },
    slides: {
      other: {
        version: 1,
        id: "other",
        background: "#ffffff",
        notes: "UNRELATED_NOTES",
        nodes: layers.map(({ id }) => ({ type: "layer", id, children: [] })),
      },
      slide: {
        version: 1,
        id: "slide",
        background: "#abcdef",
        notes: "PRIVATE_SPEAKER_NOTES",
        effectResources: {
          effect: effectDefinitionSchema.parse({
            apiVersion: 1,
            name: "Opacity",
            category: "effect",
            kind: "css",
            target: "content",
            source,
            styleSource: "PRIVATE_EFFECT_STYLE_SOURCE",
            parameters: [
              { key: "zeta", label: "Zeta", type: "number", default: 1 },
              { key: "alpha", label: "Alpha", type: "boolean", default: false },
            ],
          }),
        },
        nodes: [
          { type: "layer", id: "main", children: [group, title, movie] },
          {
            type: "layer",
            id: "hidden",
            children: [text("hiddenText", "HIDDEN_CONTENT")],
          },
          {
            type: "layer",
            id: "locked",
            children: [text("lockedText", "Locked visible text")],
          },
        ],
      },
    },
  });
  return {
    documentId: document.documentId,
    epoch: "epoch",
    revision: 12,
    savedRevision: 9,
    deck: document.deck,
    slide: document.slides.slide,
    templates: document.templates,
  };
}

it("projects ordered deck metadata without unavailable counts or document bodies", () => {
  const projection = fixture();
  const result = projectAgentDeck(projection);
  expect(result).toEqual({
    documentId: "document",
    epoch: "epoch",
    revision: 12,
    savedRevision: 9,
    dirty: true,
    deck: {
      id: "document",
      name: "Quarterly results",
      width: 1920,
      height: 1080,
      slideCount: 2,
      hasStylesheet: true,
      slides: [
        {
          id: "other",
          index: 0,
          name: "Other",
          section: "Intro",
          hidden: true,
          templateId: null,
        },
        {
          id: "slide",
          index: 1,
          name: "Results",
          section: "Performance",
          hidden: false,
          templateId: "template",
        },
      ],
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|Revenue|elementCount/);
  expect(projectAgentDeck({ ...projection, savedRevision: 12 }).dirty).toBe(
    false,
  );
});

it("exposes Text Styles only when explicitly requested", () => {
  const projection = fixture();
  expect(projectAgentDeck(projection).deck).not.toHaveProperty("textStyles");
  expect(
    projectAgentDeck(projection, { includeTextStyles: true }).deck.textStyles,
  ).toEqual([
    expect.objectContaining({
      id: "heading",
      name: "Heading",
      defaultKind: "heading",
      typography: expect.objectContaining({ fontWeight: 700 }),
    }),
    expect.objectContaining({
      id: "body",
      name: "Text",
      defaultKind: "text",
    }),
  ]);
});

it("describes canonical visual preorder with actual parent and layer identities", () => {
  const projection = fixture();
  const result = projectAgentSlide(projection);
  expect(
    result.elements.map(({ id, parentId, layerIndex, depth, siblingIndex }) => [
      id,
      parentId,
      layerIndex,
      depth,
      siblingIndex,
    ]),
  ).toEqual([
    ["inherited", "main", 0, 0, 0],
    ["group", "main", 0, 0, 1],
    ["nested", "group", 0, 1, 0],
    ["title", "main", 0, 0, 2],
    ["movie", "main", 0, 0, 3],
    ["hiddenText", "hidden", 1, 0, 0],
    ["lockedText", "locked", 2, 0, 0],
  ]);
  expect(result.elements.find(({ id }) => id === "group")).toMatchObject({
    childCount: 1,
    container: true,
    clipChildren: true,
    contentType: null,
    geometryType: "rect",
  });
  expect(result.elements.find(({ id }) => id === "nested")).toMatchObject({
    childCount: 0,
    contentType: null,
    geometryType: "ellipse",
    container: false,
  });
  expect(JSON.stringify(projectAgentSlide(structuredClone(projection)))).toBe(
    JSON.stringify(result),
  );
});

it("uses base world geometry for nested rotations scales and reflections without clipping it", () => {
  const result = projectAgentElements(fixture(), ["nested"], {
    includeWorldTransform: true,
  });
  expect(result.elements[0]).toMatchObject({
    worldBounds: { x: 140, y: 50, width: 80, height: 30 },
    worldTransform: {
      matrix: [2, 0, 0, -3, 140, 80],
      corners: [
        { x: 140, y: 80 },
        { x: 220, y: 80 },
        { x: 220, y: 50 },
        { x: 140, y: 50 },
      ],
    },
    frame: { x: 10, y: 20, width: 40, height: 10, rotation: 90 },
  });
});

it("rounds derived geometry and normalizes negative zero while retaining exact native frames", () => {
  const projection = fixture();
  projection.slide.nodes[0].children[0].frame = {
    ...projection.slide.nodes[0].children[0].frame,
    x: -0.0001,
    y: 1.23456,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    flipX: false,
  };
  const result = projectAgentElements(projection, ["group"], {
    includeWorldTransform: true,
  }).elements[0];
  expect(result.frame.x).toBe(-0.0001);
  expect(result.frame.y).toBe(1.23456);
  expect(result.worldBounds).toEqual({
    x: 0,
    y: 1.235,
    width: 200,
    height: 100,
  });
  expect(Object.is(result.worldBounds.x, -0)).toBe(false);
  expect(result.worldTransform!.matrix.slice(0, 4)).toEqual([1, 0, 0, 1]);
});

it("preserves template ownership and composed background without treating inherited content as local", () => {
  const projection = fixture();
  const result = projectAgentSlide(projection);
  expect(result.slide).toEqual({
    id: "slide",
    index: 1,
    name: "Results",
    hidden: false,
    templateId: "template",
    background: "#123456",
    elementCount: 7,
  });
  expect(result.elements[0]).toMatchObject({
    source: "template",
    ownerPageId: "template",
    textPreview: "Template title",
  });
  expect(result.elements[1]).toMatchObject({
    source: "slide",
    ownerPageId: "slide",
  });
  const inherited = projection.templates!.template.nodes[0].children[0];
  inherited.effects = [
    {
      id: "inheritedInstance",
      resourceId: "inheritedEffect",
      enabled: false,
      placement: "content",
      parameters: {},
    },
  ];
  projection.templates!.template.effectResources = {
    inheritedEffect: {
      ...projection.slide.effectResources!.effect,
      name: "Template opacity",
    },
  };
  expect(
    projectAgentElements(projection, ["inherited"]).elements[0],
  ).toMatchObject({
    source: "template",
    effectCount: 1,
    effects: [
      {
        id: "inheritedInstance",
        resourceId: "inheritedEffect",
        name: "Template opacity",
        enabled: false,
      },
    ],
  });
  projection.deck.slideMeta.slide.templateId = null;
  expect(projectAgentSlide(projection).slide).toMatchObject({
    background: "#abcdef",
    elementCount: 6,
    templateId: null,
  });
  expect(projectAgentSlide(projection).elements[0].id).toBe("group");
});

it("withholds hidden content by default while exposing structural state and locked visible content", () => {
  const projection = fixture();
  const result = projectAgentSlide(projection);
  expect(result.layers[1]).toEqual({
    id: "hidden",
    name: "Hidden",
    hidden: true,
    locked: false,
    color: "#858f9c",
  });
  expect(result.layers[2].locked).toBe(true);
  expect(result.elements.find(({ id }) => id === "hiddenText")).toMatchObject({
    contentWithheld: true,
    contentType: "text",
  });
  expect(
    result.elements.find(({ id }) => id === "lockedText")!.textPreview,
  ).toBe("Locked visible text");
  expect(JSON.stringify(result)).not.toContain("HIDDEN_CONTENT");
  expect(
    projectAgentElements(projection, ["hiddenText"]).elements[0],
  ).not.toHaveProperty("content");
  const explicit = projectAgentElements(projection, ["hiddenText"], {
    includeHiddenContent: true,
  });
  expect(explicit.elements[0]).toMatchObject({
    contentWithheld: false,
    content: { text: "HIDDEN_CONTENT" },
  });
  projection.deck.slideMeta.slide.hidden = true;
  const hiddenSlide = projectAgentElements(projection, ["title", "inherited"]);
  expect(
    hiddenSlide.elements.every(({ contentWithheld }) => contentWithheld),
  ).toBe(true);
  expect(JSON.stringify(hiddenSlide)).not.toMatch(
    /Revenue|Template title|zeta|Opacity/,
  );
  expect(
    projectAgentSlide(projection, { includeHiddenContent: true }).elements[0]
      .textPreview,
  ).toBe("Template title");
});

it("bounds Unicode previews and resolves real style references and local typography only in detail", () => {
  const value = "A".repeat(159) + "😀" + "Z";
  const projection = fixture(value);
  const outline = projectAgentSlide(projection).elements.find(
    ({ id }) => id === "title",
  )!;
  expect(outline).toMatchObject({
    textPreview: "A".repeat(159) + "😀",
    textLength: 161,
    textTruncated: true,
    textStyleId: "heading",
  });
  const content = projectAgentElements(projection, ["title"]).elements[0]
    .content;
  expect(content).toMatchObject({
    text: value,
    format: { kind: "style", styleId: "heading" },
    typography: { fontSize: 80, fontWeight: 700 },
  });
  const local = projectAgentElements(projection, ["lockedText"]).elements[0];
  expect(local).not.toHaveProperty("textStyleId");
  expect(local.content).toMatchObject({
    format: { kind: "local" },
    typography: DEFAULT_TEXT_TYPOGRAPHY,
  });
  expect(
    projectAgentSlide(fixture("😀".repeat(160))).elements.find(
      ({ id }) => id === "title",
    )!.textTruncated,
  ).toBe(false);
});

it("limits scoped detail to explicit deduplicated IDs in visual order without expanding containers", () => {
  const projection = fixture();
  const result = projectAgentElements(projection, ["movie", "group", "movie"]);
  expect(result.elements.map(({ id }) => id)).toEqual(["group", "movie"]);
  expect(result.elements[0].childCount).toBe(1);
  expect(result.elements[0]).not.toHaveProperty("children");
  expect(result.elements[0]).not.toHaveProperty("worldTransform");
  expect(JSON.stringify(result)).not.toMatch(
    /Revenue|Template title|HIDDEN_CONTENT|PRIVATE_/,
  );
  expect(projectAgentElements(projection, []).elements).toEqual([]);
});

it("rejects unknown targets together and reports missing template or unsupported page explicitly", () => {
  const projection = fixture();
  expect(() =>
    projectAgentElements(projection, [
      "title",
      "missingB",
      "missingA",
      "missingB",
    ]),
  ).toThrowError(
    expect.objectContaining({
      code: "UNKNOWN_ELEMENT",
      missingIds: ["missingA", "missingB"],
    }),
  );
  delete projection.templates!.template;
  expect(() => projectAgentSlide(projection)).toThrowError(
    expect.objectContaining({
      code: "MISSING_TEMPLATE",
      missingIds: ["template"],
    }),
  );
  projection.deck.slideMeta.slide.templateId = null;
  expect(projectAgentSlide(projection).elements).toHaveLength(6);
  projection.slide.id = "notASlide";
  expect(() => projectAgentSlide(projection)).toThrow(AgentProjectionError);
  expect(() => projectAgentSlide(projection)).toThrowError(
    expect.objectContaining({ code: "UNKNOWN_SLIDE" }),
  );
});

it("returns allowlisted media settings without filenames paths or bytes", () => {
  const projection = fixture();
  const result = projectAgentElements(projection, ["movie"]);
  expect(result.elements[0].content).toEqual({
    type: "video",
    assetId: "a".repeat(64),
    mediaType: "video",
    opacity: 0.7,
    lockAspect: true,
    transform: {
      rule: "fit",
      intrinsicWidth: 1920,
      intrinsicHeight: 1080,
      rotation: 0,
      flipX: false,
      flipY: false,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    playback: {
      autoplay: false,
      loop: true,
      mute: false,
      volume: 0.4,
      startTime: 2,
      endTime: 10,
    },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /filename|private-client|bytes|path/i,
  );
  const movie = projection.slide.nodes[0].children[2];
  movie.content = {
    type: "image",
    assetId: "b".repeat(64),
    filename: "private-image.png",
    mediaType: "image",
    opacity: 1,
    lockAspect: false,
    transform: { rule: "free", local: movie.frame },
  };
  const image = projectAgentElements(projection, ["movie"]).elements[0].content;
  expect(image).toMatchObject({
    type: "image",
    mediaType: "image",
    transform: { rule: "free" },
  });
  expect(image).not.toHaveProperty("playback");
  expect(image).not.toHaveProperty("filename");
});

it("summarizes native Motion Presence and Effect timing without code or keyframe tracks", () => {
  const projection = fixture();
  projection.slide.motion = slideMotionSchema.parse({
    stages: [
      { id: "entry", tracks: [] },
      {
        id: "click",
        tracks: [
          {
            id: "track",
            elementId: "title",
            property: "transform.y",
            initial: { type: "offset", value: 10 },
            keyframes: [{ id: "keyframe", at: 400, value: { type: "base" } }],
          },
        ],
        blocks: [
          {
            id: "presence",
            label: "Reveal",
            members: [],
            binding: { kind: "presence", elementId: "title" },
            presenceSchedule: {
              version: 1,
              startOffsetMs: 0,
              end: { mode: "none" },
              enterTransition: {
                kind: "none",
                durationMs: 0,
                easing: "linear",
              },
              exitTransition: { kind: "none", durationMs: 0, easing: "linear" },
            },
          },
          {
            id: "effectTiming",
            label: "Effect",
            members: [],
            binding: {
              kind: "effect",
              elementId: "title",
              effectInstanceId: "instance",
            },
            effectSchedule: {
              version: 1,
              start: "click",
              startOffsetMs: 100,
              stop: { mode: "after", durationMs: 800 },
            },
          },
        ],
      },
    ],
  });
  const result = projectAgentElements(projection, ["title"]);
  expect(result.elements[0]).toMatchObject({
    hasMotion: true,
    hasPresence: true,
    effectCount: 1,
    motionStageIndices: [1],
    presenceStageIndices: [1],
    content: { text: "Revenue grew 26%" },
    effects: [
      {
        id: "instance",
        resourceId: "effect",
        name: "Opacity",
        kind: "css",
        target: "content",
        enabled: true,
        placement: "content",
        parameters: { alpha: true, zeta: 0.5 },
        timing: {
          defaults: { start: "slide", stop: { mode: "none" } },
          stageIndex: 1,
          schedule: {
            start: "click",
            startOffsetMs: 100,
            stop: { mode: "after", durationMs: 800 },
          },
        },
      },
    ],
  });
  expect(Object.keys(result.elements[0].effects![0].parameters)).toEqual([
    "alpha",
    "zeta",
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE_|:scope|keyframe|transform.y|tracks/,
  );
});

it("returns detached mutable details and never changes the accepted projection input", () => {
  const projection = fixture();
  const before = structuredClone(projection);
  const deck = projectAgentDeck(projection);
  const slide = projectAgentSlide(projection);
  const detail = projectAgentElements(projection, ["title", "movie"]);
  expect(projection).toEqual(before);
  deck.deck.slides[0].name = "changed";
  slide.layers[0].name = "changed";
  slide.elements[0].worldBounds.x = 999;
  detail.elements[0].frame.x = 999;
  detail.elements[0].appearance.opacity = 0;
  detail.elements[0].effects![0].parameters.zeta = 999;
  detail.elements[0].effects![0].timing.defaults.start = "presentation";
  const content = detail.elements[0].content!;
  if (content.type === "text") {
    content.text = "changed";
    content.typography.fontSize = 999;
    if (content.format.kind === "style")
      content.format.overrides.fontSize = 999;
  }
  const media = detail.elements[1].content!;
  if (media.type !== "text" && media.transform.rule === "fit")
    media.transform.anchorX = 0;
  expect(projection).toEqual(before);
  expect(projectAgentSlide(projection)).not.toEqual(slide);
});

it("keeps default payload independent of full Effect source and text beyond the preview", () => {
  const short = fixture("A".repeat(1000), "SHORT_SOURCE");
  const long = fixture("A".repeat(90000), "L".repeat(90000));
  const small = projectAgentSlide(short),
    large = projectAgentSlide(long);
  const title = large.elements.find(({ id }) => id === "title")!;
  expect(title.textPreview).toHaveLength(160);
  expect(title.textLength).toBe(90000);
  // Only the text-length number changes, not payload proportional to body/source.
  const normalized = structuredClone(large);
  normalized.elements.find(({ id }) => id === "title")!.textLength = 1000;
  expect(normalized).toEqual(small);
  expect(JSON.stringify(projectAgentElements(long, ["title"]))).not.toContain(
    "L".repeat(100),
  );
});
