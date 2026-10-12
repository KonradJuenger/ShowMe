import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("presentation default Fade is authored in the slide inspector and audience navigation respects it", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Presentation menu" }).click();
  await page
    .getByRole("menuitem", { name: "New presentation", exact: true })
    .click();
  await page.getByLabel("New presentation name").fill("Transition defaults");
  await page
    .getByRole("button", { name: "Create presentation", exact: true })
    .click();
  // The old document's Present button remains visible while creation starts.
  // Wait for the new document's loaded editor before accessing its authority.
  await expect(
    page.getByLabel("Presentation filename", { exact: true }),
  ).toHaveText("Transition defaults");
  const id = await page.evaluate(async () => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const projection = await platform.documentProjection!(id);
    const lease = await platform.documentAcquireLeases!(id, [
      { kind: "slide-structure" },
    ]);
    if (lease.denied) throw new Error("Slide structure denied");
    const tokens = lease.grants.map((grant) => grant.token);
    try {
      await platform.documentCommit!(id, {
        transactionId: crypto.randomUUID(),
        documentId: id,
        epoch: projection.epoch,
        baseRevision: projection.revision,
        leaseTokens: tokens,
        operations: [
          {
            type: "slide.create",
            slide: {
              ...projection.slide,
              id: "incoming",
              background: "#ff0000",
            },
            meta: {
              name: "Incoming",
              section: "",
              hidden: false,
              templateId: null,
            },
            afterId: projection.slide.id,
          },
        ],
      });
    } finally {
      await platform.documentReleaseLeases!(id, tokens);
    }
    return id;
  });
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Slide", exact: true })
    .click();
  const incoming = page.getByLabel("Slide transition", { exact: true });
  await expect(incoming).toHaveValue("default");
  await page
    .getByLabel("Presentation default transition", { exact: true })
    .selectOption("fade");
  await page
    .getByLabel("Presentation transition duration", { exact: true })
    .fill("2");
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Slide", exact: true })
    .click();
  await expect(incoming.locator("option:checked")).toHaveText(
    "Presentation default · Fade",
  );
  await incoming.selectOption("none");
  await incoming.selectOption("default");
  const timing = page.getByLabel("Slide transition timing", { exact: true });
  await timing.selectOption("custom");
  await expect(
    page.getByLabel("Slide transition duration", { exact: true }),
  ).toHaveValue("2");
  await expect(incoming).toHaveValue("default");
  await timing.selectOption("default");
  await expect(
    page.getByLabel("Slide transition duration", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async (documentId) => {
        const path = "/src/platform/index.ts";
        const { platform }: typeof import("../../../src/platform") =
          await import(/* @vite-ignore */ path);
        return (await platform.documentProjection!(documentId)).deck
          .transitionDefaults;
      }, id),
    )
    .toEqual({ kind: "fade", durationMs: 2000, easing: "linear" });
  await page.keyboard.press("ControlOrMeta+s");
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
  await page.reload();
  await readyEditor(page);
  await page.getByRole("button", { name: "Presentation menu" }).click();
  await page
    .getByRole("menuitem", { name: "Transition defaults", exact: true })
    .click();
  await expect(
    page.getByLabel("Presentation default transition", { exact: true }),
  ).toHaveValue("fade");
  const popup = page.waitForEvent("popup");
  await page.evaluate(async (deckId) => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    await platform.present({ deckId, slideIds: [], index: 0 });
  }, id);
  const audience = await popup;
  await expect(audience.locator("[data-active-slide]")).toBeVisible();
  await audience.keyboard.press("ArrowRight");
  await expect(
    audience.locator("[data-active-slide] .slide-renderer"),
  ).toHaveAttribute("data-slide-id", "incoming");
  await expect
    .poll(() =>
      audience
        .locator("[data-active-slide]")
        .evaluate((node) => node.getAnimations().length),
    )
    .toBeGreaterThan(0);
  await audience.keyboard.press("ArrowLeft");
  await expect
    .poll(() =>
      audience
        .locator("[data-active-slide]")
        .evaluate((node) => node.getAnimations().length),
    )
    .toBe(0);
  await page.evaluate(async () => {
    const path = "/src/platform/index.ts";
    const { platform }: typeof import("../../../src/platform") = await import(
      /* @vite-ignore */ path
    );
    await platform.presentationCommand({ type: "jump", index: 1 });
  });
  await expect(
    audience.locator("[data-active-slide] .slide-renderer"),
  ).toHaveAttribute("data-slide-id", "incoming");
  await expect
    .poll(() =>
      audience
        .locator("[data-active-slide]")
        .evaluate((node) => node.getAnimations().length),
    )
    .toBe(0);
  await audience.close();
});
