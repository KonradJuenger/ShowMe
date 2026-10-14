import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "showme-visual-proof-"));
const output = path.resolve("artifacts/showme-editor.png");
await mkdir(path.dirname(output), { recursive: true });

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
  ),
);

let app;
try {
  app = await electron.launch({
    args: [
      path.resolve("."),
      `--user-data-dir=${path.join(root, "user")}`,
    ],
    env,
  });

  const page = await app.firstWindow();

  const setup = page.getByRole("main", { name: "First launch setup" });
  await page.locator("[data-editor]").or(setup).waitFor({ state: "visible", timeout: 30000 });
  if (await setup.isVisible()) {
    await setup.getByLabel("Library mode").selectOption("keep-all");
    await setup.getByRole("button", { name: "Start creating" }).click();
  }

  await page.getByRole("button", { name: "Present", exact: true }).waitFor({
    state: "visible",
    timeout: 30000,
  });

  await app.evaluate(({ BrowserWindow }) => {
    const editor = BrowserWindow.getAllWindows().find(
      (window) => !/[?&](present|slidePreview|export)=/.test(window.webContents.getURL()),
    );
    editor?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  });

  await page.waitForTimeout(750);
  await page.screenshot({ path: output });
  console.log(`Captured ${output}`);
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}
