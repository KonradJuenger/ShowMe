import { _electron as electron } from "@playwright/test";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
if (!process.argv[2])
  throw new Error("Usage: node scripts/verify-effect-alignment.mjs file.sme");
const model = JSON.parse(await readFile(path.resolve(process.argv[2]), "utf8"));
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "showme-effects-alignment-"),
);
const entry = path.join(temporary, "main.cjs");
await writeFile(
  entry,
  "const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('enable-blink-features','CanvasDrawElement');app.whenReady().then(()=>{const win=new BrowserWindow({width:1920,height:1080,show:false,webPreferences:{backgroundThrottling:false}});win.showInactive();win.loadURL('http://127.0.0.1:5173/tests/helpers/effects-harness.html');});",
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const browser = await electron.launch({
  args: [entry, `--user-data-dir=${path.join(temporary, "profile")}`],
  env,
});
try {
  const page = await browser.firstWindow();
  await page.waitForSelector("#root", { state: "attached" });
  await mkdir("test-results-effects-alignment", { recursive: true });
  const report = [];
  for (const zoom of [0.35, 0.57, 1, 2]) {
    for (let index = 0; index < model.deck.slideIds.length; index++) {
      for (const variant of ["original", "shader"]) {
        const data = structuredClone(model);
        const slide = data.slides[data.deck.slideIds[index]];
        const visit = (elements) => {
          // Isolate the reported red rectangle/text geometry. Real media is
          // exercised through the Electron asset broker by stress-effects.mjs.
          for (let i = elements.length - 1; i >= 0; i--)
            if (["image", "video"].includes(elements[i].content?.type))
              elements.splice(i, 1);
          for (const element of elements) {
            // Isolate text alignment from the lens frame's own outline.
            element.appearance.strokeWidth = 0;
            for (const effect of element.effects ?? []) {
              const definition = slide.effectResources[effect.resourceId];
              if (definition.kind === "fragment-glsl") {
                if (variant === "original") effect.enabled = false;
                else {
                  effect.parameters.strength = 0;
                  definition.source =
                    "#version 300 es\nprecision highp float;uniform sampler2D u_input;in vec2 v_uv;out vec4 outColor;void main(){outColor=texture(u_input,v_uv);}";
                }
              }
            }
            visit(element.children);
          }
        };
        slide.nodes.forEach((node) => visit(node.children));
        await page.evaluate(
          async ({ data, index, backend, zoom }) => {
            window.alignment?.dispose();
            const { setDomRasterExperimentBackend } =
              await import("/src/components/domRaster.ts");
            setDomRasterExperimentBackend(backend);
            const { mountMixedEffectsHarness } =
              await import("/tests/helpers/mixedEffectsHarness.tsx");
            window.alignment = await mountMixedEffectsHarness(data, index);
            await window.alignment.setZoom(zoom);
            await window.alignment.advance(0.5, 1, 1);
          },
          { data, index, backend: process.argv[3] ?? "native", zoom },
        );
        await page
          .locator(".slide-renderer")
          .first()
          .screenshot({
            path: `test-results-effects-alignment/zoom-${zoom}-slide-${index + 1}-${variant}.png`,
          });
      }
      const first = await sharp(
        `test-results-effects-alignment/zoom-${zoom}-slide-${index + 1}-original.png`,
      )
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const second = await sharp(
        `test-results-effects-alignment/zoom-${zoom}-slide-${index + 1}-shader.png`,
      )
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const bounds = (buffer, red = false) => {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = 0,
          y1 = 0,
          count = 0;
        let coverage = 0;
        for (let y = 0; y < first.info.height; y++)
          for (let x = 0; x < first.info.width; x++) {
            const at = (y * first.info.width + x) * 4;
            const dark =
              buffer[at] < 100 && buffer[at + 1] < 100 && buffer[at + 2] < 100;
            const yellow =
              buffer[at] > 180 &&
              buffer[at + 1] > 90 &&
              buffer[at + 1] < 230 &&
              buffer[at + 2] < 60;
            const redPixel =
              buffer[at] > 200 && buffer[at + 1] < 40 && buffer[at + 2] < 40;
            if (red) coverage += redPixel ? 1 : 0;
            else
              coverage +=
                (255 - Math.max(buffer[at], buffer[at + 1], buffer[at + 2])) /
                  255 +
                (buffer[at] > 180 && buffer[at + 2] < 60
                  ? buffer[at + 1] / 255
                  : 0);
            if (red ? redPixel : dark || yellow) {
              x0 = Math.min(x0, x);
              y0 = Math.min(y0, y);
              x1 = Math.max(x1, x);
              y1 = Math.max(y1, y);
              count++;
            }
          }
        return { x0, y0, x1, y1, count, coverage };
      };
      let different = 0;
      const diff = Buffer.alloc(first.data.length);
      for (let i = 0; i < first.data.length; i += 4) {
        const delta = Math.max(
          ...[0, 1, 2].map((c) =>
            Math.abs(first.data[i + c] - second.data[i + c]),
          ),
        );
        if (delta > 20) different++;
        diff[i] = delta;
        diff[i + 1] = 0;
        diff[i + 2] = 0;
        diff[i + 3] = 255;
      }
      await sharp(diff, { raw: first.info })
        .png()
        .toFile(
          `test-results-effects-alignment/zoom-${zoom}-slide-${index + 1}-difference.png`,
        );
      const original = bounds(first.data),
        shader = bounds(second.data);
      report.push({
        slide: index + 1,
        zoom,
        original,
        shader,
        textCoverageChange: original.coverage
          ? (shader.coverage - original.coverage) / original.coverage
          : 0,
        originalRed: bounds(first.data, true),
        shaderRed: bounds(second.data, true),
        different,
      });
    }
  }
  console.log(JSON.stringify(report, null, 2));
  await writeFile(
    "test-results-effects-alignment/report.json",
    JSON.stringify(report, null, 2),
  );
  if (
    report.some((row) =>
      [
        [row.original, row.shader],
        [row.originalRed, row.shaderRed],
      ].some(([original, shader]) =>
        ["x0", "y0", "x1", "y1"].some(
          (key) => Math.abs(original[key] - shader[key]) > 1,
        ),
      ),
    )
  )
    throw new Error("Shader changes the red rectangle or text position");
} finally {
  await browser.close();
  if (
    path.dirname(temporary) !== os.tmpdir() ||
    !path.basename(temporary).startsWith("showme-effects-alignment-")
  )
    throw new Error("Unexpected temporary path");
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}
