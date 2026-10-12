import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

async function projection(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    return platform.documentProjection!(
      document
        .querySelector("[data-editor]")!
        .getAttribute("data-document-id")!,
    );
  });
}

test("slide format recognizes imported dimensions and commits custom ratio drafts atomically", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const before = await platform.documentProjection!(id);
    const lease = await platform.documentAcquireLeases!(id, [{ kind: "deck" }]);
    if (lease.denied) throw new Error("Deck lease denied");
    const tokens = lease.grants.map((grant) => grant.token);
    try {
      await platform.documentCommit!(id, {
        transactionId: crypto.randomUUID(),
        documentId: id,
        epoch: before.epoch,
        baseRevision: before.revision,
        leaseTokens: tokens,
        operations: [
          {
            type: "deck.properties.set",
            changes: { width: 1280, height: 720 },
          },
        ],
      });
    } finally {
      await platform.documentReleaseLeases!(id, tokens);
    }
  });
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Slide", exact: true })
    .click();
  const format = page.getByLabel("Presentation slide format", { exact: true });
  await expect(format).toHaveValue("16:9");
  const before = await projection(page);
  await format.selectOption("16:9");
  expect((await projection(page)).revision).toBe(before.revision);
  await format.selectOption("Custom");
  const width = page.getByLabel("Presentation width ratio", { exact: true });
  const height = page.getByLabel("Presentation height ratio", { exact: true });
  await width.fill("3");
  await height.fill("4");
  expect((await projection(page)).revision).toBe(before.revision);
  await height.press("Enter");
  await expect.poll(async () => (await projection(page)).deck.width).toBe(720);
  const after = await projection(page);
  expect(after.deck.height).toBe(960);
  expect(after.revision).toBe(before.revision + 1);
  expect(after.slide).toEqual(before.slide);
  await width.fill("1");
  await width.press("Escape");
  await format.focus();
  expect((await projection(page)).revision).toBe(after.revision);
  await page.getByText("Advanced canvas size", { exact: true }).click();
  await expect(
    page.getByLabel("Presentation width", { exact: true }),
  ).toHaveValue("720");
  await expect(
    page.getByLabel("Presentation height", { exact: true }),
  ).toHaveValue("960");
});
