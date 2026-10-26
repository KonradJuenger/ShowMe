import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("notes default collapsed for a note-free deck but remain open when another slide has notes", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  const setNotes = (position: number, notes: string) =>
    page.evaluate(
      async ({ position, notes }) => {
        const { platform }: typeof import("../../../src/platform") =
          await import("/src/platform/index.ts" as string);
        const id = document
          .querySelector("[data-editor]")!
          .getAttribute("data-document-id")!;
        const projection = await platform.documentProjection!(id);
        const slideId = projection.deck.slideIds[position];
        const leases = await platform.documentAcquireLeases!(id, [
          { kind: "notes", slideId },
        ]);
        if (leases.denied) throw new Error("Notes lease denied");
        await platform.documentCommit!(id, {
          documentId: id,
          transactionId: crypto.randomUUID(),
          epoch: projection.epoch,
          baseRevision: projection.revision,
          leaseTokens: leases.grants.map((grant) => grant.token),
          operations: [{ type: "slide.notes.set", slideId, notes }],
        });
        await platform.documentReleaseLeases!(
          id,
          leases.grants.map((grant) => grant.token),
        );
      },
      { position, notes },
    );
  const present = async () => {
    const popup = page.waitForEvent("popup", {
      predicate: (p) => p.url().includes("present=console"),
    });
    await page.getByRole("button", { name: "Present", exact: true }).click();
    return popup;
  };
  await setNotes(0, "   \n\t");
  const empty = await present();
  await expect(empty.getByRole("button", { name: "Show notes" })).toBeVisible();
  await expect(
    empty.getByRole("region", { name: "Presenter notes" }),
  ).toBeHidden();
  await empty.getByRole("button", { name: "Show notes" }).click();
  await expect(
    empty.getByRole("region", { name: "Presenter notes" }),
  ).toBeVisible();
  await empty.getByLabel("Jump to slide").selectOption("0");
  await expect(
    empty.getByRole("region", { name: "Presenter notes" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { platform } = await import("/src/platform/index.ts" as string);
    await platform.closePresentation();
  });
  await setNotes(1, "Notes only on the other slide.");
  const withNotes = await present();
  await withNotes.getByLabel("Jump to slide").selectOption("0");
  await expect(
    withNotes.getByRole("region", { name: "Presenter notes" }),
  ).toBeVisible();
  await expect(withNotes.locator(".presenter-notes")).not.toContainText(
    "Notes only on the other slide.",
  );
  await withNotes.getByRole("button", { name: "Hide notes" }).click();
  await withNotes.getByLabel("Jump to slide").selectOption("1");
  await expect(
    withNotes.getByRole("region", { name: "Presenter notes" }),
  ).toBeHidden();
});

test("clicking slide previews advances one Motion step and keyboard activation does not double advance", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await page.evaluate(async () => {
    const { platform }: typeof import("../../../src/platform") = await import(
      "/src/platform/index.ts" as string
    );
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const projection = await platform.documentProjection!(id);
    const slideId = projection.deck.slideIds[0];
    const leases = await platform.documentAcquireLeases!(id, [
      { kind: "slide", slideId },
    ]);
    if (leases.denied) throw new Error("Slide lease denied");
    await platform.documentCommit!(id, {
      documentId: id,
      transactionId: crypto.randomUUID(),
      epoch: projection.epoch,
      baseRevision: projection.revision,
      leaseTokens: leases.grants.map((grant) => grant.token),
      operations: [
        {
          type: "slide.motion.set",
          slideId,
          motion: {
            stages: ["entrance", "first-click", "second-click"].map((id) => ({
              id,
              tracks: [],
            })),
          },
        },
      ],
    });
    await platform.documentReleaseLeases!(
      id,
      leases.grants.map((grant) => grant.token),
    );
  });
  const popup = page.waitForEvent("popup", {
    predicate: (p) => p.url().includes("present=console"),
  });
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = await popup;
  await presenter.getByLabel("Jump to slide").selectOption("0");
  const motionStage = () =>
    presenter.evaluate(async () => {
      const { platform }: typeof import("../../../src/platform") = await import(
        "/src/platform/index.ts" as string
      );
      return (await platform.getPresentation())?.motion?.stageIndex;
    });
  await expect.poll(motionStage).toBe(0);
  await presenter
    .getByRole("button", {
      name: "Advance, current slide preview",
      exact: true,
    })
    .click();
  await expect.poll(motionStage).toBe(1);
  await expect(presenter.getByLabel("Jump to slide")).toHaveValue("0");
  await presenter
    .getByRole("button", { name: "Advance, next slide preview", exact: true })
    .click();
  await expect.poll(motionStage).toBe(2);
  await expect(presenter.getByLabel("Jump to slide")).toHaveValue("0");
  await presenter
    .getByRole("button", { name: "Previous", exact: true })
    .click();
  await expect.poll(motionStage).toBe(1);
  const current = presenter.getByRole("button", {
    name: "Advance, current slide preview",
    exact: true,
  });
  await current.focus();
  await presenter.keyboard.press("Enter");
  await expect.poll(motionStage).toBe(2);
  await expect(presenter.getByLabel("Jump to slide")).toHaveValue("0");
  await presenter.keyboard.press("Space");
  await expect(presenter.getByLabel("Jump to slide")).toHaveValue("1");
  await expect(current).toBeDisabled();
  await expect(
    presenter.getByRole("button", {
      name: "Advance, next slide preview",
      exact: true,
    }),
  ).toBeDisabled();
});

test("speaker notes use their panel and resize, collapse and restore without navigating slides", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await page.evaluate(async () => {
    const { platform }: typeof import("../../../src/platform") = await import(
      "/src/platform/index.ts" as string
    );
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const projection = await platform.documentProjection!(id);
    const slideId = projection.deck.slideIds[0];
    const leases = await platform.documentAcquireLeases!(id, [
      { kind: "notes", slideId },
    ]);
    if (leases.denied) throw new Error("Notes lease denied");
    await platform.documentCommit!(id, {
      documentId: id,
      transactionId: crypto.randomUUID(),
      epoch: projection.epoch,
      baseRevision: projection.revision,
      leaseTokens: leases.grants.map((grant) => grant.token),
      operations: [
        {
          type: "slide.notes.set",
          slideId,
          notes: "A line of speaker notes.\n".repeat(40),
        },
      ],
    });
    await platform.documentReleaseLeases!(
      id,
      leases.grants.map((grant) => grant.token),
    );
  });
  const popup = page.waitForEvent("popup", {
    predicate: (p) => p.url().includes("present=console"),
  });
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const presenter = await popup;
  await presenter.setViewportSize({ width: 1280, height: 900 });
  await presenter.getByLabel("Jump to slide").selectOption("0");
  const notes = presenter.getByRole("region", { name: "Presenter notes" });
  await expect(notes).toBeVisible();
  const text = notes.locator(".presenter-notes");
  await expect(text).toContainText("A line of speaker notes.");
  expect(
    await text.evaluate(
      (node) =>
        node.clientHeight / parseFloat(getComputedStyle(node).lineHeight),
    ),
  ).toBeGreaterThanOrEqual(3);
  const separator = presenter.getByRole("separator", {
    name: "Resize speaker notes",
  });
  const originalHeight = (await notes.boundingBox())!.height;
  const handle = (await separator.boundingBox())!;
  await presenter.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await presenter.mouse.down();
  await presenter.mouse.move(handle.x + handle.width / 2, handle.y - 100, {
    steps: 5,
  });
  await presenter.mouse.up();
  expect((await notes.boundingBox())!.height).toBeGreaterThan(originalHeight);
  const expandedHeight = (await notes.boundingBox())!.height;
  await presenter.getByRole("button", { name: "Hide notes" }).click();
  await expect(notes).toBeHidden();
  await presenter.getByRole("button", { name: "Show notes" }).click();
  await expect(notes).toBeVisible();
  expect((await notes.boundingBox())!.height).toBeCloseTo(expandedHeight, 0);
  await separator.focus();
  const value = Number(await separator.getAttribute("aria-valuenow"));
  await presenter.keyboard.press("ArrowUp");
  expect(Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(
    value,
  );
  await text.focus();
  await presenter.keyboard.press("PageDown");
  await expect(presenter.getByLabel("Jump to slide")).toHaveValue("0");
  await separator.focus();
  await presenter.keyboard.press("Enter");
  await expect(notes).toBeHidden();
  await presenter.keyboard.press("Enter");
  await expect(notes).toBeVisible();
  await expect(presenter.getByLabel("Jump to slide")).toHaveValue("0");
});

test("ending browser presentation restores the editor preparation profile", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const before = await page.evaluate(async () => {
    const { platform } = await import("/src/platform/index.ts" as string);
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    return { id, profile: (await platform.imageReadiness(id, true))!.profile };
  });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const audience = await popupPromise;
  await audience.setViewportSize({ width: 1111, height: 777 });
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const { platform } = await import("/src/platform/index.ts" as string);
        return (await platform.imageReadiness(id))?.profile;
      }, before.id),
    )
    .toEqual({ width: 1111, height: 777 });
  await page.evaluate(async () => {
    const { platform } = await import("/src/platform/index.ts" as string);
    await platform.closePresentation();
  });
  const after = await page.evaluate(async (id) => {
    const { platform } = await import("/src/platform/index.ts" as string);
    return (await platform.imageReadiness(id, true))!.profile;
  }, before.id);
  expect(after).toEqual(before.profile);
});

test("screen popup supports dragging, keyboard assignments, reset and locks when Present starts", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const path = "/tests/helpers/presentationDisplaysHarness.tsx";
    const {
      mountPresentationDisplaysHarness,
    }: typeof import("../../helpers/presentationDisplaysHarness") =
      await import(/* @vite-ignore */ path);
    mountPresentationDisplaysHarness();
  });
  const setup = page.getByRole("button", { name: "Presentation screen setup" });
  await setup.click();
  const dialog = page.getByRole("dialog", { name: "Presentation screens" });
  const laptop = dialog.getByLabel("Screen 1: Laptop", { exact: true });
  const projector = dialog.getByLabel("Screen 2: Projector", { exact: true });
  const monitor = dialog.getByLabel("Screen 3: Monitor", { exact: true });
  await expect(laptop.getByText("Presenter", { exact: true })).toBeVisible();
  await expect(projector.getByText("Audience", { exact: true })).toBeVisible();
  await projector.getByText("Audience", { exact: true }).dragTo(laptop);
  await expect(dialog.getByLabel("Audience view")).toHaveValue("7");
  await expect(dialog.getByLabel("Presenter view")).toHaveValue("8");
  await laptop.getByText("Audience", { exact: true }).dragTo(monitor);
  await expect(dialog.getByLabel("Audience view")).toHaveValue("9");
  await expect(dialog.getByLabel("Presenter view")).toHaveValue("8");
  await dialog.getByLabel("Presenter view").selectOption("9");
  await expect(dialog.getByLabel("Audience view")).toHaveValue("8");
  await dialog
    .getByRole("button", { name: "Reset to default screens" })
    .click();
  await expect(dialog.getByLabel("Presenter view")).toHaveValue("7");
  await expect(dialog.getByLabel("Audience view")).toHaveValue("8");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(setup).toBeFocused();
  await setup.click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(setup).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(setup).toBeEnabled();
});

test("presenter resizing reuses rasters while audience resolution upgrades exactly", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.evaluate(async () => {
    const path = "/tests/helpers/presenterImagesHarness.tsx";
    const {
      mountPresenterImagesHarness,
    }: typeof import("../../helpers/presenterImagesHarness") = await import(
      /* @vite-ignore */ path
    );
    mountPresenterImagesHarness();
  });
  const presenter = page
    .getByRole("region", { name: "Presenter raster" })
    .locator("img");
  const audience = page
    .getByRole("region", { name: "Audience raster" })
    .locator("img");
  await expect
    .poll(() =>
      presenter.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(600);
  await expect
    .poll(() =>
      audience.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(600);
  await expect(page.getByLabel("Image requests")).toHaveText("2");
  const source = await presenter.getAttribute("src");
  await page.getByRole("button", { name: "Resize presenter preview" }).click();
  await expect(page.getByLabel("Preview scale")).toHaveText("0.5");
  await expect(page.getByLabel("Image requests")).toHaveText("2");
  await expect(presenter).toHaveAttribute("src", source!);
  await page.getByRole("button", { name: "Choose 4K audience screen" }).click();
  // This fixture's 600-unit frame doubles at 3840/1920 audience scale.
  // The expected 1200 pixels are a derived sample size, not a product limit.
  await expect
    .poll(() =>
      audience.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1200);
  // Audience sampling is exact. The presenter may retain a softer raster or
  // reuse a larger one, provided it still displays decoded source content.
  await expect
    .poll(() =>
      presenter.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(presenter).toBeVisible();
  await expect(presenter).toHaveAttribute("data-source-width", "4096");
});
