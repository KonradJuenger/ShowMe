import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

async function mode(page: Page, name: "Layers" | "Element" | "Slide") {
  await page
    .getByRole("navigation", { name: "Sidebar modes" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function harness(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/helpers/layersHarness.tsx";
    const { mountLayersHarness }: typeof import("../../helpers/layersHarness") =
      await import(/* @vite-ignore */ path);
    mountLayersHarness();
  });
}

test("Layers opens directly with one header action and retains current sidebar preferences", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "showme.right-sidebar.v1",
      JSON.stringify({ mode: "Element", width: 360 }),
    ),
  );
  await page.goto("/");
  await readyEditor(page);
  await mode(page, "Layers");
  await expect(page.getByRole("tree", { name: "Slide layers" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Layers", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  await expect(
    page.getByRole("tree", { name: "Slide layers" }).getByRole("treeitem"),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", {
      name: /^(Expand layers|Collapse layers|Pop out layers panel|Show inspector and layers)$/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("separator", { name: "Layers split" }),
  ).toHaveCount(0);
  const preference = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("showme.right-sidebar.v1")!),
  );
  expect(preference).toEqual({ mode: "Layers", width: 360 });
});

test("opening Layers reveals only selected ancestry and selection changes preserve existing disclosure", async ({
  page,
}) => {
  await harness(page);
  await mode(page, "Slide");
  await page
    .getByRole("button", { name: "Select nested element", exact: true })
    .click();
  await expect(
    page.getByRole("tree", { name: "Slide layers", includeHidden: true }),
  ).toHaveCount(0);
  await mode(page, "Layers");
  const tree = page.getByRole("tree", { name: "Slide layers" });
  await expect(
    tree.getByRole("button", { name: "Collapse Layer 1", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "Collapse Frame A", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "Collapse Frame B", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "Expand Other frame", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("treeitem", { name: "Selected element", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Select other element", exact: true })
    .click();
  await expect(
    tree.getByRole("button", { name: "Collapse Other frame", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("button", { name: "Collapse Frame B", exact: true }),
  ).toBeVisible();
  await tree.getByText("Frame B", { exact: true }).dblclick();
  await expect(tree.locator('[data-layer-element-id="inner"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(tree.locator('[data-layer-element-id="inner"]')).toHaveAttribute(
    "aria-selected",
    "false",
  );
  await expect(page.getByLabel("Current scope")).toHaveText("inner");
});

test("manual disclosure survives switching sidebar modes and Layer rows establish current scope", async ({
  page,
}) => {
  await harness(page);
  const layerScope = await page.getByLabel("Current scope").textContent();
  await mode(page, "Layers");
  const tree = page.getByRole("tree", { name: "Slide layers" });
  await tree
    .getByRole("button", { name: "Expand Layer 1", exact: true })
    .click();
  await tree
    .getByRole("button", { name: "Expand Other frame", exact: true })
    .click();
  await mode(page, "Element");
  await expect(
    page.getByRole("tree", { name: "Slide layers", includeHidden: true }),
  ).toHaveCount(0);
  await mode(page, "Layers");
  await expect(
    tree.getByRole("button", { name: "Collapse Other frame", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch slide", exact: true }).click();
  await expect(
    tree.getByRole("button", { name: "Expand Layer 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch slide", exact: true }).click();
  await expect(
    tree.getByRole("button", { name: "Collapse Other frame", exact: true }),
  ).toBeVisible();
  await tree.getByRole("treeitem", { name: "Rectangle", exact: true }).click();
  await tree.getByText("Layer 1", { exact: true }).click();
  await expect(page.getByLabel("Current scope")).toHaveText(layerScope!);
  await expect(tree.getByRole("treeitem").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    tree.getByRole("button", {
      name: "Make Layer 1 current layer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("objects in the current lower Layer remain selectable and movable beneath an empty upper Layer", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  const canvas = page.locator("[data-editor-canvas]");
  const lowerLayer = await canvas.getAttribute("data-editor-scope");
  const object = canvas.locator("[data-element-id]").first();
  const objectId = await object.getAttribute("data-element-id");
  await mode(page, "Layers");
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  await page
    .locator(`[data-layer-row-id="${lowerLayer}"]`)
    .getByRole("button", { name: /current layer/ })
    .click();
  await expect(canvas).toHaveAttribute("data-editor-scope", lowerLayer!);
  await expect(
    page
      .locator(`[data-layer-row-id="${lowerLayer}"]`)
      .getByRole("button", { name: /current layer/ }),
  ).toHaveAttribute("aria-pressed", "true");
  const bounds = (await object.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(canvas).toHaveAttribute("data-selection-count", "1");
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 20, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await canvas.locator(`[data-element-id="${objectId}"]`).boundingBox())!
          .x,
    )
    .toBeGreaterThan(bounds.x);
});

test("hidden and locked Layers remain inspectable but cannot become the current insertion scope", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const canvas = page.locator("[data-editor-canvas]");
  const firstLayer = await canvas.getAttribute("data-editor-scope");
  await mode(page, "Layers");
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const secondLayer = await canvas.getAttribute("data-editor-scope");
  const row = page.locator(`[data-layer-row-id="${secondLayer}"]`);
  const dot = row.getByRole("button", { name: /current layer/ });
  await row.getByRole("button", { name: /^Lock / }).click();
  await expect(canvas).toHaveAttribute("data-editor-scope", firstLayer!);
  await row.locator(".layer-name").click();
  await expect(dot).toBeDisabled();
  await expect(dot).toHaveAttribute("aria-pressed", "false");
  await expect(canvas).toHaveAttribute("data-editor-scope", firstLayer!);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(canvas).toHaveAttribute("data-editor-scope", firstLayer!);
  await row.getByRole("button", { name: /^Expand / }).click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await row.getByRole("button", { name: /^Unlock / }).click();
  await row.getByRole("button", { name: /^Hide / }).click();
  await row.locator(".layer-name").click();
  await expect(dot).toBeDisabled();
  await expect(canvas).toHaveAttribute("data-editor-scope", firstLayer!);
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await expect(
    canvas.locator(`[data-layer-id="${firstLayer}"] [data-element-id]`),
  ).toHaveCount(1);
  await expect(canvas.locator(`[data-layer-id="${secondLayer}"]`)).toHaveCount(
    0,
  );
  await row.getByRole("button", { name: /^Show / }).click();
  await dot.click();
  await expect(canvas).toHaveAttribute("data-editor-scope", secondLayer!);
});

test("objects on another unlocked layer remain selectable and movable without changing the insertion layer", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const canvas = page.locator("[data-editor-canvas]");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  const firstLayer = await canvas.getAttribute("data-editor-scope");
  await mode(page, "Layers");
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const secondLayer = await canvas.getAttribute("data-editor-scope");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  const object = canvas
    .locator(`[data-layer-id="${secondLayer}"] [data-element-id]`)
    .first();
  const objectId = await object.getAttribute("data-element-id");
  const current = page
    .locator(`[data-layer-row-id="${firstLayer}"]`)
    .getByRole("button", { name: /current layer/ });
  await current.click();
  await object.click();
  await expect(canvas).toHaveAttribute("data-selection-count", "1");
  await expect(canvas).toHaveAttribute("data-editor-scope", secondLayer!);
  await expect(current).toHaveAttribute("aria-pressed", "true");
  const bounds = (await object.boundingBox())!;
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 45, y + 20, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await object.boundingBox())!.x)
    .toBeGreaterThan(bounds.x);
  await expect(
    canvas.locator(
      `[data-layer-id="${secondLayer}"] [data-element-id="${objectId}"]`,
    ),
  ).toHaveCount(1);
  await expect(current).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await expect(
    canvas.locator(`[data-layer-id="${firstLayer}"] [data-element-id]`),
  ).toHaveCount(2);
  await expect(
    canvas.locator(`[data-layer-id="${secondLayer}"] [data-element-id]`),
  ).toHaveCount(1);

  // Layer changes happen explicitly: cut an upper-layer object, then paste into
  // the already-current lower layer without changing it by selecting the object.
  await object.click();
  await page.keyboard.press("Control+x");
  await expect(object).toHaveCount(0);
  await page.keyboard.press("Control+v");
  await expect(
    canvas.locator(`[data-layer-id="${firstLayer}"] [data-element-id]`),
  ).toHaveCount(3);
  await expect(
    canvas.locator(`[data-layer-id="${secondLayer}"] [data-element-id]`),
  ).toHaveCount(0);
  await expect(current).toHaveAttribute("aria-pressed", "true");
});

test("locked upper-layer objects do not intercept selection of an unlocked object underneath", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const canvas = page.locator("[data-editor-canvas]");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  const firstLayer = await canvas.getAttribute("data-editor-scope");
  const lower = canvas.locator("[data-element-id]").first();
  const lowerId = await lower.getAttribute("data-element-id");
  await mode(page, "Layers");
  await page.getByRole("button", { name: "Add layer", exact: true }).click();
  const secondLayer = await canvas.getAttribute("data-editor-scope");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page
    .locator(`[data-layer-row-id="${secondLayer}"]`)
    .getByRole("button", { name: /^Lock / })
    .click();
  const bounds = (await canvas
    .locator(`[data-element-id="${lowerId}"]`)
    .boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(canvas).toHaveAttribute("data-selection-count", "1");
  await expect(canvas).toHaveAttribute("data-editor-scope", firstLayer!);
  // Deletion proves the lower object, rather than the locked overlapping object,
  // is selected without depending on the selection overlay's DOM structure.
  await page.keyboard.press("Delete");
  await expect(
    canvas.locator(`[data-layer-id="${firstLayer}"] [data-element-id]`),
  ).toHaveCount(0);
  await expect(
    canvas.locator(`[data-layer-id="${secondLayer}"] [data-element-id]`),
  ).toHaveCount(1);
});
