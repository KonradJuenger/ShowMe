import { _electron } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
const noBorderShadow = process.argv.includes("--no-border-shadow");
const out = path.resolve(
  `test-results-native-filled-rounded${noBorderShadow ? "-no-border-shadow" : ""}`,
);
await mkdir(out, { recursive: true });
const main = path.join(out, "main.cjs");
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('force-device-scale-factor','1');app.whenReady().then(()=>{const w=new BrowserWindow({width:960,height:420,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL('about:blank');});`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ args: [main], env });
const page = await app.firstWindow();
const png = async (label) => {
  const b = await page.screenshot();
  await writeFile(path.join(out, label + ".png"), b);
  return (
    await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  ).data;
};
const metrics = (actual, reference, bg, alpha) => {
  const groups = {
    card: { sum: 0, max: 0, n: 0, x: 0, y: 0 },
    edge: { sum: 0, max: 0, n: 0, x: 0, y: 0 },
    interior: { sum: 0, max: 0, n: 0, x: 0, y: 0 },
  };
  for (let y = 65; y < 275; y++)
    for (let x = 75; x < 825; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * 960 + x) * 3 + c,
          e = Math.abs(
            actual[i] - (reference[i] * alpha + bg[i] * (1 - alpha)),
          );
        const dx = Math.min(x - 80, 819 - x),
          dy = Math.min(y - 70, 269 - y);
        for (const key of ["card", dx < 32 || dy < 32 ? "edge" : "interior"]) {
          const g = groups[key];
          g.sum += e;
          g.n++;
          if (e > g.max) {
            g.max = e;
            g.x = x;
            g.y = y;
          }
        }
      }
  return Object.fromEntries(
    Object.entries(groups).map(([k, g]) => [
      k,
      { mae: g.sum / g.n, max: g.max, x: g.x, y: g.y },
    ]),
  );
};
const rows = [];
try {
  for (const fill of ["", "#ffffff22"])
    for (const radius of [0, 28]) {
      await page.setContent(
        `<style>body{margin:0;background:repeating-linear-gradient(90deg,#1848a0 0 7px,#d9eaff 7px 14px)}#transport{position:absolute;left:80px;top:70px;width:740px;height:200px}.clip{position:relative;width:100%;height:100%;border-radius:${radius}px;overflow:hidden}.fill{position:absolute;inset:0;background:${fill || "transparent"};border-radius:${radius}px}.fx{position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.68),rgba(255,255,255,.24));backdrop-filter:blur(26px) saturate(125%);border:1px solid rgba(255,255,255,.78);border-radius:${radius}px;box-shadow:0 24px 65px rgba(39,65,130,.12),inset 0 1px 0 rgba(255,255,255,.8);overflow:hidden}.child{position:absolute;width:160px;height:100px}.one{left:36px;top:32px;background:#ff000088}.two{left:116px;top:72px;background:#00ff0088}.label{position:absolute;left:360px;top:60px;color:#202735;font:30px Arial}</style><div id="transport"><div class="clip"><div class="fill"></div><div class="fx"><div class="child one"></div><div class="child two"></div><div class="label">Establish the idea</div></div></div></div>`,
      );
      if (noBorderShadow)
        await page.addStyleTag({
          content: ".fx{border:none!important;box-shadow:none!important}",
        });
      const label = `${fill ? "filled" : "empty"}-r${radius}`;
      const original = await page.locator("#transport").innerHTML();
      const reference = await png(label + "-reference");
      await page
        .locator("#transport")
        .evaluate((n) => (n.style.display = "none"));
      const bg = await png(label + "-background");
      await page.locator("#transport").evaluate((n) => (n.style.display = ""));
      for (const candidate of [
        "visual-clip",
        "filter-clip-split",
        "outer-clip",
        "child-material",
        "svg-fill",
        "inverse-overlay",
      ]) {
        await page.locator("#transport").evaluate(
          (owner, { original, candidate, radius, fill }) => {
            owner.innerHTML = original;
            if (candidate === "inverse-overlay") {
              const overlay = document.createElement("div");
              overlay.id = "visual";
              overlay.style.cssText =
                "position:absolute;left:-2px;top:-2px;width:744px;height:204px;opacity:0;overflow:hidden;";
              const paint = document.createElement("div");
              paint.style.cssText =
                "position:absolute;left:-78px;top:-68px;width:960px;height:420px;background:repeating-linear-gradient(90deg,#1848a0 0 7px,#d9eaff 7px 14px);";
              overlay.append(paint);
              owner.append(overlay);
              return;
            }
            const clip = owner.querySelector(".clip"),
              fx = owner.querySelector(".fx"),
              f = owner.querySelector(".fill");
            const visual = document.createElement("div");
            visual.id = "visual";
            visual.style.cssText = "position:absolute;inset:0;";
            if (candidate === "child-material") {
              owner.append(visual);
              visual.append(clip);
              return;
            }
            fx.style.backdropFilter = "none";
            visual.style.backdropFilter = "blur(26px) saturate(125%)";
            if (candidate === "visual-clip") {
              visual.style.borderRadius = radius + "px";
              visual.style.overflow = "hidden";
              owner.append(visual);
              visual.append(clip);
            } else if (candidate === "filter-clip-split") {
              owner.append(visual);
              visual.append(clip);
            } else {
              clip.append(visual);
              visual.append(f, fx);
              visual.style.borderRadius = radius + "px";
              if (candidate === "svg-fill") {
                f.style.display = "none";
                const svg = document.createElementNS(
                  "http://www.w3.org/2000/svg",
                  "svg",
                );
                svg.style.cssText = "position:absolute;width:0;height:0;";
                const mask =
                  "data:image/svg+xml," +
                  encodeURIComponent(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="740" height="200"><rect width="740" height="200" rx="${radius}" fill="${fill || "transparent"}"/></svg>`,
                  );
                svg.innerHTML = `<defs><filter id="native-fill" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="-78" y="-78" width="896" height="356" color-interpolation-filters="sRGB"><feImage href="${mask}" x="0" y="0" width="740" height="200" result="fill"/><feComposite in="fill" in2="SourceGraphic" operator="over"/><feGaussianBlur stdDeviation="26"/><feColorMatrix type="saturate" values="1.25"/></filter></defs>`;
                owner.append(svg);
                visual.style.backdropFilter = "url(#native-fill)";
              }
            }
          },
          { original, candidate, radius, fill },
        );
        const full = await png(label + "-" + candidate + "-full");
        await page.locator("#visual").evaluate((n) => (n.style.opacity = ".5"));
        const faded = await png(label + "-" + candidate + "-fade");
        const row = {
          fill: !!fill,
          radius,
          candidate,
          static: metrics(full, reference, bg, 1),
          fade: metrics(faded, reference, bg, 0.5),
          ownFade: metrics(faded, full, bg, 0.5),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  await writeFile(
    path.join(out, "results.json"),
    JSON.stringify(rows, null, 2),
  );
} finally {
  await app.close();
}
