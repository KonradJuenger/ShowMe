import { expect, test, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readyEditor } from "../../helpers/startup";

test("desktop IPC prepares the selected audience resolution and rejects screen reassignment during presentation", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-screens-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    args: [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    const primaryId = await app.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().id,
    );
    const displays = await page.evaluate(() => window.desktop!.displays());
    expect(displays.find((display) => display.presenter)?.id).toBe(primaryId);
    expect(displays.find((display) => display.audience)?.id).toBe(
      displays.find((display) => !display.primary)?.id ?? primaryId,
    );
    await page
      .getByRole("button", { name: "Presentation screen setup" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Presentation screens" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    // Configure the audience on the real primary screen to verify the native
    // preparation profile independently of any other attached monitor.
    const presenterId =
      displays.find((display) => !display.primary)?.id ?? primaryId;
    const profile = await page.evaluate(
      async ({ primaryId, presenterId }) => {
        const desktop = window.desktop!;
        await desktop.setPresentationDisplays({
          presenterDisplayId: presenterId,
          audienceDisplayId: primaryId,
        });
        const id = document
          .querySelector("[data-editor]")!
          .getAttribute("data-document-id")!;
        const status = await desktop.imageReadiness!(id);
        return status?.profile;
      },
      { primaryId, presenterId },
    );
    const primary = displays.find((display) => display.id === primaryId)!;
    expect(profile).toEqual({
      width: Math.ceil(primary.bounds.width * primary.scaleFactor),
      height: Math.ceil(primary.bounds.height * primary.scaleFactor),
    });
    await page.getByRole("button", { name: "Present", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Present", exact: true }),
    ).toBeEnabled();
    const audience = app
      .windows()
      .find((window) => window.url().includes("present=audience"));
    expect(audience).toBeDefined();
    await expect(audience!.locator("[data-active-slide]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Presentation screen setup" }),
    ).toBeDisabled();
    const state = await page.evaluate(() => window.desktop!.getPresentation());
    expect(state).toMatchObject({
      presenterDisplayId: presenterId,
      audienceDisplayId: primaryId,
    });
    const error = await page.evaluate(async () => {
      try {
        await window.desktop!.setPresentationDisplays(null);
        return null;
      } catch (error) {
        return String(error);
      }
    });
    expect(error).toContain("End the presentation");
    expect(
      await page.evaluate(() => window.desktop!.getPresentation()),
    ).toMatchObject({
      presenterDisplayId: presenterId,
      audienceDisplayId: primaryId,
    });
    await page.evaluate(() => window.desktop!.closePresentation());
    await expect(
      page.getByRole("button", { name: "Presentation screen setup" }),
    ).toBeEnabled();
    await page.evaluate(() => window.desktop!.setPresentationDisplays(null));
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true });
  }
});
