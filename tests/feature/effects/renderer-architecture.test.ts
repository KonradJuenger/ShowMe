import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const components = new URL("../../../src/components/", import.meta.url);
const component = (name: string) =>
  readFileSync(new URL(name, components), "utf8");
const productionSources = Object.fromEntries(
  readdirSync(components)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => [name, component(name)]),
);
const importers = (name: string) =>
  Object.entries(productionSources)
    .filter(([, source]) =>
      new RegExp(`from\\s+["']\\./${name}["']`).test(source),
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

it("uses SceneTexture as the sole production doorway to legacy scene capture", () => {
  const runtime = component("effectRuntime.ts");
  const boundary = component("sceneTexture.ts");
  const adapter = component("sceneTextureLegacy.ts");

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
  expect(boundary).toContain('from "./sceneTextureLegacy"');
  expect(boundary).not.toContain("elementRaster");
  expect(boundary).not.toContain("domRaster");
  expect(adapter).toContain('from "./elementRaster"');
  expect(adapter).toContain('from "./domRaster"');

  const legacyCompositorIsland = new Set([
    "backdropRestoration.ts",
    "compositionRuntime.ts",
    "compositionSurface.ts",
    "cssBackdrop.ts",
    "legacyCssBackdropValidation.ts",
  ]);
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
    "sceneTextureLegacy.ts",
  ]);
  for (const target of ["elementRaster", "domRaster"])
    expect(
      importers(target).filter((path) => !legacyCaptureIsland.has(path)),
    ).toEqual([]);
  expect(importers("sceneTextureLegacy")).toEqual(["sceneTexture.ts"]);
});

it("keeps observers and frame-time traversal out of the normal hot path", () => {
  for (const normal of [
    "SlideRenderer.tsx",
    "EffectSurface.tsx",
    "effectRuntime.ts",
    "useMotionRuntime.ts",
  ])
    expect(component(normal)).not.toContain("MutationObserver");

  expect(component("sceneTextureLegacy.ts")).toContain("MutationObserver");

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
  expect(runtime).toContain(
    "const renderedInput = !gpuInput ? renderedSceneTexture() : null;",
  );
  expect(runtime).toContain("if (!sceneTexture && sceneTextureFactory)");
});
