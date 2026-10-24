import { expect, test } from "@playwright/test";

test("unresolved images are never retained before an asset arrives while SceneTexture is unmounted", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const results = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const mediaPath = "/src/core/media.ts";
    const factoryPath = "/src/core/elementFactory.ts";
    const platformPath = "/src/platform/index.ts";
    const texturePath = "/src/components/sceneTexture.ts";
    const effectsPath = "/src/core/effects.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const { createMediaElement }: typeof import("../../../src/core/media") =
      await import(/* @vite-ignore */ mediaPath);
    const {
      createContainerElement,
    }: typeof import("../../../src/core/elementFactory") = await import(
      /* @vite-ignore */ factoryPath
    );
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ platformPath
    );
    const {
      sceneTextureDiagnostics,
    }: typeof import("../../../src/components/sceneTexture") = await import(
      /* @vite-ignore */ texturePath
    );
    const { newEffectInstance }: typeof import("../../../src/core/effects") =
      await import(/* @vite-ignore */ effectsPath);
    const originalAssetUrl = platform.assetUrl;
    const originalReleaseUrl = platform.releaseUrl;
    const bitmap = document.createElement("canvas");
    bitmap.width = bitmap.height = 32;
    const context = bitmap.getContext("2d")!;
    context.fillStyle = "red";
    context.fillRect(0, 0, 32, 32);
    const url = bitmap.toDataURL();
    const results = [];
    try {
      for (const kind of ["content", "backdrop"] as const) {
        let available = false;
        platform.assetUrl = async () => (available ? url : null);
        platform.releaseUrl = () => {};
        const before = sceneTextureDiagnostics();
        const first = await mountMixedEffectsHarness(undefined, 0, undefined, {
          configure(model) {
            delete model.deck.stylesheet;
            const slide = model.slides[model.deck.slideIds[0]];
            const image = createMediaElement(
              `late-${kind}`,
              {
                version: 1,
                id: "e".repeat(64),
                filename: "late.png",
                names: ["late.png"],
                type: "image",
                mediaType: "image",
                mime: "image/png",
                bytes: 1,
                width: 32,
                height: 32,
                createdAt: "2026-10-24T00:00:00Z",
              },
              { x: 0, y: 0 },
            );
            Object.assign(image.frame, { width: 640, height: 360 });
            if (kind === "content") {
              const group = createContainerElement("late-group", [image], {
                x: 0,
                y: 0,
              });
              group.effects = [
                newEffectInstance(
                  "shader",
                  slide.effectResources!.shader,
                  "content",
                ),
              ];
              slide.nodes[0].children = [group];
            } else {
              slide.nodes[0].children = [image, slide.nodes[0].children[1]];
            }
          },
        });
        const model = first.model;
        const unchanged = JSON.stringify(model);
        const missing = !!first.host.querySelector(
          '[data-missing-media="true"]',
        );
        const missingSnapshots =
          sceneTextureDiagnostics().retainedSnapshots -
          before.retainedSnapshots;
        first.dispose();
        const providersWhileAbsent = sceneTextureDiagnostics().activeProviders;
        // The asset becomes available without any mounted provider or document edit.
        available = true;
        const decoded = new Image();
        decoded.src = url;
        await decoded.decode();
        const reopened = await mountMixedEffectsHarness(model);
        try {
          const images = [...reopened.host.querySelectorAll("img")];
          await Promise.all(images.map((image) => image.decode()));
          const state = await reopened.stage(0);
          results.push({
            kind,
            missing,
            missingSnapshots,
            providersWhileAbsent,
            loaded:
              images.length === 1 &&
              images.every((image) => image.complete && image.naturalWidth > 0),
            colored:
              kind === "content"
                ? state.surfaces[0].green
                : state.surfaces[0].red,
            unchanged: unchanged === JSON.stringify(model),
            errors: state.errors,
          });
        } finally {
          reopened.dispose();
        }
      }
      return results;
    } finally {
      platform.assetUrl = originalAssetUrl;
      platform.releaseUrl = originalReleaseUrl;
    }
  });
  for (const result of results) {
    expect(result.missing).toBe(true);
    expect(result.providersWhileAbsent).toBe(0);
    expect(result.missingSnapshots).toBe(0);
    expect(result.loaded).toBe(true);
    expect(result.colored).toBeGreaterThan(1000);
    expect(result.unchanged).toBe(true);
    expect(result.errors).toEqual([]);
  }
});

test("retention follows sampled Motion and Presence dependencies instead of the whole slide", async ({
  page,
}) => {
  await page.goto("/tests/helpers/effects-harness.html");
  const results = await page.evaluate(async () => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const factoryPath = "/src/core/elementFactory.ts";
    const texturePath = "/src/components/sceneTexture.ts";
    const presencePath = "/src/core/presence.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const {
      createBasicShape,
      createContainerElement,
    }: typeof import("../../../src/core/elementFactory") = await import(
      /* @vite-ignore */ factoryPath
    );
    const {
      sceneTextureDiagnostics,
    }: typeof import("../../../src/components/sceneTexture") = await import(
      /* @vite-ignore */ texturePath
    );
    const { addPresence }: typeof import("../../../src/core/presence") =
      await import(/* @vite-ignore */ presencePath);
    await document.fonts.ready;
    const results = [];
    for (const dependency of [
      "later-motion",
      "source-motion",
      "target-motion",
      "ancestor-motion",
      "source-presence",
      "later-presence",
    ] as const) {
      const before = sceneTextureDiagnostics();
      const first = await mountMixedEffectsHarness(undefined, 0, undefined, {
        configure(model) {
          delete model.deck.stylesheet;
          const slide = model.slides[model.deck.slideIds[0]];
          const [text, glass] = slide.nodes[0].children;
          text.effects = [];
          const group = createContainerElement(
            "sampling-group",
            [text, glass],
            { x: 0, y: 0 },
          );
          const later = createBasicShape("later", "rectangle", {
            x: 500,
            y: 300,
          });
          slide.nodes[0].children = [group, later];
          const id = dependency.startsWith("later")
            ? later.id
            : dependency.startsWith("source")
              ? text.id
              : dependency === "target-motion"
                ? glass.id
                : group.id;
          slide.motion = dependency.endsWith("presence")
            ? addPresence(undefined, 0, [id])
            : {
                stages: [
                  {
                    id: "move-stage",
                    tracks: [
                      {
                        id: "move-track",
                        elementId: id,
                        property: "transform.x",
                        keyframes: [
                          {
                            id: "start",
                            at: 0,
                            value: { type: "absolute", value: 0 },
                            easeToNext: "linear",
                          },
                          {
                            id: "end",
                            at: 1000,
                            value: { type: "absolute", value: 100 },
                          },
                        ],
                      },
                    ],
                  },
                ],
              };
        },
      });
      const model = first.model;
      const firstState = await first.stage(0);
      const prepared = sceneTextureDiagnostics();
      first.dispose();
      const warm = await mountMixedEffectsHarness(model);
      try {
        const state = await warm.stage(0);
        const after = sceneTextureDiagnostics();
        results.push({
          dependency,
          snapshots: prepared.retainedSnapshots - before.retainedSnapshots,
          revisitCaptures: after.captures - prepared.captures,
          retainedReuses: after.retainedReuses - prepared.retainedReuses,
          errors: [...firstState.errors, ...state.errors],
        });
      } finally {
        warm.dispose();
      }
    }
    return results;
  });
  for (const result of results) {
    expect(result.errors).toEqual([]);
    if (result.dependency.startsWith("later")) {
      expect(result.snapshots).toBeGreaterThan(0);
      expect(result.revisitCaptures).toBe(0);
      expect(result.retainedReuses).toBeGreaterThan(0);
    } else {
      expect(result.snapshots).toBe(0);
      expect(result.revisitCaptures).toBeGreaterThan(0);
      expect(result.retainedReuses).toBe(0);
    }
  }
});
