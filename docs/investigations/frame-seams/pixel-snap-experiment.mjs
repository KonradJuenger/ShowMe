import { chromium } from "@playwright/test";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const out = "test-results-pixel-snap";
await mkdir(out, { recursive: true });
const imageCases = process.argv[3] === "images";
const browser = await chromium.launch();
const results = [],
  errors = [];
try {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1500 },
      deviceScaleFactor: dpr,
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:5187");
    await page.evaluate(async () => {
      const [
        r,
        c,
        d,
        { SlideRenderer },
        { newPresentationDocument },
        factories,
        { snapRect },
      ] = await Promise.all([
        import("/node_modules/.vite/deps/react.js"),
        import("/node_modules/.vite/deps/react-dom_client.js"),
        import("/node_modules/.vite/deps/react-dom.js"),
        import("/src/components/SlideRenderer.tsx"),
        import("/src/core/document.ts"),
        import("/src/core/elementFactory.ts"),
        import("/docs/investigations/frame-seams/pixel-snap-math.mjs"),
      ]);
      const React = r.default ?? r,
        { createRoot } = c.default ?? c,
        { flushSync } = d.default ?? d;
      const { platform } = await import("/src/platform/index.ts");
      const texture = document.createElement("canvas");
      texture.width = 120;
      texture.height = 32;
      const ctx = texture.getContext("2d");
      ctx.fillStyle = "rgba(51,102,153,.5)";
      ctx.fillRect(0, 0, 120, 32);
      const assetUrl = texture.toDataURL("image/png");
      platform.assetUrl = async () => assetUrl;
      platform.releaseUrl = () => {};
      document.body.replaceChildren();
      document.body.style.cssText = "margin:0;background:white";
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      window.fixture = {};
      window.mount = (cases, scale, mode) => {
        const models = [],
          rows = cases.map((v, index) => {
            const model = newPresentationDocument("Pixel snap experiment");
            model.deck.width = 500;
            model.deck.height = 50;
            const slide = model.slides[model.deck.slideIds[0]];
            slide.background = "#ffffff";
            const make = (id, x) => {
              const el =
                v.kind === "frame"
                  ? factories.createEmptyFrame(id, { x, y: 5 })
                  : factories.createBasicShape(id, "rectangle", { x, y: 5 });
              Object.assign(el.frame, { width: v.width, height: 32 });
              Object.assign(el.appearance, {
                fill: "#336699",
                opacity: v.opacity,
              });
              return el;
            };
            slide.nodes[0].children = [
              make("left", 10 + v.offset),
              make("right", 10 + v.offset + v.width),
            ];
            if (v.kind === "image")
              for (const el of slide.nodes[0].children) {
                el.clipChildren = true;
                el.appearance.fill = null;
                el.content = {
                  type: "image",
                  assetId: "snap-alpha",
                  filename: "alpha.png",
                  mediaType: "image/png",
                  opacity: 1,
                  lockAspect: true,
                  transform: {
                    rule: "fill",
                    intrinsicWidth: 120,
                    intrinsicHeight: 32,
                    rotation: 0,
                    flipX: false,
                    flipY: false,
                    anchorX: 0.5,
                    anchorY: 0.5,
                    zoom: 1,
                  },
                };
              }
            models.push(model);
            const style = {
              position: "absolute",
              left: 10.375,
              top: 10.25 + index * 65,
              width: 500,
              height: 50,
              transform: "scale(" + scale + ")",
              transformOrigin: "top left",
            };
            if (mode === "snap-zoom") {
              style.transform = "none";
              style.zoom = scale;
              style.left = 10.375 / scale;
              style.top = (10.25 + index * 65) / scale;
            }
            return React.createElement(
              "div",
              {
                key: mode + "-" + scale + "-" + v.opacity + "-" + index,
                style,
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
        window.fixture = {
          cases,
          scale,
          mode,
          models,
          before: JSON.stringify(models),
          snapRect,
        };
      };
      window.snap = () => {
        const { cases, scale, mode, models, snapRect } = window.fixture;
        const targets = Array.from(host.children).map((row, index) => {
          const b = row.getBoundingClientRect();
          const view = {
            originX: b.left,
            originY: b.top,
            scaleX: b.width / 500,
            scaleY: b.height / 50,
            dpr: devicePixelRatio,
          };
          return {
            row,
            view,
            elements:
              models[index].slides[models[index].deck.slideIds[0]].nodes[0]
                .children,
          };
        });
        // Read all origins before writes, avoiding per-element layout read/write cycles.
        for (const { row, view, elements } of targets) {
          if (mode.startsWith("snap-device-")) {
            const originX = Math.round(view.originX * view.dpr),
              originY = Math.round(view.originY * view.dpr);
            Object.assign(row.style, {
              transform: "none",
              zoom: String(1 / view.dpr),
              left: originX + "px",
              top: originY + "px",
              width: 500 * view.scaleX * view.dpr + "px",
              height: 50 * view.scaleY * view.dpr + "px",
            });
            if (mode === "snap-device-matrix")
              Object.assign(row.style, {
                zoom: "1",
                left: "0px",
                top: "0px",
                transform:
                  "matrix(" +
                  1 / view.dpr +
                  ",0,0," +
                  1 / view.dpr +
                  "," +
                  originX / view.dpr +
                  "," +
                  originY / view.dpr +
                  ")",
              });
            Object.assign(row.querySelector(".slide-renderer").style, {
              width: 500 * view.scaleX * view.dpr + "px",
              height: 50 * view.scaleY * view.dpr + "px",
            });
          }
          for (const el of elements) {
            const dom = row.querySelector('[data-element-id="' + el.id + '"]');
            if (mode !== "baseline") {
              const next = snapRect(el.frame, view);
              Object.assign(dom.style, {
                left: next.x + "px",
                top: next.y + "px",
                width: next.width + "px",
                height: next.height + "px",
              });
              if (mode.startsWith("snap-device-")) {
                const left = Math.round(
                    (view.originX + el.frame.x * view.scaleX) * view.dpr,
                  ),
                  top = Math.round(
                    (view.originY + el.frame.y * view.scaleY) * view.dpr,
                  );
                const right = Math.round(
                    (view.originX +
                      (el.frame.x + el.frame.width) * view.scaleX) *
                      view.dpr,
                  ),
                  bottom = Math.round(
                    (view.originY +
                      (el.frame.y + el.frame.height) * view.scaleY) *
                      view.dpr,
                  );
                Object.assign(dom.style, {
                  left: left - Math.round(view.originX * view.dpr) + "px",
                  top: top - Math.round(view.originY * view.dpr) + "px",
                  width: right - left + "px",
                  height: bottom - top + "px",
                });
                const media = dom.querySelector('[data-showme-part="content"]');
                if (media)
                  Object.assign(media.style, {
                    left: "0px",
                    top: "0px",
                    width: right - left + "px",
                    height: bottom - top + "px",
                    transform: "none",
                  });
              }
              if (mode === "snap-no-transform") dom.style.transform = "none";
              if (mode === "snap-element-matrix") {
                const left = Math.round(
                  (view.originX + el.frame.x * view.scaleX) * view.dpr,
                );
                const top = Math.round(
                  (view.originY + el.frame.y * view.scaleY) * view.dpr,
                );
                const right = Math.round(
                  (view.originX + (el.frame.x + el.frame.width) * view.scaleX) *
                    view.dpr,
                );
                const bottom = Math.round(
                  (view.originY +
                    (el.frame.y + el.frame.height) * view.scaleY) *
                    view.dpr,
                );
                const x = (left / view.dpr - view.originX) / view.scaleX;
                const y = (top / view.dpr - view.originY) / view.scaleY;
                Object.assign(dom.style, {
                  left: "0px",
                  top: "0px",
                  width: right - left + "px",
                  height: bottom - top + "px",
                  transformOrigin: "0px 0px",
                  transform: `matrix(${1 / (view.scaleX * view.dpr)},0,0,${1 / (view.scaleY * view.dpr)},${x},${y})`,
                });
              }
            }
          }
        }
        return JSON.stringify(models) === window.fixture.before;
      };
      window.measure = () =>
        Array.from(host.children).map((row) => {
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
        });
    });
    for (const mode of process.argv[2]
      ? [process.argv[2]]
      : ["baseline", "snap-local", "snap-no-transform", "snap-zoom"])
      for (const scale of [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2])
        for (const opacity of [1, 0.5]) {
          const cases = [];
          for (const kind of imageCases ? ["image"] : ["frame", "shape"])
            for (const width of [120, 120.3])
              for (const offset of [0, 0.25, 0.5, 0.75])
                cases.push({ kind, width, offset, opacity });
          await page.evaluate(
            ({ cases, scale, mode }) => window.mount(cases, scale, mode),
            { cases, scale, mode },
          );
          await page.evaluate(
            () =>
              new Promise((r) =>
                requestAnimationFrame(() => requestAnimationFrame(r)),
              ),
          );
          if (imageCases)
            await page.waitForFunction(
              () =>
                Array.from(document.querySelectorAll("img")).length > 0 &&
                Array.from(document.querySelectorAll("img")).every(
                  (img) => img.complete && img.naturalWidth > 0,
                ) &&
                Array.from(
                  document.querySelectorAll("[data-media-loading]"),
                ).every(
                  (node) => node.getAttribute("data-media-loading") !== "true",
                ),
            );
          const before = await page.evaluate(() => window.measure());
          assert(
            await page.evaluate(() => window.snap()),
            "Prototype mutated documents",
          );
          await page.evaluate(
            () =>
              new Promise((r) =>
                requestAnimationFrame(() => requestAnimationFrame(r)),
              ),
          );
          const after = await page.evaluate(() => window.measure());
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
          for (let i = 0; i < cases.length; i++) {
            const a = after[i],
              b = before[i],
              y = Math.floor(a.y * dpr),
              seam = a.seam * dpr;
            const interior = rgb(
                Math.floor((a.left + (a.seam - a.left) / 4) * dpr),
                y,
              ),
              pixels = [];
            for (let x = Math.floor(seam) - 2; x <= Math.ceil(seam) + 2; x++)
              pixels.push(rgb(x, y));
            const difference = Math.max(
              ...pixels.flatMap((p) =>
                p.map((v, k) => Math.abs(v - interior[k])),
              ),
            );
            const displacement = Math.max(
              ...["left", "seam", "right", "top", "bottom"].map(
                (k) => Math.abs(a[k] - b[k]) * dpr,
              ),
            );
            const gridResidual = Math.max(
              ...["left", "seam", "right", "top", "bottom"].map((k) =>
                Math.abs(a[k] * dpr - Math.round(a[k] * dpr)),
              ),
            );
            results.push({
              ...cases[i],
              mode,
              scale,
              dpr,
              before: b,
              after: a,
              interior,
              pixels,
              difference,
              displacement,
              gridResidual,
            });
          }
          if (dpr === 1 && scale === 0.25 && opacity === 0.5)
            await writeFile(`${out}/${mode}.png`, png);
        }
    await page.close();
  }
} finally {
  await browser.close();
}
const summary = Object.fromEntries(
  [...new Set(results.map((r) => r.mode))].map((m) => {
    const rows = results.filter((r) => r.mode === m);
    return [
      m,
      {
        cases: rows.length,
        exactDifferences: rows.filter((r) => r.difference > 0).length,
        over2: rows.filter((r) => r.difference > 2).length,
        maxDifference: Math.max(...rows.map((r) => r.difference)),
        maxDisplacement: Math.max(...rows.map((r) => r.displacement)),
        maxGridResidual: Math.max(...rows.map((r) => r.gridResidual)),
        maxJoinGap: Math.max(...rows.map((r) => Math.abs(r.after.gap) * r.dpr)),
      },
    ];
  }),
);
await writeFile(
  `${out}/visual${process.argv[2] ? "-" + process.argv[2] : ""}${imageCases ? "-images" : ""}.json`,
  JSON.stringify(
    { browserVersion: browser.version(), summary, errors, results },
    null,
    2,
  ),
);
console.log(JSON.stringify({ summary, errors }, null, 2));
assert.deepEqual(errors, []);
