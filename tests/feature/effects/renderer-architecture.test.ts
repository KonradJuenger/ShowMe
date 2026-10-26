import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const sourceRoot = new URL("../../../src/", import.meta.url);
const components = new URL("components/", sourceRoot);
const component = (name: string) =>
  readFileSync(new URL(name, components), "utf8");

function collectSources(directory: URL, prefix = ""): [string, string][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      return collectSources(new URL(entry.name + "/", directory), path + "/");
    return /\.(ts|tsx)$/.test(entry.name)
      ? [
          [path, readFileSync(new URL(entry.name, directory), "utf8")] as [
            string,
            string,
          ],
        ]
      : [];
  });
}
const productionSources = Object.fromEntries(collectSources(sourceRoot));
const importedModules = (source: string) =>
  [...source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
const importers = (name: string) =>
  Object.entries(productionSources)
    .filter(([, source]) =>
      importedModules(source).some(
        (specifier) =>
          specifier === `./${name}` || specifier.endsWith(`/${name}`),
      ),
    )
    .map(([path]) => path)
    .sort();

it("keeps SlideRenderer on the browser-native rendering path", () => {
  const source = component("SlideRenderer.tsx");
  expect(source).toContain("compileCompositionPlan");
  expect(source).toContain("<EffectSurface");
  for (const legacy of [
    "compositionBackendPlan",
    "legacyCssBackdropValidation",
    "compositionSurface",
    "backdropRestoration",
    "elementRaster",
    "CompositionContext",
    "browserNativeCss",
    "restorationPlan",
    "nativeBackdropGroups",
  ])
    expect(source).not.toContain(legacy);
});

it("makes CSS unconditional instead of selecting a rendering backend", () => {
  const surface = component("EffectSurface.tsx");
  const runtime = component("effectRuntime.ts");
  expect(surface).not.toContain("backdropMode");
  expect(surface).not.toContain("compositionDependencies");
  expect(surface).not.toContain("browserNativeCss");
  expect(runtime).not.toContain("createCssBackdrop");
  expect(runtime).not.toContain("resolvedBackdropMode");
  expect(runtime).not.toContain("backdropRestoration");
  expect(runtime).not.toContain("compositionSurface");
});

it("uses SceneTexture as the sole production doorway to Chromium scene capture", () => {
  const runtime = component("effectRuntime.ts");
  const boundary = component("sceneTexture.ts");
  const adapter = component("sceneTextureCapture.ts");

  expect(runtime).toContain('from "./sceneTexture"');
  expect(runtime.match(/createSceneTextureProvider\(/g)).toHaveLength(1);
  expect(runtime).toContain(
    'definition.input === "content" || definition.input === "backdrop"',
  );
  for (const legacy of [
    "elementRaster",
    "domRaster",
    "compositionSurface",
    "backdropRestoration",
  ])
    expect(runtime).not.toContain(legacy);

  expect(boundary).toContain("interface SceneTextureProvider");
  expect(boundary).toContain('from "./sceneTextureCapture"');
  expect(boundary).not.toContain("elementRaster");
  expect(boundary).not.toContain("domRaster");
  expect(productionSources["components/elementRaster.ts"]).toBeUndefined();
  expect(productionSources["components/sceneTextureGpu.ts"]).toBeUndefined();
  expect(productionSources["components/sceneTextureLegacy.ts"]).toBeUndefined();
  expect(adapter).toContain('from "./domRaster"');
  expect(adapter).not.toContain("createFramebuffer");
  for (const source of Object.values(productionSources))
    expect(
      importedModules(source).some((name) => name.includes("experiments/")),
    ).toBe(false);

  const legacyCompositorIsland = new Set([
    "components/backdropRestoration.ts",
    "components/compositionRuntime.ts",
    "components/compositionSurface.ts",
    "components/cssBackdrop.ts",
    "components/legacyCssBackdropValidation.ts",
  ]);
  for (const removed of [
    ...legacyCompositorIsland,
    "components/cssBackdropOutput.ts",
  ])
    expect(productionSources[removed]).toBeUndefined();
  for (const target of [
    "backdropRestoration",
    "compositionRuntime",
    "compositionSurface",
    "cssBackdrop",
    "legacyCssBackdropValidation",
    "compositionBackendPlan",
  ])
    expect(
      importers(target).filter((path) => !legacyCompositorIsland.has(path)),
    ).toEqual([]);

  const legacyCaptureIsland = new Set([
    ...legacyCompositorIsland,
    "components/sceneTextureCapture.ts",
  ]);
  for (const target of ["elementRaster", "domRaster"])
    expect(
      importers(target).filter((path) => !legacyCaptureIsland.has(path)),
    ).toEqual([]);
  expect(importers("sceneTextureCapture")).toEqual([
    "components/sceneTexture.ts",
  ]);
});

it("keeps observers and frame-time traversal out of the normal hot path", () => {
  for (const normal of [
    "SlideRenderer.tsx",
    "EffectSurface.tsx",
    "effectRuntime.ts",
    "useMotionRuntime.ts",
  ])
    expect(component(normal)).not.toContain("MutationObserver");

  expect(component("sceneTextureCapture.ts")).toContain("MutationObserver");

  const hook = component("useMotionRuntime.ts");
  expect(hook).not.toContain("useState");
  const motion = component("motionRuntime.ts");
  const start = motion.indexOf("const materialize =");
  const end = motion.indexOf("finish();", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const hotPath = motion.slice(start, end);
  expect(hotPath).toContain("if (presenceOnly) return;");
  for (const forbidden of [
    "querySelector",
    "walkElements",
    "MutationObserver",
    "createElement",
    "resizeRasterCanvas",
    "sceneTexture",
  ])
    expect(hotPath).not.toContain(forbidden);
});

it("presents terminal shaders through bounded shared GPU contexts without Canvas2D copies", () => {
  const runtime = component("effectRuntime.ts");
  const output = component("shaderOutput.ts");
  expect(runtime).toContain("gl.bindFramebuffer(gl.FRAMEBUFFER, null)");
  expect(runtime).toContain('canvas.getContext("webgl2"');
  expect(runtime).toContain("new OffscreenCanvas(1, 1)");
  expect(runtime).toContain("transferToImageBitmap()");
  expect(runtime).toContain("transferFromImageBitmap(bitmap)");
  expect(runtime).not.toContain('canvas.getContext("2d")');
  expect(runtime).not.toContain(".drawImage(");
  expect(output).not.toContain("neutralShaderBridge");
});

it("feeds shader sampling from semantic Motion transforms instead of CSS discovery", () => {
  const runtime = component("effectRuntime.ts");
  const motion = component("motionRuntime.ts");
  expect(runtime).toContain("setTransport(matrix)");
  expect(runtime).toContain("if (content?.scene?.().deck.stylesheet?.trim())");
  expect(runtime).not.toContain("elementWorldTransform");
  expect(motion).toContain("semanticWorldTransform");
  const start = motion.indexOf('const detachClock = clock.on("change"');
  const end = motion.indexOf("if (duration &&", start);
  const clockHotPath = motion.slice(start, end);
  for (const forbidden of [
    "getComputedStyle",
    "querySelector",
    "walkElements",
    "createElement",
  ])
    expect(clockHotPath).not.toContain(forbidden);
});

it("keeps generated and direct GPU shader inputs independent of SceneTexture", () => {
  const runtime = component("effectRuntime.ts");
  const condition = runtime.indexOf(
    'if (definition.input === "content" || definition.input === "backdrop")',
  );
  const factory = runtime.indexOf("sceneTextureFactory = () =>");
  expect(condition).toBeGreaterThan(-1);
  expect(factory).toBeGreaterThan(condition);
  expect(runtime.slice(condition, factory)).not.toContain(
    'definition.input === "none"',
  );
  expect(runtime).toMatch(
    /const renderedInput =\s*!gpuInput && !directShaderInput && !ownedMediaInput\s*\? renderedSceneTexture\(\)\s*: null;/,
  );
  expect(runtime).toContain("if (!sceneTexture && sceneTextureFactory)");
});
