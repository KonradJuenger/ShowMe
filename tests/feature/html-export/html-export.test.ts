import { it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHtmlExport } from "../../../electron/export/html";
import { EmbeddedRenderResources } from "../../../src/export/html/embeddedResources";
import {
  htmlExportFixture,
  hostileText,
} from "../../helpers/htmlExportFixture";
import { newEffectInstance } from "../../../src/core/effects";
import { blankEffect } from "../../../src/core/effectAuthoring";
import { captureVideoPoster, videoPoster } from "../../../src/core/videoPoster";

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
