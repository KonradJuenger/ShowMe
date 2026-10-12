import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readyEditor } from "../helpers/startup";

test("packaged desktop launches its production renderer and native preload", async () => {
  const release = path.resolve("release");
  const files = await readdir(release);
  expect(
    files.some((file) =>
      process.platform === "win32"
        ? file.endsWith(".exe")
        : file.endsWith(".dmg"),
    ),
  ).toBe(true);
  const executablePath =
    process.platform === "win32"
      ? path.join(release, "win-unpacked", "ShowMe.exe")
      : path.join(
          release,
          process.arch === "arm64" ? "mac-arm64" : "mac",
          "ShowMe.app",
          "Contents",
          "MacOS",
          "ShowMe",
        );
  const root = await mkdtemp(path.join(os.tmpdir(), "showme-package-launch-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        !["SHOWME_DOCUMENT_DIR", "ELECTRON_RUN_AS_NODE"].includes(key) &&
        value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${root}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    expect(
      await page.evaluate(() => typeof window.desktop?.documentProjection),
    ).toBe("function");
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
