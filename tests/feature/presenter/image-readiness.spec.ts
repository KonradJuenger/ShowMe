import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

async function mount(
  page: Page,
  mode:
    "prepared" | "unsupported" | "failed" | "decode-failed" | "prepared-failed",
) {
  await page.goto("/");
  await readyEditor(page);
  await page.clock.install();
  await page.evaluate(async (mode) => {
    const path = "/tests/helpers/audienceReadinessHarness.tsx";
    const {
      mountAudienceReadinessHarness,
    }: typeof import("../../helpers/audienceReadinessHarness") = await import(
      /* @vite-ignore */ path
    );
    mountAudienceReadinessHarness(mode);
  }, mode);
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
}

test("Audience waits beyond eight seconds for exact preparation and both decodes", async ({
  page,
}) => {
  await mount(page, "prepared");
  await page.clock.fastForward(9000);
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Pending decodes")).toHaveText("1");
  await page.clock.fastForward(9000);
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
  await page.getByRole("button", { name: "Finish decode" }).click();
  await expect(page.locator("img")).toHaveAttribute(
    "data-source-width",
    "4096",
  );
  await expect(page.getByLabel("Pending decodes")).toHaveText("1");
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
  await page.getByRole("button", { name: "Finish decode" }).click();
  await expect(page.getByLabel("Audience readiness")).toHaveText("ready");
});

test("unsupported preparation waits for the full-quality original decode", async ({
  page,
}) => {
  await mount(page, "unsupported");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Pending decodes")).toHaveText("1");
  await page.clock.fastForward(9000);
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
  await expect(page.locator("img")).not.toHaveAttribute("data-source-width");
  await page.getByRole("button", { name: "Finish decode" }).click();
  await expect(page.getByLabel("Audience readiness")).toHaveText("ready");
});

test("a definitive load failure reaches the canonical missing-asset state without deadlock", async ({
  page,
}) => {
  await mount(page, "failed");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByRole("img", { name: "Missing asset" })).toBeVisible();
  await expect(page.getByLabel("Audience readiness")).toHaveText("ready");
});

test("a definitive original decode failure becomes missing before readiness", async ({
  page,
}) => {
  await mount(page, "decode-failed");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Pending decodes")).toHaveText("1");
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
  await page.getByRole("button", { name: "Finish decode" }).click();
  await expect(page.getByRole("img", { name: "Missing asset" })).toBeVisible();
  await expect(page.getByLabel("Audience readiness")).toHaveText("ready");
});

test("a failed prepared decode falls back to the original and waits for its decode", async ({
  page,
}) => {
  await mount(page, "prepared-failed");
  await page.getByRole("button", { name: "Finish preparation" }).click();
  await expect(page.getByLabel("Pending decodes")).toHaveText("1");
  await page.getByRole("button", { name: "Finish decode" }).click();
  await expect(page.getByLabel("Pending decodes")).toHaveText("1");
  await expect(page.getByLabel("Audience readiness")).toHaveText("waiting");
  await expect(page.locator("img")).not.toHaveAttribute("data-source-width");
  await page.getByRole("button", { name: "Finish decode" }).click();
  await expect(page.getByLabel("Audience readiness")).toHaveText("ready");
});
