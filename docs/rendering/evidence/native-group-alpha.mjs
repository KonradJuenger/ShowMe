import { chromium, _electron } from "@playwright/test";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
let browser, page, main;
try {
  if (process.argv[2] === "electron") {
    await mkdir(".agenttmp", { recursive: true });
    main = path.resolve(`.agenttmp/native-group-alpha-${process.pid}.cjs`);
    await writeFile(
      main,
      "const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('force-device-scale-factor','1');app.whenReady().then(()=>{const w=new BrowserWindow({width:640,height:360,useContentSize:true,show:false,webPreferences:{backgroundThrottling:false}});w.loadURL('about:blank');});",
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    browser = await _electron.launch({ args: [main], env });
    page = await browser.firstWindow();
  } else {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  }
  await page.setContent(
    '<style>body{margin:0}.lower{position:absolute;inset:0;background:repeating-linear-gradient(90deg,black 0 10px,white 10px 20px)}.transport{position:absolute;left:80px;top:70px;width:300px;height:200px;transform:translateY(-15px);opacity:1}.visual{position:absolute;inset:0;backdrop-filter:blur(12px)}.effect{position:absolute;inset:0;background:#fff2}.child{position:absolute;left:40px;top:40px;width:120px;height:80px;background:#f008}</style><div class="lower"></div><div class="transport"><div class="visual"><div class="effect"><div class="child"></div></div></div></div>',
  );
  const snap = async () =>
    sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
  const full = await snap();
  await page.locator(".visual").evaluate((n) => (n.style.opacity = ".5"));
  const faded = await snap();
  await page
    .locator(".transport")
    .evaluate((n) => (n.style.visibility = "hidden"));
  const back = await snap();
  let sum = 0,
    max = 0;
  for (let i = 0; i < full.length; i++) {
    const e = Math.abs(faded[i] - (full[i] + back[i]) * 0.5);
    sum += e;
    max = Math.max(max, e);
  }
  console.log(
    JSON.stringify({
      version: browser.version?.(),
      ua: await page.evaluate(() => navigator.userAgent),
      dpr: await page.evaluate(() => devicePixelRatio),
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      mae: sum / full.length,
      max,
    }),
  );
} finally {
  await browser?.close();
  if (main) await unlink(main);
}
