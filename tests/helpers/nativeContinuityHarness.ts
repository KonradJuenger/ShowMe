import { mountMixedEffectsHarness } from "./mixedEffectsHarness";
import { createBasicShape } from "../../src/core/elementFactory";
import { createTextElement } from "../../src/core/text";
import { blankEffect } from "../../src/core/effectAuthoring";
import { newEffectInstance } from "../../src/core/effects";
import { createMediaElement } from "../../src/core/media";
import { platform } from "../../src/platform";

export async function mountNativeContinuity(
  background: "image" | "shader" = "image",
  grouped = false,
  mixed = false,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < 360; y += 8)
    for (let x = 0; x < 640; x += 8) {
      ctx.fillStyle = (x / 8 + y / 8) % 2 ? "#153c73" : "#e9eff6";
      ctx.fillRect(x, y, 8, 8);
    }
  const originalAssetUrl = platform.assetUrl;
  const imageUrl = canvas.toDataURL("image/png");
  const videoUrl = new URL(
    "/tests/fixtures/media/native-motion.webm",
    location.href,
  ).href;
  platform.assetUrl = async (id, preview) =>
    id === "d".repeat(64) && !preview ? videoUrl : imageUrl;
  const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
    liveMedia: mixed,
    configure(model) {
      model.deck.stylesheet = "";
      const slide = model.slides[model.deck.slideIds[0]];
      const glass = {
        ...blankEffect("css-js"),
        source:
          ":scope { backdrop-filter: blur(12px); background: rgba(255,255,255,.25); border-radius: 16px; overflow: hidden; }",
      };
      const generated = {
        ...blankEffect("shader"),
        input: "none" as const,
        source:
          "#version 300 es\nprecision highp float; in vec2 v_uv; out vec4 outColor; void main(){ vec2 p=floor(vec2(v_uv.x*640.,v_uv.y*360.)/8.); float c=mod(p.x+p.y,2.); outColor=vec4(mix(vec3(.914,.937,.965),vec3(.082,.235,.451),c),1.); }",
      };
      slide.effectResources = { glass, generated };
      const image = createMediaElement(
        "checker",
        {
          version: 1,
          id: "c".repeat(64),
          filename: "checker.png",
          names: ["checker.png"],
          type: "image",
          mediaType: "image",
          mime: "image/png",
          bytes: 1,
          width: 640,
          height: 360,
          createdAt: "2026-10-23T00:00:00Z",
        },
        { x: 0, y: 0 },
      );
      Object.assign(image.frame, { width: 640, height: 360 });
      const lower =
        background === "image"
          ? image
          : createBasicShape("checker", "rectangle", { x: 0, y: 0 });
      Object.assign(lower.frame, { width: 640, height: 360 });
      if (background === "shader")
        lower.effects = [
          newEffectInstance("generated", generated, "background"),
        ];
      const card = createBasicShape("card", "rectangle", { x: 120, y: 80 });
      Object.assign(card.frame, { width: 260, height: 180 });
      card.appearance.fill = "";
      card.appearance.radius = 16;
      card.clipChildren = true;
      card.effects = [newEffectInstance("glass", glass, "content")];
      const text = createTextElement("label", { x: 20, y: 100 });
      if (text.content?.type === "text") text.content.text = "Native glass";
      card.children = [text];
      if (mixed) {
        const js = {
          ...blankEffect("css-js"),
          kind: "text-js" as const,
          target: "text" as const,
          source:
            'function render({t}) { return "Native glass " + Math.floor(t * 10); }',
        };
        slide.effectResources.js = js;
        text.effects = [newEffectInstance("js", js, "content")];
        text.frame.y = 130;
        if (
          text.content?.type === "text" &&
          text.content.format.kind === "local"
        )
          text.content.format.typography.fontSize = 20;
        const video = createMediaElement(
          "movie",
          {
            version: 1,
            id: "d".repeat(64),
            filename: "moving.webm",
            names: ["moving.webm"],
            type: "video",
            mediaType: "video",
            mime: "video/webm",
            bytes: 1,
            width: 80,
            height: 40,
            duration: 0.4,
            createdAt: "2026-10-23T00:00:00Z",
          },
          { x: 20, y: 85 },
        );
        Object.assign(video.frame, { width: 80, height: 40 });
        if (video.content?.type === "video") video.content.loop = true;
        card.children.push(video);
      }
      const group = createBasicShape("group", "rectangle", { x: 0, y: 0 });
      Object.assign(group.frame, { width: 640, height: 360 });
      group.appearance.fill = "";
      const second = structuredClone(card);
      second.id = "second";
      second.children = [];
      second.frame.x = 270;
      second.frame.y = 150;
      second.effects = [newEffectInstance("glass", glass, "content")];
      group.children = [card, second];
      slide.nodes[0].children = grouped ? [lower, group] : [lower, card];
      slide.motion = {
        stages: [
          {
            id: "entrance",
            tracks: [],
            blocks: [
              {
                id: "presence",
                label: "Presence",
                members: [],
                binding: {
                  kind: "presence",
                  elementId: grouped ? "group" : "card",
                },
                presenceSchedule: {
                  version: 1,
                  startOffsetMs: 0,
                  end: { mode: "after", durationMs: 1400 },
                  enterTransition: {
                    kind: "move",
                    durationMs: 600,
                    direction: "Up",
                    distance: 24,
                    easing: [0, 0, 1, 1],
                  },
                  exitTransition: {
                    kind: "move",
                    durationMs: 600,
                    direction: "Down",
                    distance: 24,
                    easing: [0, 0, 1, 1],
                  },
                },
              },
            ],
          },
        ],
      };
    },
  });
  await Promise.all(
    [...harness.host.querySelectorAll("img")].map((image) => image.decode()),
  );
  if (mixed) {
    await new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const wait = () => {
        if (harness.host.querySelector("video")) resolve();
        else if (performance.now() > deadline)
          reject(new Error("Continuity video never mounted"));
        else requestAnimationFrame(wait);
      };
      wait();
    });
    for (const video of harness.host.querySelectorAll("video")) {
      if (video.readyState < 2)
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener(
            "error",
            () => reject(new Error("Continuity video failed to load")),
            { once: true },
          );
        });
      await video.play();
    }
  }
  return {
    ...harness,
    async sample(time: number, running = false) {
      await harness.setMotion({
        stageId: "entrance",
        stageIndex: 0,
        time,
        running,
        startedAt: Date.now(),
      });
      await harness.advance(time / 1000);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    dispose() {
      harness.dispose();
      platform.assetUrl = originalAssetUrl;
    },
  };
}
