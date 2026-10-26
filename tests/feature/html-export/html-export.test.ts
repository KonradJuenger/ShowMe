import { it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHtmlExport, htmlFontUsages } from "../../../electron/export/html";
import { EmbeddedRenderResources } from "../../../src/export/html/embeddedResources";
import {
  htmlExportFixture,
  hostileText,
} from "../../helpers/htmlExportFixture";
import { newEffectInstance } from "../../../src/core/effects";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { captureVideoPoster, videoPoster } from "../../../src/core/videoPoster";
import { slideSchema } from "../../../src/core/document";

let runtimeDirectory: string;
beforeAll(async () => {
  runtimeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "showme-html-runtime-unit-"),
  );
  await writeFile(path.join(runtimeDirectory, "runtime.js"), "void 0;");
  await writeFile(
    path.join(runtimeDirectory, "runtime.css"),
    "body { margin: 0; }",
  );
});
afterAll(async () => {
  await rm(runtimeDirectory, { recursive: true, force: true });
});

function exportedPayload(html: string) {
  const json = html.match(
    /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
  )![1];
  return JSON.parse(
    json,
  ) as import("../../../src/export/html/types").HtmlExportPayload;
}

it("assembles one escaped offline document and reports missing media and font resources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "showme-html-unit-"));
  try {
    await writeFile(path.join(dir, "runtime.js"), 'console.log("</script>")');
    await writeFile(path.join(dir, "runtime.css"), "/* </style> */");
    const document = htmlExportFixture();
    const { html, warnings } = await createHtmlExport({
      document,
      runtimeDirectory: dir,
      runtimeVersion: "test",
      resolveAsset: async () => null,
      managedFonts: async () => {
        throw Error("unavailable");
      },
    });
    const json = html.match(
      /<script id="showme-html-payload" type="application\/json">(.*?)<\/script>/s,
    )![1];
    expect(
      JSON.parse(json).document.slides[0].nodes[0].children[0].content.text,
    ).toBe(hostileText);
    expect(json).not.toContain("<");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("connect-src 'none'");
    expect(warnings.filter((w) => w.code === "missing-media")).toHaveLength(3);
    expect(warnings.some((w) => w.code === "managed-fonts-unavailable")).toBe(
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("diagnoses actual composition inputs including upstream CSS, shader chains and hidden layers", async () => {
  const document = htmlExportFixture();
  const slide = document.slides[1];
  const image = slide.nodes[0].children[0];
  const css = blankEffect("css-js");
  slide.effectResources!.css = css;
  image.effects!.unshift(newEffectInstance("css", css, "content"));
  const shader = blankEffect("shader");
  image.effects!.push(newEffectInstance("direct", shader, "content"));
  document.deck.layers.push({
    ...document.deck.layers[0],
    id: "hidden",
    hidden: true,
  });
  slide.nodes.push({
    type: "layer",
    id: "hidden",
    children: [{ ...structuredClone(image), id: "hidden-image" }],
  });
  const { warnings } = await createHtmlExport({
    document,
    runtimeDirectory,
    runtimeVersion: "test",
    resolveAsset: async () => null,
    managedFonts: async () => [],
  });
  const scene = warnings.filter(
    (w) => w.code === "unsupported-browser-scene-texture",
  );
  expect(scene).toHaveLength(1);
  expect(scene[0]).toMatchObject({ slideId: slide.id, elementId: image.id });
  expect(scene[0].message).toContain(image.effects![1].id);
});

it("decodes assets lazily, retains shared URLs, isolates providers and revokes only after last release", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const asset = {
    id: "asset",
    mime: "text/plain",
    data: Buffer.from("payload").toString("base64"),
  };
  const a = new EmbeddedRenderResources([asset], []),
    b = new EmbeddedRenderResources([asset], []);
  try {
    expect(create).not.toHaveBeenCalled();
    const one = (await a.assetUrl("asset"))!,
      two = (await a.assetUrl("asset"))!,
      other = (await b.assetUrl("asset"))!;
    expect(one).toBe(two);
    expect(other).not.toBe(one);
    a.releaseUrl(one);
    expect(revoke).not.toHaveBeenCalled();
    expect(await (await fetch(two)).text()).toBe("payload");
    a.releaseUrl(two);
    expect(revoke).toHaveBeenCalledWith(one);
    expect(await a.assetUrl("missing")).toBeNull();
    expect(await a.assetUrl("asset", true)).toBeNull();
    expect(await a.assetUrl("asset")).not.toBe(one);
    b.dispose();
    expect(revoke).toHaveBeenCalledWith(other);
    expect(await b.assetUrl("asset")).toBeNull();
  } finally {
    a.dispose();
    b.dispose();
    vi.restoreAllMocks();
  }
});

it("selects exact managed font variants and warns when a used weight is unavailable", async () => {
  const document = htmlExportFixture();
  const text = document.slides[0].nodes[0].children[0];
  if (text.content?.type !== "text" || text.content.format.kind !== "local")
    throw Error("fixture");
  text.content.format.typography.fontFamily = "Managed Fixture";
  text.content.format.typography.fontWeight = 700;
  text.content.format.typography.italic = true;
  const input = {
    document,
    runtimeVersion: "test",
    runtimeDirectory,
    resolveAsset: async () => null,
  };
  const unavailable = await createHtmlExport({
    ...input,
    managedFonts: async () => [
      {
        family: "Managed Fixture",
        weights: [400],
        sources: [
          {
            id: "regular",
            weight: 400,
            italic: false,
            data: new Uint8Array([1]),
          },
        ],
      },
    ],
  });
  expect(unavailable.warnings.some((w) => w.code === "font-not-embedded")).toBe(
    true,
  );
  const available = await createHtmlExport({
    ...input,
    managedFonts: async () => [
      {
        family: "Managed Fixture",
        weights: [400, 700],
        sources: [
          {
            id: "italic",
            weight: 700,
            italic: true,
            data: new Uint8Array([2]),
          },
        ],
      },
    ],
  });
  expect(available.warnings.some((w) => w.code === "font-not-embedded")).toBe(
    false,
  );
  expect(available.html).toContain(
    '"id":"italic","weight":700,"italic":true,"data":"Ag=="',
  );
});

it("isolates video posters with identical asset IDs between resource providers", async () => {
  let frame = "first";
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => frame,
    }),
  });
  try {
    const a = new EmbeddedRenderResources([], []),
      b = new EmbeddedRenderResources([], []);
    const video = {
      seeking: false,
      readyState: 2,
      videoWidth: 64,
      videoHeight: 64,
    } as HTMLVideoElement;
    expect(captureVideoPoster("same", 0, video, a)).toBe("first");
    frame = "second";
    expect(captureVideoPoster("same", 0, video, b)).toBe("second");
    expect(await videoPoster(a, "same", 0, false)).toBe("first");
    expect(await videoPoster(b, "same", 0, false)).toBe("second");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("omits hidden slides, layer content, notes and unreachable effects from the distributed HTML", async () => {
  const document = htmlExportFixture();
  const [first, hidden] = document.slides;
  first.notes = "private speaker notes";
  hidden.notes = "hidden notes";
  document.deck.slideMeta[hidden.id].hidden = true;
  document.deck.layers.push({
    ...document.deck.layers[0],
    id: "hidden-layer",
    name: "PRIVATE_HIDDEN_LAYER",
    hidden: true,
  });
  const hiddenText = structuredClone(first.nodes[0].children[0]);
  hiddenText.id = "private-hidden-text";
  if (hiddenText.content?.type !== "text") throw Error("text fixture");
  hiddenText.content.text = "PRIVATE_HIDDEN_TEXT";
  if (hiddenText.content.format.kind !== "local") throw Error("local text fixture");
  hiddenText.content.format.typography.fontFamily = "PRIVATE_HIDDEN_FONT";
  const privateEffect = {
    ...blankEffect("css-js"),
    source: "/* PRIVATE_HIDDEN_EFFECT_SOURCE */",
  };
  hiddenText.effects = [
    newEffectInstance("private", privateEffect, "content"),
    newEffectInstance("css", first.effectResources!.css, "content"),
  ];
  first.effectResources!.private = privateEffect;
  first.effectResources!.unused = {
    ...blankEffect("css-js"),
    source: "/* PRIVATE_EFFECT_SOURCE */",
  };
  const hiddenMedia = structuredClone(hidden.nodes[0].children[0]);
  if (hiddenMedia.content?.type !== "image") throw Error("image fixture");
  hiddenMedia.content.filename = "PRIVATE_HIDDEN_FILENAME.png";
  hiddenMedia.content.assetId = "PRIVATE_HIDDEN_ASSET";
  first.nodes.push({
    type: "layer",
    id: "hidden-layer",
    children: [hiddenText, hiddenMedia],
  });
  const stage = first.motion!.stages[1],
    visibleTrack = stage.tracks[0];
  stage.tracks.push({
    ...structuredClone(visibleTrack),
    id: "private-track",
    elementId: hiddenText.id,
    keyframes: visibleTrack.keyframes.map((keyframe, index) => ({
      ...keyframe,
      id: `private-key-${index}`,
    })),
  });
  stage.blocks = [
    {
      id: "private-block",
      label: "PRIVATE_MOTION_LABEL",
      members: [
        {
          trackId: "private-track",
          fromKeyframeId: "private-key-0",
          toKeyframeId: "private-key-1",
        },
      ],
    },
    {
      id: "visible-block",
      label: "Visible motion",
      members: [
        {
          trackId: visibleTrack.id,
          fromKeyframeId: visibleTrack.keyframes[0].id,
          toKeyframeId: visibleTrack.keyframes[1].id,
        },
        {
          trackId: "private-track",
          fromKeyframeId: "private-key-0",
          toKeyframeId: "private-key-1",
        },
      ],
    },
  ];
  const before = structuredClone(document);
  expect(htmlFontUsages(document).some(usage => usage.family === "PRIVATE_HIDDEN_FONT")).toBe(false);
  const resolveAsset = vi.fn(async () => null);
  const { html, warnings } = await createHtmlExport({
    document,
    runtimeDirectory,
    runtimeVersion: "test",
    resolveAsset,
    managedFonts: async () => [],
  });
  const payload = exportedPayload(html);
  expect(payload.document.deck.slideIds).toEqual([first.id]);
  expect(Object.keys(payload.document.deck.slideMeta)).toEqual([first.id]);
  expect(payload.document.slides).toHaveLength(1);
  expect(payload.document.slides[0].notes).toBe("");
  expect(payload.document.deck.layers.map((layer) => layer.id)).not.toContain(
    "hidden-layer",
  );
  const exported = payload.document.slides[0];
  expect(exported.nodes.map((root) => root.id)).toEqual([first.nodes[0].id]);
  expect(exported.effectResources).toEqual({
    css: first.effectResources!.css,
    js: first.effectResources!.js,
  });
  expect(exported.motion!.stages.map((stage) => stage.id)).toEqual(
    first.motion!.stages.map((stage) => stage.id),
  );
  expect(exported.motion!.stages[1].tracks).toEqual([visibleTrack]);
  expect(exported.motion!.stages[1].blocks).toEqual([
    { ...stage.blocks[1], members: [stage.blocks[1].members[0]] },
  ]);
  expect(slideSchema.safeParse(exported).success).toBe(true);
  expect(document).toEqual(before);
  expect(resolveAsset).not.toHaveBeenCalled();
  expect(warnings.some((w) => w.code === "missing-media")).toBe(false);
  expect(html).not.toContain("private speaker notes");
  expect(html).not.toContain("hidden notes");
  expect(html).not.toContain("PRIVATE_HIDDEN_TEXT");
  expect(html).not.toContain("PRIVATE_HIDDEN_FONT");
  expect(html).not.toContain("PRIVATE_EFFECT_SOURCE");
  expect(html).not.toContain("PRIVATE_HIDDEN_EFFECT_SOURCE");
  expect(html).not.toContain("PRIVATE_HIDDEN_FILENAME");
  expect(html).not.toContain("PRIVATE_HIDDEN_ASSET");
  expect(html).not.toContain("PRIVATE_HIDDEN_LAYER");
  expect(html).not.toContain("PRIVATE_MOTION_LABEL");
});

it("embeds visible CSS font variants and identifies blocked external CSS and SVG resources", async () => {
  const document = htmlExportFixture();
  document.deck.stylesheet =
    '.title { font-family: "CSS Fixture"; background: url("./sibling.png"); }';
  expect(htmlFontUsages(document)).toContainEqual({ family: "CSS Fixture", weight: 400, italic: false });
  document.slides[0].effectResources!.css.source =
    ':scope { background: url("https://example.test/effect.png"); }';
  const file = path.join(runtimeDirectory, "external.svg");
  await writeFile(
    file,
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="./external.png"/></svg>',
  );
  const { html, warnings } = await createHtmlExport({
    document,
    runtimeDirectory,
    runtimeVersion: "test",
    resolveAsset: async (id) =>
      id === "video" ? null : { file, mime: "image/svg+xml" },
    managedFonts: async () => [
      {
        family: "CSS Fixture",
        weights: [400, 700],
        sources: [
          {
            id: "regular",
            weight: 400,
            italic: false,
            data: new Uint8Array([1]),
          },
          {
            id: "bold-italic",
            weight: 700,
            italic: true,
            data: new Uint8Array([2]),
          },
        ],
      },
    ],
  });
  expect(
    exportedPayload(html).fonts[0].sources.map((source) => source.id),
  ).toEqual(["regular", "bold-italic"]);
  expect(warnings.some((w) => w.code === "non-embedded-css-resource")).toBe(
    true,
  );
  expect(
    warnings.some(
      (w) =>
        w.code === "non-embedded-effect-resource" && w.elementId === "text",
    ),
  ).toBe(true);
  expect(warnings.some((w) => w.code === "non-embedded-svg-resource")).toBe(
    true,
  );
  expect(warnings.some((w) => w.code === "stylesheet-font-not-embedded")).toBe(
    false,
  );
});

it("reports failed font faces without losing installed variants or reinstalling them", async () => {
  const add = vi.fn(),
    remove = vi.fn();
  vi.stubGlobal("document", {
    fonts: { add, delete: remove, ready: Promise.resolve() },
  });
  vi.stubGlobal(
    "FontFace",
    class {
      constructor(
        readonly family: string,
        readonly bytes: ArrayBuffer,
      ) {}
      async load() {
        if (new Uint8Array(this.bytes)[0] === 0) throw Error("invalid font");
        return this;
      }
    },
  );
  const resources = new EmbeddedRenderResources(
    [],
    [
      {
        family: "Fixture",
        weights: [400, 700],
        sources: [
          { id: "good", weight: 400, italic: false, data: "AQ==" },
          { id: "bad", weight: 700, italic: false, data: "AA==" },
        ],
      },
    ],
  );
  try {
    expect(await resources.installFonts()).toEqual([
      expect.stringContaining("Fixture 700"),
    ]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(await resources.installFonts()).toHaveLength(1);
    expect(add).toHaveBeenCalledTimes(1);
    resources.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await resources.installFonts()).toEqual([]);
    expect(add).toHaveBeenCalledTimes(1);
  } finally {
    resources.dispose();
    vi.unstubAllGlobals();
  }
});
