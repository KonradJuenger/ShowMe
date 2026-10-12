import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readyEditor } from "../../helpers/startup";

async function openEffects(page: Page) {
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Effects", exact: true })
    .click();
}

test("My Effects manages reusable definitions without an Element and round-trips named text exports", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await openEffects(page);
  await page.getByRole("button", { name: "My Effects", exact: true }).click();
  const manager = page.getByRole("region", {
    name: "Library Effects",
    exact: true,
  });
  await manager
    .getByRole("button", { name: "+ New Effect", exact: true })
    .click();
  await page.getByLabel("Effect type", { exact: true }).selectOption("css-js");
  const editor = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await editor.getByLabel("Name", { exact: true }).fill("Fresh Glow");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  let entry = manager.getByRole("article", { name: "Fresh Glow", exact: true });
  await expect(entry).toBeVisible();
  await expect(
    entry.getByRole("button", { name: "Apply", exact: true }),
  ).toBeDisabled();
  await entry
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  await editor
    .getByLabel("Effect code", { exact: true })
    .fill(":scope { opacity: 0.8; }");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(manager.getByRole("article")).toHaveCount(1);
  await entry.getByRole("button", { name: "Duplicate", exact: true }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(manager.getByRole("article")).toHaveCount(2);
  await manager.getByLabel("Search My Effects").fill("copy");
  await expect(manager.getByRole("article")).toHaveCount(1);
  await manager
    .getByRole("article", { name: "Fresh Glow copy" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(manager.getByRole("article")).toHaveCount(0);
  await manager.getByLabel("Search My Effects").fill("");
  await manager.getByText("Folders and import", { exact: true }).click();
  await manager.getByLabel("New folder", { exact: true }).fill("Favorites");
  await manager
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(
    manager
      .getByLabel("Library Effects folder")
      .getByRole("option", { name: "Favorites" }),
  ).toHaveCount(1);
  await entry.getByText("Rename, move and export", { exact: true }).click();
  await entry
    .getByLabel("Rename Fresh Glow", { exact: true })
    .fill("Bright Glow");
  await entry.getByLabel("Rename Fresh Glow", { exact: true }).press("Enter");
  entry = manager.getByRole("article", { name: "Bright Glow", exact: true });
  await expect(entry).toBeVisible();
  await entry
    .getByLabel("Move Bright Glow", { exact: true })
    .selectOption("Favorites");
  await expect(
    entry.getByLabel("Move Bright Glow", { exact: true }),
  ).toHaveValue("Favorites");
  const downloadPromise = page.waitForEvent("download");
  await entry.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^Bright Glow-[a-f0-9]{8}\.txt$/,
  );
  const text = await readFile((await download.path())!, "utf8");
  const exported = JSON.parse(text);
  expect(exported).toMatchObject({
    version: 1,
    revision: 3,
    definition: { name: "Bright Glow", source: ":scope { opacity: 0.8; }" },
  });
  await entry.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await manager.getByLabel("Library Effects folder").selectOption("Favorites");
  await manager.getByLabel("Import Effect", { exact: true }).setInputFiles({
    name: download.suggestedFilename(),
    mimeType: "text/plain",
    buffer: Buffer.from(text),
  });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(entry).toBeVisible();
  await entry.getByText("Rename, move and export", { exact: true }).click();
  await expect(
    entry.getByLabel("Move Bright Glow", { exact: true }),
  ).toHaveValue("Favorites");
  await page.reload();
  await readyEditor(page);
  await page.getByRole("button", { name: "My Effects", exact: true }).click();
  await expect(entry).toBeVisible();
});

test("deleting a Library effect refreshes Add Effect while retaining applied snapshots", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await openEffects(page);
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  await effects
    .getByRole("button", { name: "+ Add Effect", exact: true })
    .click();
  await effects
    .getByRole("button", { name: "+ New Effect", exact: true })
    .click();
  await page.getByLabel("Effect type", { exact: true }).selectOption("css-js");
  const editor = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await editor.getByLabel("Name", { exact: true }).fill("Keep Applied");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    effects.getByRole("group", { name: "≡ Keep Applied", exact: true }),
  ).toBeVisible();
  const instanceId = await effects
    .getByRole("group", { name: "≡ Keep Applied", exact: true })
    .getAttribute("data-effect-instance");
  await effects
    .getByRole("button", { name: "My Effects", exact: true })
    .click();
  await page.evaluate((instanceId) => {
    document.dispatchEvent(
      new CustomEvent("showme-effect-focus", {
        detail: { instanceId },
      }),
    );
  }, instanceId);
  await expect(
    effects.getByRole("group", { name: "≡ Keep Applied", exact: true }),
  ).toBeFocused();
  await effects
    .getByRole("button", { name: "My Effects", exact: true })
    .click();
  await effects
    .getByRole("article", { name: "Keep Applied", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(effects.getByRole("article")).toHaveCount(0);
  await effects.getByRole("button", { name: "Applied", exact: true }).click();
  await expect(
    effects.getByRole("group", { name: "≡ Keep Applied", exact: true }),
  ).toBeVisible();
  await effects
    .getByRole("button", { name: "+ Add Effect", exact: true })
    .click();
  await expect(
    effects.getByRole("button", { name: "Keep Applied", exact: true }),
  ).toHaveCount(0);
  await effects.getByRole("button", { name: "← Effects", exact: true }).click();
  await effects.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    effects.getByRole("group", { name: "≡ Keep Applied", exact: true }),
  ).toHaveCount(0);
});
