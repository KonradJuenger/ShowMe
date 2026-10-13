import { chromium } from "@playwright/test";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Manual diagnostic only. Start Vite on port 5187 before running from repo root.
const out = "test-results-frame-seams-investigation";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const browserVersion = browser.version();
const results = [];
const errors = [];
try {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 1500 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5187");
    await page.evaluate(async () => {
      const [
        reactModule,
        clientModule,
        domModule,
        { SlideRenderer },
        { newPresentationDocument },
        factories,
      ] = await Promise.all([
        import("/node_modules/.vite/deps/react.js"),
        import("/node_modules/.vite/deps/react-dom_client.js"),
        import("/node_modules/.vite/deps/react-dom.js"),
        import("/src/components/SlideRenderer.tsx"),
        import("/src/core/document.ts"),
        import("/src/core/elementFactory.ts"),
      ]);
      const React = reactModule.default ?? reactModule;
      const { createRoot } = clientModule.default ?? clientModule;
      const { flushSync } = domModule.default ?? domModule;
      document.body.replaceChildren();
      document.body.style.cssText = "margin:0;background:white;overflow:hidden";
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      window.renderCases = (cases, scale) => {
        const rows = cases.map((c, index) => {
          const model = newPresentationDocument("Seam experiment");
          model.deck.width = 500;
          model.deck.height = 50;
          const slide = model.slides[model.deck.slideIds[0]];
          slide.background = "#ffffff";
          const factory =
            c.kind === "frame"
              ? factories.createEmptyFrame
              : (id, point) =>
                  factories.createBasicShape(id, "rectangle", point);
          const make = (id, x, width) => {
            const el = factory(id, { x, y: 0 });
            Object.assign(el.frame, { width, height: 32 });
            Object.assign(el.appearance, {
              fill: "#336699",
              opacity: c.opacity ?? 1,
            });
            return el;
          };
          slide.nodes[0].children = [
            make("left", 0, c.width),
            make("right", c.width, c.width),
          ];
          return React.createElement(
            "div",
            {
              key: c.variant + "-" + scale + "-" + index,
              style: {
                position: "absolute",
                left: 16 + c.shift / window.devicePixelRatio,
                top: 16 + index * 80,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              },
            },
            React.createElement(SlideRenderer, {
              deck: model.deck,
              slide,
              staticVideo: true,
            }),
          );
        });
        flushSync(() =>
          root.render(React.createElement(React.Fragment, null, ...rows)),
        );
      };
    });
    for (const variant of [
      "aligned",
      "half-device-pixel",
      "aligned-transparent",
      "half-device-pixel-transparent",
    ])
      for (const scale of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]) {
        const cases = [];
        for (const kind of ["frame", "shape"])
          for (const width of [128, 130])
            cases.push({
              kind,
              width,
              variant,
              shift: variant.startsWith("half") ? 0.5 : 0,
              opacity: variant.endsWith("transparent") ? 0.5 : 1,
            });
        await page.evaluate(
          ({ cases, scale }) => window.renderCases(cases, scale),
          { cases, scale },
        );
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        const measured = await page.evaluate(() =>
          Array.from(document.body.firstElementChild.children).map((row) => {
            const l = row
                .querySelector('[data-element-id="left"]')
                .getBoundingClientRect(),
              r = row
                .querySelector('[data-element-id="right"]')
                .getBoundingClientRect();
            return {
              left: l.left,
              seam: l.right,
              right: r.right,
              top: l.top,
              bottom: l.bottom,
              y: l.top + l.height / 2,
              gap: r.left - l.right,
            };
          }),
        );
        const png = await page.screenshot();
        const { data, info } = await sharp(png)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const rgb = (x, y) =>
          Array.from(
            data.subarray(
              (y * info.width + x) * 3,
              (y * info.width + x) * 3 + 3,
            ),
          );
        const samples = cases.map((c, i) => {
          const seam = measured[i].seam * dpr;
          const y = Math.floor(measured[i].y * dpr);
          const pixels = [];
          for (let x = Math.floor(seam) - 2; x <= Math.ceil(seam) + 2; x++)
            pixels.push({ x, rgb: rgb(x, y) });
          const interior = rgb(
            Math.floor((measured[i].left + 20 * scale) * dpr),
            y,
          );
          return {
            ...c,
            dpr,
            scale,
            seam,
            geometry: measured[i],
            allEdgesAligned: [
              measured[i].left,
              measured[i].seam,
              measured[i].right,
              measured[i].top,
              measured[i].bottom,
            ].every((v) => Math.abs(v * dpr - Math.round(v * dpr)) < 0.0001),
            pixels,
            interior,
            seamVisible: pixels.some((p) =>
              p.rgb.some((v, i) => v !== interior[i]),
            ),
          };
        });
        results.push(...samples);
        if (dpr === 1 && scale === 0.25)
          await writeFile(`${out}/${variant}.png`, png);
      }
    await context.close();
  }
} finally {
  await browser.close();
}
const difference = (r) =>
  Math.max(
    ...r.pixels.flatMap((p) =>
      p.rgb.map((v, i) => Math.abs(v - r.interior[i])),
    ),
  );
const aligned = results.filter((r) => r.allEdgesAligned);
const summary = {
  browserVersion,
  nodeVersion: process.version,
  platform: process.platform,
  cases: results.length,
  fullyAlignedCases: aligned.length,
  fullyAlignedExactDifferences: aligned.filter((r) => difference(r) > 0).length,
  fractionalDifferencesOver2: results.filter(
    (r) => !r.allEdgesAligned && difference(r) > 2,
  ).length,
  errors,
};
await writeFile(
  `${out}/matrix.json`,
  JSON.stringify({ summary, results }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
assert.deepEqual(errors, []);
assert.equal(results.length, 448);
assert.equal(aligned.length, 168);
assert(
  aligned.every((r) => difference(r) === 0),
  "Aligned control developed a seam; inspect matrix.json before drawing conclusions.",
);
assert(
  results.some((r) => !r.allEdgesAligned && difference(r) > 2),
  "Fractional seam did not reproduce in this browser.",
);
