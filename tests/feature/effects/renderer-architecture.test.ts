import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const component = (name: string) =>
  readFileSync(
    new URL("../../../src/components/" + name, import.meta.url),
    "utf8",
  );

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

it("uses SceneTexture as the sole shader doorway to legacy scene capture", () => {
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
});

it("keeps observers inside the exceptional SceneTexture adapter", () => {
  for (const normal of [
    "SlideRenderer.tsx",
    "EffectSurface.tsx",
    "effectRuntime.ts",
    "useMotionRuntime.ts",
  ])
    expect(component(normal)).not.toContain("MutationObserver");

  expect(component("sceneTextureLegacy.ts")).toContain("MutationObserver");
});

it("keeps generated shaders independent of SceneTexture", () => {
  const runtime = component("effectRuntime.ts");
  const condition = runtime.indexOf(
    'if (definition.input === "content" || definition.input === "backdrop")',
  );
  const creation = runtime.indexOf("sceneTexture = createSceneTextureProvider(");
  expect(condition).toBeGreaterThan(-1);
  expect(creation).toBeGreaterThan(condition);
  expect(runtime.slice(condition, creation)).not.toContain(
    'definition.input === "none"',
  );
});
