import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";
import type { MotionEase } from "../../../src/core/motionModel";

async function start(page: Page) {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Frame", exact: true }).click();
}
async function tab(page: Page, name: "Motion" | "Effects") {
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name, exact: true })
    .click();
}
async function motion(page: Page, name: string) {
  await tab(page, "Motion");
  const back = page.getByRole("button", { name: "← Motion", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: "+ Add Motion", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function effect(page: Page, name: string) {
  await tab(page, "Effects");
  await page.getByRole("button", { name: "+ Add Effect", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("group", { name: `≡ ${name}`, exact: true })
    .getByLabel("Effect time start", { exact: true })
    .selectOption("click");
  if (!(await dock(page).isVisible())) await openClickTimeline(page);
  await dock(page)
    .getByRole("button", { name: `${name} animation`, exact: true })
    .click();
}
const dock = (page: Page) =>
  page.getByRole("region", { name: "Click Timeline", exact: true });
async function openClickTimeline(page: Page) {
  await page
    .getByRole("button", { name: "Click Timeline", exact: true })
    .last()
    .click();
}
async function clicks(page: Page) {
  for (let i = 0; i < 4; i++)
    await dock(page)
      .getByRole("button", { name: "Add Click", exact: true })
      .click();
  await dock(page)
    .getByRole("button", { name: "Click 4", exact: true })
    .click();
}
async function current(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/platform/browser.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ path);
    return browser.documentProjection!(
      document
        .querySelector("[data-editor]")!
        .getAttribute("data-document-id")!,
    );
  });
}
// Set an authored curve through the real document authority, rather than a UI draft.
async function authoredEasing(page: Page, eases: MotionEase[]) {
  await page.evaluate(async (eases) => {
    const path = "/src/platform/browser.ts",
      scopesPath = "/src/core/documentAuthority.ts";
    const { browser }: typeof import("../../../src/platform/browser") =
      await import(/* @vite-ignore */ path);
    const {
      scopesForOperations,
    }: typeof import("../../../src/core/documentAuthority") = await import(
      /* @vite-ignore */ scopesPath
    );
    const id = document
      .querySelector("[data-editor]")!
      .getAttribute("data-document-id")!;
    const projection = await browser.documentProjection!(id);
    const motion = structuredClone(projection.slide.motion!);
    const stage = motion.stages[0],
      block = stage.blocks![0];
    if (block.effectSchedule) block.effectSchedule.progressEasing = eases[0];
    for (const [index, member] of block.members.entries()) {
      const track = stage.tracks.find((t) => t.id === member.trackId)!;
      const from = track.keyframes.findIndex(
        (k) => k.id === member.fromKeyframeId,
      );
      const to = track.keyframes.findIndex((k) => k.id === member.toKeyframeId);
      for (let i = from; i < to; i++)
        track.keyframes[i].easeToNext = eases[index % eases.length];
    }
    const operations = [
      {
        type: "slide.motion.set" as const,
        slideId: projection.slide.id,
        motion,
      },
    ];
    const result = await browser.documentAcquireLeases!(
      id,
      scopesForOperations(projection, operations),
    );
    if (result.denied) throw new Error("Fixture lease denied");
    const tokens = result.grants.map((grant) => grant.token);
    try {
      await browser.documentCommit!(id, {
        transactionId: crypto.randomUUID(),
        documentId: id,
        epoch: projection.epoch,
        baseRevision: projection.revision,
        leaseTokens: tokens,
        operations,
      });
    } finally {
      await browser.documentReleaseLeases!(id, tokens);
    }
  }, eases);
}

test("Edit and View retain the playhead, scrubbing enters View, and Space advances one click without repeating or wrapping", async ({
  page,
}) => {
  await start(page);
  await motion(page, "Move");
  await openClickTimeline(page);
  const timeline = dock(page);
  const slider = timeline.getByRole("slider", {
    name: "Click Timeline playhead",
  });
  const edit = timeline.getByRole("button", { name: "Edit", exact: true });
  const view = timeline.getByRole("button", { name: "View", exact: true });
  const before = await current(page);
  const id = before.slide.nodes[0].children[0].id;
  const element = page.locator(`[data-editor-stage] [data-element-id="${id}"]`);
  const translateX = () =>
    element.evaluate(
      (node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
    );

  // Adding Motion plays it in View. Edit always returns to the authored state.
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await edit.click();
  await expect(edit).toHaveAttribute("aria-pressed", "true");
  await expect.poll(translateX).toBeCloseTo(0, 0);

  // Any playhead seek is an explicit request to inspect the animation.
  await slider.press("End");
  await slider.press("Shift+ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuenow", "900");
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await expect.poll(translateX).toBeCloseTo(120, 0);

  // Switching modes preserves the playhead while changing only canvas rendering.
  await edit.click();
  await expect(slider).toHaveAttribute("aria-valuenow", "900");
  await expect.poll(translateX).toBeCloseTo(0, 0);
  await view.click();
  await expect(slider).toHaveAttribute("aria-valuenow", "900");
  await expect.poll(translateX).toBeCloseTo(120, 0);

  await edit.click();
  await timeline
    .getByRole("button", { name: "Add Click", exact: true })
    .click();
  await timeline
    .getByRole("button", { name: "Add Click", exact: true })
    .click();

  // Space is the presentation Advance command and held-key repeat is ignored.
  await page.keyboard.down("Space");
  await expect(
    timeline.getByRole("button", { name: "Click 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.down("Space");
  await expect(
    timeline.getByRole("button", { name: "Click 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("Space");
  await page.keyboard.press("Space");
  await expect(
    timeline.getByRole("button", { name: "Click 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(
    timeline.getByRole("button", { name: "Click 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Play enters View, runs only the current interval, and never crosses a click gate", async ({
  page,
}) => {
  await start(page);
  await motion(page, "Move");
  await openClickTimeline(page);
  const timeline = dock(page);
  await timeline
    .getByRole("button", { name: "Add Click", exact: true })
    .click();
  const edit = timeline.getByRole("button", { name: "Edit", exact: true });
  const view = timeline.getByRole("button", { name: "View", exact: true });
  const slideStart = timeline.getByRole("button", {
    name: "Slide start",
    exact: true,
  });
  const clickOne = timeline.getByRole("button", {
    name: "Click 1",
    exact: true,
  });
  const before = await current(page);
  const id = before.slide.nodes[0].children[0].id;
  const element = page.locator(`[data-editor-stage] [data-element-id="${id}"]`);
  const translateX = () =>
    element.evaluate(
      (node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).m41,
    );

  await edit.click();
  await expect.poll(translateX).toBeCloseTo(0, 0);
  await timeline.getByRole("button", { name: "Play", exact: true }).click();
  await expect(view).toHaveAttribute("aria-pressed", "true");
  await expect(slideStart).toHaveAttribute("aria-pressed", "true");
  await expect(clickOne).toHaveAttribute("aria-pressed", "false");
  await expect.poll(translateX).toBeCloseTo(120, 0);
  await expect(
    timeline.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();

  // Replaying at the end restarts the same interval instead of advancing.
  await timeline.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Pause playback", exact: true }),
  ).toBeVisible();
  await expect(slideStart).toHaveAttribute("aria-pressed", "true");
  await expect(clickOne).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      timeline
        .getByRole("button", { name: "Play", exact: true })
        .isVisible(),
    )
    .toBe(true);
  await expect(slideStart).toHaveAttribute("aria-pressed", "true");
  expect((await current(page)).slide.motion).toEqual(before.slide.motion);
});

test("ordinary Motion keeps Click Timeline closed and uses Slide start, while open additions use the selected Click", async ({
  page,
}) => {
  await start(page);
  await motion(page, "Move");
  await expect(dock(page)).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Motion panel", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Motion trigger", { exact: true })).toHaveValue(
    "0",
  );
  await expect(
    page.getByLabel("Animation easing", { exact: true }),
  ).toHaveValue("Custom");
  await openClickTimeline(page);
  await clicks(page);
  await dock(page)
    .getByRole("button", { name: "Close Click Timeline", exact: true })
    .click();
  await motion(page, "Move");
  await expect(dock(page)).not.toBeVisible();
  await expect(page.getByLabel("Motion trigger", { exact: true })).toHaveValue(
    "0",
  );
  await openClickTimeline(page);
  await dock(page)
    .getByRole("button", { name: "Click 4", exact: true })
    .click();
  await motion(page, "Fade");
  await expect(dock(page)).toBeVisible();
  await expect(page.getByLabel("Motion trigger", { exact: true })).toHaveValue(
    "4",
  );
});

test("Effect selection keeps authored timing and opens no editing bar", async ({
  page,
}) => {
  await start(page);
  await effect(page, "CSS Reveal");
  await expect(dock(page)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Click Timeline timing", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Applied Effects", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Effect from click", { exact: true }),
  ).toHaveCount(0);
  await authoredEasing(page, [[0.2, 0.3, 0.6, 0.9]]);
  const before = await current(page);
  await dock(page)
    .getByRole("button", { name: "CSS Reveal animation", exact: true })
    .click();
  expect((await current(page)).slide.motion).toEqual(before.slide.motion);
  await expect(
    page.getByRole("region", { name: "Applied Effects", exact: true }),
  ).toBeVisible();
  await clicks(page);
  await effect(page, "Glass Distortion");
  await expect(
    page.getByLabel("Effect from click", { exact: true }),
  ).toHaveCount(0);
  const projection = await current(page);
  expect(
    projection.slide.motion!.stages[4].blocks!.some(
      (b) => b.label === "Glass Distortion",
    ),
  ).toBe(true);
});

test("Motion inspectors reflect authored, changed and mixed easing without changing it on selection", async ({
  page,
}) => {
  await start(page);
  await motion(page, "Move");
  const easing = page.getByLabel("Animation easing", { exact: true });
  await expect(easing).toHaveValue("Custom");
  for (const name of ["Ease In", "Ease Out", "Ease In Out", "Linear", "Hold"]) {
    await easing.selectOption(name);
    await expect(easing).toHaveValue(name);
  }
  await authoredEasing(page, ["linear", "hold"]);
  await expect(easing).toHaveValue("Custom");
  await openClickTimeline(page);
  const before = await current(page);
  await dock(page)
    .getByRole("button", { name: "Move animation", exact: true })
    .click();
  await expect(easing).toHaveValue("Custom");
  expect((await current(page)).slide.motion).toEqual(before.slide.motion);
  await authoredEasing(page, [[0.2, 0.3, 0.6, 0.9]]);
  await expect(easing).toHaveValue("Custom");
  await easing.selectOption("Ease In Out");
  await expect(easing).toHaveValue("Ease In Out");
});

test("Click Timeline block menu exposes choreography actions and effect navigation", async ({
  page,
}) => {
  await start(page);
  await motion(page, "Move");
  await openClickTimeline(page);
  const move = dock(page).getByRole("button", {
    name: "Move animation",
    exact: true,
  });
  await move.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Play animation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Duplicate", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Select Element", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Open in Motion", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", {
      name: "Remove from Click Timeline",
      exact: true,
    }),
  ).toBeVisible();
  const trigger = page.getByRole("menuitem", { name: /Trigger/ });
  await trigger.hover();
  await expect(
    page.getByRole("menuitem", { name: "New click", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "New click", exact: true }).click();
  await expect(
    dock(page).getByRole("button", { name: /Click 1/ }),
  ).toBeVisible();

  await effect(page, "CSS Reveal");
  const effectBlock = dock(page).getByRole("button", {
    name: "CSS Reveal animation",
    exact: true,
  });
  await expect(effectBlock.getByText("fx", { exact: true })).toBeVisible();
  await effectBlock.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Open Effect", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Duplicate", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Open Effect", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Applied Effects", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("fieldset[data-effect-instance]:focus legend"),
  ).toHaveText("≡ CSS Reveal");

  await effectBlock.click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: "Remove from Click Timeline",
      exact: true,
    })
    .click();
  await expect(effectBlock).toHaveCount(0);
  await expect(
    page.getByLabel("Effect time start", { exact: true }),
  ).toBeVisible();
});

test("Slide start repositions a moved and delayed Effect at the beginning of the timeline", async ({
  page,
}) => {
  await start(page);
  await effect(page, "CSS Reveal");
  const block = dock(page).getByRole("button", {
    name: "CSS Reveal animation",
    exact: true,
  });
  await block.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move to next click", exact: true })
    .click();
  const handle = (await page
    .getByLabel("Resize start of CSS Reveal", { exact: true })
    .boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 40,
    handle.y + handle.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await current(page)).slide.motion!.stages[1].blocks![0].effectSchedule!
          .startOffsetMs,
    )
    .toBeGreaterThan(0);
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  const timedStop = (await current(page)).slide.motion!.stages[1].blocks![0]
    .effectSchedule!.stop;
  await effects
    .getByLabel("Effect time start", { exact: true })
    .selectOption("slide");
  await expect
    .poll(async () => {
      const motion = (await current(page)).slide.motion!;
      const target = motion.stages[0].blocks?.find(
        (candidate) => candidate.label === "CSS Reveal",
      );
      return target?.effectSchedule;
    })
    .toMatchObject({
      start: "slide",
      startOffsetMs: 0,
      stop: timedStop,
    });
  expect((await current(page)).slide.motion!.stages[1].blocks).toEqual([]);
});

test("Effect resize handles edit clock length and render timed, continuous and click-anchored ends", async ({
  page,
}, testInfo) => {
  await start(page);
  await effect(page, "CSS Reveal");
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  const block = dock(page)
    .getByRole("button", { name: "CSS Reveal animation", exact: true })
    .locator("..");
  await effects.getByLabel("Effect stop", { exact: true }).selectOption("none");
  await expect(block).toHaveAttribute("data-end-style", "continuous");
  await dock(page).screenshot({
    path: testInfo.outputPath("effect-continuous.png"),
  });
  await expect(
    page.getByLabel("Resize start of CSS Reveal", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Resize end of CSS Reveal", { exact: true }),
  ).toBeVisible();
  await effects
    .getByLabel("Effect stop", { exact: true })
    .selectOption("after");
  await effects.getByLabel("Effect stop duration").fill("2");
  await expect(block).toHaveAttribute("data-end-style", "timed");
  const drag = async (label: string, x: number) => {
    const box = (await page.getByLabel(label, { exact: true }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  const handle = (await page
    .getByLabel("Resize end of CSS Reveal", { exact: true })
    .boundingBox())!;
  await drag("Resize end of CSS Reveal", handle.x + handle.width / 2 + 70);
  await expect
    .poll(async () =>
      Number(await effects.getByLabel("Effect stop duration").inputValue()),
    )
    .toBeGreaterThan(2);
  expect(
    (await current(page)).slide.motion!.stages[0].blocks![0].effectSchedule!
      .stop.mode,
  ).toBe("after");
  await dock(page).screenshot({
    path: testInfo.outputPath("effect-timed.png"),
  });
  const startHandle = (await page
    .getByLabel("Resize start of CSS Reveal", { exact: true })
    .boundingBox())!;
  await drag(
    "Resize start of CSS Reveal",
    startHandle.x + startHandle.width / 2 + 35,
  );
  await expect
    .poll(
      async () =>
        (await current(page)).slide.motion!.stages[0].blocks![0].effectSchedule!
          .startOffsetMs,
    )
    .toBeGreaterThan(0);
  for (let i = 0; i < 2; i++)
    await dock(page)
      .getByRole("button", { name: "Add Click", exact: true })
      .click();
  await effects
    .getByLabel("Effect stop", { exact: true })
    .selectOption("next-click");
  await expect(block).toHaveAttribute("data-end-style", "click");
  const gate = (await dock(page)
    .getByRole("button", { name: "Click 2", exact: true })
    .boundingBox())!;
  await drag("Resize end of CSS Reveal", gate.x + 1);
  const projection = await current(page);
  expect(
    projection.slide.motion!.stages[0].blocks![0].effectSchedule!.stop,
  ).toEqual({ mode: "click", stageId: projection.slide.motion!.stages[2].id });
  await expect(block).toHaveAttribute("data-end-style", "click");
  await expect(
    dock(page).getByText(/clock running interval|Stop click|time →/),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("effect-click-anchor.png"),
  });
});

test("Free playhead scrubbing uses displayed local spans across empty clicks in both directions", async ({
  page,
}) => {
  await start(page);
  await motion(page, "Move");
  await openClickTimeline(page);
  const slider = dock(page).getByRole("slider", {
    name: "Click Timeline playhead",
  });
  await expect(slider).toHaveAttribute("aria-valuemax", "1000");
  await slider.focus();
  await slider.press("End");
  await slider.press("Shift+ArrowLeft");
  await slider.press("Shift+ArrowLeft");
  await slider.press("Shift+ArrowLeft");
  await slider.press("Shift+ArrowRight");
  for (let i = 0; i < 5; i++) await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuenow", "750");
  const id = (await current(page)).slide.nodes[0].children[0].id;
  const node = page.locator(`[data-editor-stage] [data-element-id="${id}"]`);
  await expect
    .poll(() =>
      node.evaluate((n) => Number(getComputedStyle(n).transform.split(",")[4])),
    )
    .toBeCloseTo(120, 0);
  await dock(page)
    .getByRole("button", { name: "Add Click", exact: true })
    .click();
  // Scrub using the authored gate headers, each of which spans its local ruler.
  const headers = dock(page).getByRole("button", {
    name: /^(Slide start|Click 1)( ·.*)?$/,
  });
  const first = (await headers.nth(0).boundingBox())!,
    second = (await headers.nth(1).boundingBox())!;
  const handle = (await slider.boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    second.x + second.width * 0.75,
    handle.y + handle.height / 2,
    { steps: 6 },
  );
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
    .toBeGreaterThan(700);
  await page.mouse.move(
    first.x + first.width * 0.75,
    handle.y + handle.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
    .toBeGreaterThan(700);
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
    .toBeLessThan(800);
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuenow", "1000");
  await expect(headers.nth(0)).toHaveText("Slide start");
  await expect(headers.nth(1)).toHaveText("Click 1");
  const lane = (await dock(page)
    .locator(".motion-stage-cell")
    .nth(1)
    .boundingBox())!;
  await page.mouse.move(lane.x + lane.width * 0.25, lane.y + lane.height - 2);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width * 0.75, lane.y + lane.height - 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
    .toBeGreaterThan(700);
  await expect
    .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
    .toBeLessThan(800);
});

test("Presence inspector authors lifecycle and preview gates rendering without changing editor visibility", async ({
  page,
}, testInfo) => {
  await start(page);
  await motion(page, "Presence");
  await expect(page.getByLabel("Presence Enter trigger")).toHaveValue("0");
  await expect(page.getByLabel("Exit transition")).toHaveCount(0);
  await page
    .getByLabel("Enter transition", { exact: true })
    .selectOption("rotate");
  await page.getByLabel("Enter easing").selectOption("Linear");
  await openClickTimeline(page);
  await dock(page)
    .getByRole("button", { name: "Add Click", exact: true })
    .click();
  await page.getByLabel("Presence Enter trigger").selectOption("1");
  const slider = dock(page).getByRole("slider", {
    name: "Click Timeline playhead",
  });
  const id = (await current(page)).slide.nodes[0].children[0].id;
  const node = page.locator(`[data-editor-stage] [data-element-id="${id}"]`);
  const startColumn = (await dock(page)
    .getByRole("button", { name: "Slide start", exact: true })
    .boundingBox())!;
  const initialHandle = (await slider.boundingBox())!;
  await page.mouse.move(
    initialHandle.x + initialHandle.width / 2,
    initialHandle.y + initialHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    startColumn.x + 1,
    initialHandle.y + initialHandle.height / 2,
  );
  await page.mouse.up();
  await slider.focus();
  await slider.press("Home");
  await expect(node).toHaveCSS("visibility", "hidden");
  const clickOne = (await dock(page)
    .getByRole("button", { name: /^Click 1(?: ·.*)?$/ })
    .boundingBox())!;
  const handle = (await slider.boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(clickOne.x + 1, handle.y + handle.height / 2);
  await page.mouse.up();
  await slider.focus();
  await slider.press("Home");
  await expect(node).toHaveCSS("visibility", "visible");
  await expect
    .poll(() => node.evaluate((n) => getComputedStyle(n).opacity))
    .toBe("0");
  await slider.press("End");
  await expect(node).toHaveCSS("opacity", "1");
  await dock(page)
    .getByRole("button", { name: "Presence animation", exact: true })
    .click();
  const presenceBlock = dock(page).getByRole("button", {
    name: "Presence animation",
    exact: true,
  });
  await presenceBlock.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Duplicate", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByLabel("Presence End trigger").selectOption("slide-end");
  await expect(page.getByLabel("Exit transition", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Presence End trigger").selectOption("next-click");
  await page
    .getByLabel("Exit transition", { exact: true })
    .selectOption("move");
  await dock(page)
    .getByRole("button", { name: "Add Click", exact: true })
    .click();
  await dock(page).screenshot({
    path: testInfo.outputPath("presence-click-exit.png"),
  });
  const clickTwo = (await dock(page)
    .getByRole("button", { name: "Click 2", exact: true })
    .boundingBox())!;
  const nextHandle = (await slider.boundingBox())!;
  await page.mouse.move(
    nextHandle.x + nextHandle.width / 2,
    nextHandle.y + nextHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(clickTwo.x + 1, nextHandle.y + nextHandle.height / 2);
  await page.mouse.up();
  await slider.focus();
  await slider.press("Home");
  await expect(node).toHaveCSS("visibility", "visible");
  await slider.press("End");
  await expect(node).toHaveCSS("visibility", "hidden");
  await dock(page)
    .getByRole("button", { name: "Close Click Timeline", exact: true })
    .click();
  await expect(node).toHaveCSS("visibility", "visible");
  expect(
    (await current(page)).slide.nodes[0].children[0].appearance.opacity,
  ).toBe(1);
});

test("Presence event tails sample through presentation waits, retain mounted media and gate raster paint", async ({
  page,
}) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const runtimePath = "/src/components/motionRuntime.ts",
      presencePath = "/src/core/presence.ts",
      factoryPath = "/src/core/elementFactory.ts",
      documentPath = "/src/core/document.ts",
      rasterPath = "/src/components/elementRaster.ts";
    const {
      createMotionRuntime,
    }: typeof import("../../../src/components/motionRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const {
      addPresence,
      defaultPresenceTransition,
    }: typeof import("../../../src/core/presence") = await import(
      /* @vite-ignore */ presencePath
    );
    const {
      createBasicShape,
    }: typeof import("../../../src/core/elementFactory") = await import(
      /* @vite-ignore */ factoryPath
    );
    const {
      newPresentationDocument,
    }: typeof import("../../../src/core/document") = await import(
      /* @vite-ignore */ documentPath
    );
    const {
      renderElementToSurface,
    }: typeof import("../../../src/components/elementRaster") = await import(
      /* @vite-ignore */ rasterPath
    );
    const doc = newPresentationDocument("Presence"),
      slide = doc.slides[doc.deck.slideIds[0]],
      element = createBasicShape("probe", "rectangle");
    element.appearance.fill = "#ff0000";
    slide.nodes[0].children = [element];
    slide.motion = addPresence(undefined, 0, [element.id]);
    slide.motion.stages.push({ id: "next", tracks: [] });
    const s = slide.motion.stages[0].blocks![0].presenceSchedule!;
    s.end = { mode: "next-click" };
    s.exitTransition = defaultPresenceTransition("move");
    const root = document.createElement("div"),
      node = document.createElement("div"),
      video = document.createElement("video");
    node.dataset.elementId = element.id;
    node.append(video);
    root.append(node);
    document.body.append(root);
    video.currentTime = 7;
    const runtime = createMotionRuntime(root, slide, 1, () => ({
      slideTime: 5,
      presentationTime: 18.4,
      stepTime: 0,
      stageStarts: [0, 5],
    }));
    runtime.sync({
      stageId: "next",
      stageIndex: 1,
      time: 0,
      startedAt: Date.now(),
      running: false,
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    const context = { root, resources: {}, beforeEffect: "", flush() {} };
    renderElementToSurface(element, canvas, context);
    const duringAlpha = canvas.getContext("2d")!.getImageData(50, 50, 1, 1)
      .data[3];
    runtime.samplePresence(500);
    renderElementToSurface(element, canvas, context);
    const absentAlpha = canvas.getContext("2d")!.getImageData(50, 50, 1, 1)
      .data[3];
    const absent = node.dataset.presentationAbsent,
      inert = node.inert,
      sameMedia = node.querySelector("video") === video,
      mediaTime = video.currentTime;
    runtime.cancel();
    const restored =
      !node.inert &&
      node.style.contentVisibility === "" &&
      node.style.visibility === "";
    root.remove();
    return {
      duringAlpha,
      absentAlpha,
      absent,
      inert,
      sameMedia,
      mediaTime,
      restored,
    };
  });
  expect(result).toEqual({
    duringAlpha: 255,
    absentAlpha: 0,
    absent: "true",
    inert: true,
    sameMedia: true,
    mediaTime: 7,
    restored: true,
  });
});

test("Effect surface parameter, clock and flush paths defer visual work while the owner is absent", async ({
  page,
}) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const runtimePath = "/src/components/effectRuntime.ts",
      authoringPath = "/src/core/effectAuthoring.ts";
    const {
      mountEffectSurface,
      effectSurface,
      flushEffectSurfaces,
    }: typeof import("../../../src/components/effectRuntime") = await import(
      /* @vite-ignore */ runtimePath
    );
    const { blankEffect }: typeof import("../../../src/core/effectAuthoring") =
      await import(/* @vite-ignore */ authoringPath);
    const owner = document.createElement("div"),
      node = document.createElement("div");
    node.dataset.effectId = "probe";
    owner.append(node);
    document.body.append(owner);
    const definition = {
      ...blankEffect("css-js"),
      parameters: [
        { type: "number" as const, key: "amount", label: "Amount", default: 1 },
      ],
      source: ":scope { opacity: var(--amount); }",
    };
    const dispose = mountEffectSurface(
      node,
      null,
      definition,
      {
        id: "probe",
        resourceId: "fx",
        enabled: true,
        placement: "content",
        parameters: {},
      },
      { width: 100, height: 100 },
    );
    const surface = effectSurface(node)!;
    // Surfaces wait for their first logical clock sample; Presence remains a
    // separate gate after this Effect has started.
    surface.setTiming({ time: 0, duration: 0, started: true });
    await surface.flush();
    const before = node.style.getPropertyValue("--amount");
    owner.dataset.presentationAbsent = "true";
    surface.set("amount", 0.25);
    surface.setTiming({ time: 12, duration: 0 });
    node.dataset.effectReady = "false";
    const ready = await flushEffectSurfaces(owner);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const hidden = node.style.getPropertyValue("--amount");
    delete owner.dataset.presentationAbsent;
    await surface.flush();
    const visible = node.style.getPropertyValue("--amount"),
      time = node.style.getPropertyValue("--t");
    dispose();
    owner.remove();
    return { before, hidden, visible, time, ready };
  });
  expect(result).toEqual({
    before: "1",
    hidden: "1",
    visible: "0.25",
    time: "12",
    ready: true,
  });
});
