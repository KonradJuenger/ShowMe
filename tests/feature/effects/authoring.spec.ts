import { expect, test, type Page } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";
import sharp from "sharp";

test("Text Scramble defaults to a two-second timeline interval, plays and restores the original", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Effects", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Add Effect", exact: true }).click();
  await page
    .getByRole("button", { name: "Text Scramble", exact: true })
    .click();
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  const output = page.locator("[data-editor-canvas] [data-effect-text-output]");
  const original = await page
    .locator("[data-editor-canvas] [data-text-content]")
    .textContent();
  await expect(output).toHaveText(original!);
  await expect(
    effects.getByLabel("Effect progress", { exact: true }),
  ).toHaveCount(0);
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("slide");
  await expect(effects.getByLabel("Effect stop", { exact: true })).toHaveValue(
    "after",
  );
  await expect(effects.getByLabel("Effect stop duration")).toHaveValue("2");
  await effects.getByLabel("Effect interval easing").selectOption("Ease Out");
  await expect(effects.getByLabel("Effect interval easing")).toHaveValue(
    "Ease Out",
  );
  await effects.getByLabel("Effect interval easing").selectOption("Linear");
  await expect(
    effects.getByRole("option", { name: "Fixed duration", exact: true }),
  ).toHaveCount(0);
  await expect(effects.getByLabel("Effect progress duration")).toHaveCount(0);
  await effects
    .getByRole("button", { name: "Click Timeline", exact: true })
    .click();
  const dock = page.getByRole("region", {
    name: "Click Timeline",
    exact: true,
  });
  const playhead = dock.getByRole("slider", {
    name: "Click Timeline playhead",
    exact: true,
  });
  await playhead.focus();
  await playhead.press("Home");
  await expect(output).not.toHaveText(original!);
  const scrambled = await output.textContent();
  await dock.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => output.textContent()).not.toBe(scrambled);
  await dock
    .getByRole("button", { name: "Pause playback", exact: true })
    .click();
  await playhead.press("End");
  await expect(output).toHaveText(original!);
  const endHandle = (await page
    .getByLabel("Resize end of Text Scramble", { exact: true })
    .boundingBox())!;
  await page.mouse.move(
    endHandle.x + endHandle.width / 2,
    endHandle.y + endHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    endHandle.x + endHandle.width / 2 - 50,
    endHandle.y + endHandle.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await effects.getByLabel("Effect stop duration").inputValue()),
    )
    .toBeLessThan(2);
  await expect(
    effects.getByLabel("Effect progress", { exact: true }),
  ).toHaveCount(0);
  await playhead.press("Home");
  await expect(output).not.toHaveText(original!);
  await playhead.press("End");
  await expect(output).toHaveText(original!);
  await effects.getByLabel("Effect stop", { exact: true }).selectOption("none");
  await expect(
    effects.getByLabel("Effect progress", { exact: true }),
  ).toHaveCount(0);
  await effects.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(output).toHaveCount(0);
  await expect(
    page.locator("[data-editor-canvas] [data-text-content]"),
  ).toHaveText(original!);
});

test("every built-in effect renders its finite phase or continuous clock without diagnostics", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const path = "/tests/helpers/builtinEffectsHarness.tsx";
    const {
      checkBuiltinEffects,
    }: typeof import("../../helpers/builtinEffectsHarness") = await import(
      /* @vite-ignore */ path
    );
    return checkBuiltinEffects();
  });
  expect(results.map((result) => result.name)).toEqual([
    "Dissolve",
    "Glass Distortion",
    "CSS Reveal",
    "Text Scramble",
    "Dithered Patterns",
  ]);
  for (const result of results) {
    expect(result.error, result.name).toBeUndefined();
    expect(result.changed, result.name).toBe(true);
    expect(result.restored, result.name).toBe(true);
  }
});

test("built-in definitions close unchanged and still warn after an edit", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Effects", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Add Effect", exact: true }).click();
  await page
    .getByRole("region", { name: "Applied Effects" })
    .getByRole("button", { name: "Text Scramble", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  const studio = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await expect(
    studio.getByText("Unsaved changes", { exact: true }),
  ).toHaveCount(0);
  await studio.getByRole("button", { name: "Close Effect Editor" }).click();
  await expect(studio).toHaveCount(0);
  await expect(
    page.getByRole("alertdialog", { name: "Unsaved Effect" }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  await studio
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("QA Scramble");
  await studio.getByRole("button", { name: "Close Effect Editor" }).click();
  const warning = page.getByRole("alertdialog", { name: "Unsaved Effect" });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Discard changes" }).click();
  await expect(studio).toHaveCount(0);
});

async function create(
  page: Page,
  type: "Shader" | "CSS + JS",
  image = false,
  template = false,
) {
  await page.goto("/");
  await readyEditor(page);
  if (template) {
    await page.getByRole("button", { name: /Templates/ }).click();
    await page
      .getByRole("button", { name: "Edit Template A", exact: true })
      .click();
  }
  if (image) {
    const buffer = await sharp({
      create: {
        width: 160,
        height: 100,
        channels: 4,
        background: { r: 220, g: 80, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    await page
      .getByTestId("import-files")
      .setInputFiles({ name: "Image 3.png", mimeType: "image/png", buffer });
    await expect(page.locator("[data-editor] img").first()).toBeVisible();
  } else await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Effects", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Add Effect", exact: true }).click();
  const picker = page.getByRole("region", { name: "Applied Effects" });
  const buttons = await picker.getByRole("button").allTextContents();
  expect(buttons.indexOf("+ New Effect")).toBeLessThan(
    buttons.indexOf("Glass Distortion"),
  );
  await page.getByRole("button", { name: "+ New Effect", exact: true }).click();
  const studio = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await expect(
    studio.getByText("Choose how this effect is built"),
  ).toBeVisible();
  await expect(studio.getByRole("textbox")).toHaveCount(0);
  await studio
    .getByLabel("Effect type", { exact: true })
    .selectOption(type === "Shader" ? "shader" : "css-js");
  return studio;
}

test("new Shader has pass-through code, preserves authored source and saves an independent snapshot", async ({
  page,
}, testInfo) => {
  const studio = await create(page, "Shader", true);
  await expect(studio.getByLabel("Effect code")).toHaveValue(
    /outColor = texture\(u_input, v_uv\);/,
  );
  await expect(studio.getByLabel("Effect example")).toHaveCount(0);
  await expect(studio.getByLabel("Effect code type")).toHaveCount(0);
  await expect(
    studio.getByRole("button", { name: "Preview code" }),
  ).toHaveCount(0);
  await expect(studio.locator('[data-effect-ready="true"]')).toBeVisible();
  const pixels = await studio
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement) =>
      Array.from(
        canvas
          .getContext("2d")!
          .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ),
    );
  expect(pixels).toEqual([220, 80, 30, 255]);
  await page.screenshot({ path: testInfo.outputPath("new-shader.png") });
  await studio.getByLabel("Effect affects").selectOption("generated");
  await expect(studio.getByLabel("Effect code")).toHaveValue(
    /vec4\(0.5, 0.5, 0.5, 1.0\)/,
  );
  const code = (await studio.getByLabel("Effect code").inputValue()).replace(
    "0.5, 0.5",
    "0.2, 0.8",
  );
  await studio.getByLabel("Effect code").fill(code);
  await studio
    .getByLabel("Effect type", { exact: true })
    .selectOption("css-js");
  await studio.getByLabel("Effect code").fill(":scope { opacity: 0.8; }");
  await studio
    .getByLabel("Effect type", { exact: true })
    .selectOption("shader");
  await expect(studio.getByLabel("Effect code")).toHaveValue(code);
  await studio
    .getByLabel("Effect type", { exact: true })
    .selectOption("css-js");
  await expect(studio.getByLabel("Effect code")).toHaveValue(
    ":scope { opacity: 0.8; }",
  );
  await studio
    .getByLabel("Effect type", { exact: true })
    .selectOption("shader");
  await studio.getByLabel("Effect affects").selectOption("backdrop");
  await expect(studio.getByLabel("Effect code")).toHaveValue(code);
  await studio.getByLabel("Effect affects").selectOption("generated");
  await expect(studio.locator('[data-effect-ready="true"]')).toBeVisible();
  await studio.getByLabel("Effect speed").fill("0.5");
  await page.keyboard.press("Control+s");
  await expect(studio).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit definition…", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  await expect(page.getByLabel("Effect code")).toHaveValue(code);
  await expect(page.getByLabel("Effect speed", { exact: true })).toHaveValue(
    "0.5",
  );
});

test("shader uniforms create Studio metadata controls and bounded instance sliders", async ({
  page,
}) => {
  const studio = await create(page, "Shader");
  const base = await studio.getByLabel("Effect code").inputValue();
  const source = base
    .replace(
      "in vec2 v_uv;",
      "uniform float distortionStrength; // @param 12 [0, 60]\nuniform float phase; // @param 0\nin vec2 v_uv;",
    )
    .replace(
      "texture(u_input, v_uv)",
      "texture(u_input, v_uv + vec2((distortionStrength + phase) * 0.0))",
    );
  await studio.getByLabel("Effect code").fill(source);
  await expect(studio.getByLabel("Parameter 1 name")).toHaveValue(
    "Distortion strength",
  );
  await expect(studio.getByLabel("Distortion strength default")).toHaveValue(
    "12",
  );
  await expect(studio.getByLabel("Distortion strength minimum")).toHaveValue(
    "0",
  );
  await expect(studio.getByLabel("Distortion strength maximum")).toHaveValue(
    "60",
  );
  await expect(studio.getByLabel("Parameter 2 name")).toHaveValue("Phase");
  await expect(
    studio.getByRole("button", { name: "+ Parameter", exact: true }),
  ).toHaveCount(0);

  await studio.getByLabel("Distortion strength default").fill("100");
  await expect(
    studio.getByText(
      "Parameter distortionStrength default must be at most 60",
      { exact: true },
    ),
  ).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(studio).toBeVisible();
  await studio.getByLabel("Parameter 1 name").fill("Distortion");
  await studio.getByLabel("Distortion default").fill("14");
  await expect(studio.getByLabel("Effect code")).toHaveValue(source);
  await page.keyboard.press("Control+s");
  await expect(studio).toHaveCount(0);

  await expect(page.getByLabel("New Effect Distortion slider")).toBeVisible();
  await expect(
    page.getByRole("spinbutton", {
      name: "New Effect Distortion",
      exact: true,
    }),
  ).toHaveValue("14");
  await expect(page.getByLabel("New Effect Phase slider")).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "New Effect Phase", exact: true }),
  ).toHaveValue("0");

  const slider = page.getByLabel("New Effect Distortion slider");
  const sliderBox = (await slider.boundingBox())!;
  const valueBox = (await page
    .getByRole("spinbutton", { name: "New Effect Distortion", exact: true })
    .boundingBox())!;
  expect(valueBox.x).toBeGreaterThanOrEqual(sliderBox.x + sliderBox.width);
  expect(
    Math.abs(
      valueBox.y + valueBox.height / 2 - sliderBox.y - sliderBox.height / 2,
    ),
  ).toBeLessThan(2);
  await page.evaluate(() => {
    document.documentElement.dataset.effectDragStarts = "0";
    document.addEventListener("dragstart", () => {
      document.documentElement.dataset.effectDragStarts = String(
        Number(document.documentElement.dataset.effectDragStarts) + 1,
      );
    });
  });
  await page.mouse.move(
    sliderBox.x + sliderBox.width * 0.25,
    sliderBox.y + sliderBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sliderBox.x + sliderBox.width * 0.75,
    sliderBox.y + sliderBox.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  expect(
    await page.evaluate(
      () => document.documentElement.dataset.effectDragStarts,
    ),
  ).toBe("0");
  await expect
    .poll(async () => Number(await slider.inputValue()))
    .toBeGreaterThan(14);

  const distortion = page.getByRole("spinbutton", {
    name: "New Effect Distortion",
    exact: true,
  });
  await distortion.fill("100");
  await distortion.press("Tab");
  await expect(distortion).toHaveValue("100");
  await expect(page.getByLabel("New Effect Distortion slider")).toHaveValue(
    "100",
  );
  await expect(slider).toHaveAttribute("max", "100");
  await distortion.fill("");
  await distortion.press("Tab");
  await expect(distortion).toHaveValue("100");
  await expect(slider).toHaveValue("100");
  await distortion.fill("12.5");
  await distortion.press("Escape");
  await expect(distortion).toHaveValue("100");
  await expect(slider).toHaveValue("100");
  await distortion.fill("12.5");
  await distortion.press("Enter");
  await expect(distortion).toHaveValue("12.5");
  await expect(slider).toHaveValue("12.5");
  await distortion.fill("25");
  await distortion.press("Tab");
  await page
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  const reopened = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  const withoutDistortion = source
    .replace("uniform float distortionStrength; // @param 12 [0, 60]\n", "")
    .replace("distortionStrength + phase", "phase");
  await reopened.getByLabel("Effect code").fill(withoutDistortion);
  await expect(reopened.getByLabel("Parameter 1 name")).toHaveValue("Phase");

  const dialogPromise = page.waitForEvent("dialog");
  const savePromise = page.keyboard.press("Control+s");
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("Saving removes 1 parameter override(s)");
  await dialog.accept();
  await savePromise;
  await expect(reopened).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", {
      name: "New Effect Distortion",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "New Effect Phase", exact: true }),
  ).toHaveValue("0");
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  await effects
    .getByRole("button", { name: "+ Add Effect", exact: true })
    .click();
  await page.getByRole("button", { name: "CSS Reveal", exact: true }).click();
  await effects
    .getByText("≡ New Effect", { exact: true })
    .dragTo(effects.getByText("≡ CSS Reveal", { exact: true }));
  await expect(effects.getByRole("group").nth(0)).toHaveAccessibleName(
    "≡ CSS Reveal",
  );
  await expect(effects.getByRole("group").nth(1)).toHaveAccessibleName(
    "≡ New Effect",
  );
});

test("Effect Timing exposes Start and Stop from creation and the sidebar leaves positioning to the timeline", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const studio = await create(page, "Shader");
  await expect(
    studio.getByText("t = Effect time · p = interval completion", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    studio.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("slide");
  await expect(
    studio.getByLabel("Effect time source", { exact: true }),
  ).toHaveCount(0);
  await expect(studio.getByLabel("Effect stop", { exact: true })).toHaveValue(
    "none",
  );
  await expect(
    studio.getByRole("option", { name: "Presentation end", exact: true }),
  ).toHaveCount(0);
  await expect(
    studio.getByLabel("Effect from click", { exact: true }),
  ).toHaveCount(0);
  await expect(
    studio.getByLabel("Effect start offset", { exact: true }),
  ).toHaveCount(0);
  await studio.getByLabel("Effect stop", { exact: true }).selectOption("after");
  await studio.getByLabel("Effect stop duration").fill("3");
  await studio
    .getByRole("button", { name: "Copy AI prompt", exact: true })
    .click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain("Start: Slide start. Stop: After 3 s.");
  expect(prompt).toContain(
    "Dragging its block in the Click Timeline changes the start click and delay",
  );
  await page.keyboard.press("Control+s");
  await expect(studio).toHaveCount(0);
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("slide");
  await expect(effects.getByLabel(/time source/i)).toHaveCount(0);
  await expect(effects.getByLabel("Effect stop duration")).toHaveValue("3");
  await expect(
    effects.getByRole("button", { name: "Open", exact: true }),
  ).toHaveCount(0);
  await expect(
    effects.getByRole("button", { name: "Click Timeline", exact: true }),
  ).toBeVisible();
  await expect(
    effects.getByLabel("Effect from click", { exact: true }),
  ).toHaveCount(0);
  await expect(
    effects.getByLabel("Effect start offset", { exact: true }),
  ).toHaveCount(0);
  await effects
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  const reopened = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await expect(reopened.getByLabel("Effect stop duration")).toHaveValue("3");
  await reopened
    .getByLabel("Effect stop", { exact: true })
    .selectOption("next-click");
  await reopened
    .getByRole("button", { name: "Copy AI prompt", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Start: Slide start. Stop: Next click.",
  );
  await reopened
    .getByRole("button", { name: "Close Effect Editor", exact: true })
    .click();
  await expect(reopened).toHaveCount(0);
  await expect(effects.getByLabel("Effect stop", { exact: true })).toHaveValue(
    "next-click",
  );
  await effects
    .getByRole("button", { name: "Click Timeline", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New Effect animation", exact: true }),
  ).toBeVisible();
  await effects
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  const rename = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await rename.getByLabel("Name", { exact: true }).fill("Renamed Effect");
  await page.keyboard.press("Control+s");
  await expect(rename).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New Effect animation", exact: true }),
  ).toHaveCount(0);
  const renamed = page.getByRole("button", {
    name: "Renamed Effect animation",
    exact: true,
  });
  await expect(renamed).toBeVisible();
  await renamed.click();
  await expect(
    page.getByRole("region", { name: "Click Timeline timing", exact: true }),
  ).toHaveCount(0);
});

test("preview derives progress from Start/Stop independently of Speed and retains valid code on errors", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const studio = await create(page, "Shader");
  const code = `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_t;
uniform float u_p;
in vec2 v_uv;
out vec4 outColor;
void main() { outColor = texture(u_input, v_uv + vec2(sin(u_t) * 0.01, 0.0)) * u_p; }`;
  await studio.getByLabel("Effect code").fill(code);
  await expect(studio.getByLabel("Effect preview time")).toBeVisible();
  await expect(studio.getByLabel("Effect preview progress")).toBeVisible();
  const time = async () =>
    Number(
      (await studio.getByLabel("Effect preview time").textContent())!.match(
        /[\d.]+/,
      )![0],
    );
  const before = await time();
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 1.00",
  );
  await expect.poll(time).toBeGreaterThan(before);
  const finished = await time();
  await expect.poll(time).toBeGreaterThan(finished + 0.2);
  await studio.getByRole("button", { name: "Copy AI prompt" }).click();
  await expect(studio.getByText("Effect prompt copied")).toBeVisible();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain("Do not derive p from time");
  expect(prompt.replaceAll("\r\n", "\n")).toContain(code);
  await studio.getByLabel("Effect time start").selectOption("click");
  await studio.getByLabel("Effect stop", { exact: true }).selectOption("after");
  await studio.getByLabel("Effect stop duration").fill("0.25");
  await studio.getByRole("button", { name: "Reset time", exact: true }).click();
  await expect.poll(time).toBe(0);
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 0.00",
  );
  await studio
    .getByRole("button", { name: "Preview click", exact: true })
    .click();
  await expect.poll(time).toBe(0.25);
  await studio.getByLabel("Effect speed", { exact: true }).fill("2");
  await expect.poll(time).toBe(0.5);
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 1.00",
  );
  await studio.getByLabel("Effect stop duration").fill("2");
  await expect(
    studio.getByLabel("Effect preview interval time"),
  ).toHaveAttribute("max", "2");
  await studio
    .getByLabel("Effect preview interval time")
    .evaluate((input: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await expect.poll(time).toBe(2);
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 0.50",
  );
  await studio.getByLabel("Effect stop", { exact: true }).selectOption("none");
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 1.00",
  );
  await expect(
    studio.getByRole("button", { name: "Play progress", exact: true }),
  ).toHaveCount(0);
  const canvas = studio.locator("canvas");
  await studio
    .getByLabel("Effect code")
    .fill(code.replace("sin(u_t)", "missingFunction(u_t)"));
  await expect(studio.getByRole("alert")).toContainText(/missingFunction/);
  const errorButton = studio.getByRole("alert").getByRole("button");
  const errorMessage = await errorButton.textContent();
  await errorButton.click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
    )
    .toBe(errorMessage);
  await expect(studio.getByRole("alert").getByRole("status")).toContainText(
    "Error copied to clipboard",
  );
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await errorButton.press("Enter");
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n/g,
        "\n",
      ),
    )
    .toBe(errorMessage);
  await expect(canvas).toBeVisible();
  await expect(studio.locator("[data-effect-error]")).toHaveCount(0);
  await studio.getByLabel("Effect code").fill(code);
  await expect(studio.getByRole("alert")).toHaveCount(0);
});

test("CSS + JS exposes optional isolated text code and preserves it through Affects changes", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const studio = await create(page, "CSS + JS");
  await expect(studio.getByLabel("Effect code")).toHaveValue(":scope {\n}");
  await expect(
    studio.getByRole("button", { name: "JS", exact: true }),
  ).toHaveCount(0);
  await studio
    .getByRole("button", { name: "+ Parameter", exact: true })
    .click();
  await studio.getByLabel("Parameter 1 name").fill("Strength");
  await studio.getByLabel("Parameter 1 name").press("Tab");
  await studio.getByLabel("Parameter 1 name").fill("Amount");
  await studio.getByLabel("Parameter 1 name").press("Tab");
  await studio.getByLabel("Effect affects").selectOption("text");
  await studio.getByRole("button", { name: "JS", exact: true }).click();
  await expect(studio.getByLabel("Effect code")).toHaveValue(
    /function render\(\{ text, t, p, parameters \}\)/,
  );
  const js =
    'function render({ text, t, p }) { return text + " " + t.toFixed(1) + ":" + p; }';
  await studio.getByLabel("Effect code").fill(js);
  await expect(studio.getByLabel("Effect preview time")).toBeVisible();
  await studio.getByRole("button", { name: "CSS", exact: true }).click();
  await studio.getByLabel("Effect style").fill(":scope { color: red; }");
  await studio.getByLabel("Effect affects").selectOption("element");
  await expect(
    studio.getByRole("button", { name: "JS", exact: true }),
  ).toHaveCount(0);
  await expect(studio.getByLabel("Effect code")).toHaveValue(
    ":scope { color: red; }",
  );
  await studio.getByLabel("Effect affects").selectOption("text");
  await studio.getByRole("button", { name: "JS", exact: true }).click();
  await expect(studio.getByLabel("Effect code")).toHaveValue(js);
  await studio.getByRole("button", { name: "Copy AI prompt" }).click();
  const prompt = (
    await page.evaluate(() => navigator.clipboard.readText())
  ).replaceAll("\r\n", "\n");
  expect(prompt).toContain("ShowMe is a presentation editor");
  expect(prompt).toContain("parameters.strength / CSS --strength // Amount");
  expect(prompt).toContain("isolated worker with bounded execution time");
  expect(prompt).toContain(js);
  expect(prompt).toContain(":scope { color: red; }");
  expect(prompt).toContain("MY REQUEST:");
});

test("all runtime surfaces deliver interval p, scaled t and independent reference clocks", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const result = await page.evaluate(async () => {
    const runtimePath = "/src/components/effectRuntime.ts",
      corePath = "/src/core/effects.ts",
      authoringPath = "/src/core/effectAuthoring.ts";
    const { mountEffectSurface, effectSurface } = (await import(
      /* @vite-ignore */ runtimePath
    )) as typeof import("../../../src/components/effectRuntime");
    const { newEffectInstance, effectTiming } = (await import(
      /* @vite-ignore */ corePath
    )) as typeof import("../../../src/core/effects");
    const { blankEffect, changeEffectAffects } = (await import(
      /* @vite-ignore */ authoringPath
    )) as typeof import("../../../src/core/effectAuthoring");
    const root = document.createElement("div");
    document.body.append(root);
    const css = {
      ...blankEffect("css-js"),
      speed: 2,
      source: ":scope { opacity: var(--p); }",
    };
    const timing = effectTiming(
      undefined,
      0,
      1000,
      "element",
      "instance",
      { slideTime: 1, presentationTime: 24, stepTime: 1 },
      { start: "slide", stop: { mode: "after", durationMs: 2000 } },
    );
    const unmountCss = mountEffectSurface(
      root,
      null,
      css,
      newEffectInstance("css", css, "content"),
      { width: 20, height: 20 },
    );
    effectSurface(root)!.setTiming(timing);
    await effectSurface(root)!.flush();
    const cssActiveOpacity = getComputedStyle(root).opacity;
    effectSurface(root)!.setTiming({ ...timing, active: false });
    await effectSurface(root)!.flush();
    const cssInactiveOpacity = getComputedStyle(root).opacity;
    effectSurface(root)!.setTiming(timing);
    await effectSurface(root)!.flush();
    const cssValues = [
      "--t",
      "--p",
      "--slideTime",
      "--presentationTime",
    ].map((key) => root.style.getPropertyValue(key));
    unmountCss();
    root.innerHTML = '<span data-text-content="true">Original</span>';
    const js = {
      ...changeEffectAffects(css, "text", false),
      source:
        "function render({ text, t, p, slideTime }) { return `${text}:${t}:${p}:${slideTime}`; }",
    };
    const unmountJs = mountEffectSurface(
      root,
      null,
      js,
      newEffectInstance("js", js, "content"),
      { width: 20, height: 20 },
    );
    effectSurface(root)!.setTiming(timing);
    await effectSurface(root)!.flush();
    const text = root.textContent;
    effectSurface(root)!.setTiming({ ...timing, active: false });
    await effectSurface(root)!.flush();
    const textOriginalOpacity = root.querySelector<HTMLElement>(
      "[data-text-content]",
    )!.style.opacity;
    const textOutputHidden = root.querySelector<HTMLElement>(
      "[data-effect-text-output]",
    )?.style.visibility;
    unmountJs();
    root.replaceChildren();
    const shader = {
      ...changeEffectAffects(blankEffect("shader"), "generated", true),
      speed: 2,
      source:
        "#version 300 es\nprecision highp float;\nuniform float u_t; uniform float u_p; out vec4 outColor; void main() { outColor = vec4(u_t / 4.0, u_p, u_t / 4.0, 1.0); }",
    };
    const canvas = document.createElement("canvas");
    root.append(canvas);
    const unmountShader = mountEffectSurface(
      root,
      canvas,
      shader,
      newEffectInstance("shader", shader, "background"),
      { width: 20, height: 20 },
    );
    effectSurface(root)!.setTiming(timing);
    await effectSurface(root)!.flush();
    const pixels = Array.from(
      canvas.getContext("2d")!.getImageData(10, 10, 1, 1).data,
    );
    effectSurface(root)!.setTiming({ ...timing, active: false });
    await effectSurface(root)!.flush();
    const shaderHidden = canvas.style.visibility;
    unmountShader();
    root.remove();
    return {
      cssValues,
      text,
      pixels,
      cssActiveOpacity,
      cssInactiveOpacity,
      textOriginalOpacity,
      textOutputHidden,
      shaderHidden,
    };
  });
  expect(result.cssActiveOpacity).toBe("0.5");
  expect(result.cssInactiveOpacity).toBe("0.5");
  expect(result.textOriginalOpacity).toBe("0");
  expect(result.textOutputHidden).toBe("visible");
  expect(result.shaderHidden).toBe("visible");
  expect(result.cssValues).toEqual(["2", "0.5", "1", "24"]);
  expect(result.text).toContain("Original:2:0.5:1");
  expect(result.pixels[0]).toBeCloseTo(128, -1);
  expect(result.pixels[1]).toBeCloseTo(128, -1);
  expect(result.pixels[2]).toBeCloseTo(128, -1);
});

test("Template A Presentation-start shader keeps u_t across slide remounts", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/helpers/effectTimingHarness.tsx";
    const {
      mountEffectTimingHarness,
    }: typeof import("../../helpers/effectTimingHarness") = await import(
      /* @vite-ignore */ path
    );
    (
      window as unknown as {
        navigateTiming: (index: number, now: number) => void;
      }
    ).navigateTiming = mountEffectTimingHarness();
  });
  const red = () =>
    page
      .locator("[data-effect-id] canvas")
      .first()
      .evaluate(
        (canvas: HTMLCanvasElement) =>
          canvas.getContext("2d")!.getImageData(50, 50, 1, 1).data[0],
      );
  await expect.poll(red).toBe(0);
  await page.evaluate(() =>
    (
      window as unknown as {
        navigateTiming: (index: number, now: number) => void;
      }
    ).navigateTiming(1, 9000),
  );
  await expect.poll(red).toBe(102);
  await page.evaluate(() =>
    (
      window as unknown as {
        navigateTiming: (index: number, now: number) => void;
      }
    ).navigateTiming(2, 16000),
  );
  await expect.poll(red).toBe(191);
});

test("Template A Start persists from Effect Editor and sidebar without template Motion", async ({
  page,
}) => {
  const studio = await create(page, "Shader", false, true);
  await studio.getByLabel("Effect affects").selectOption("generated");
  await page.keyboard.press("Control+s");
  await expect(studio).toHaveCount(0);
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("slide");
  await effects
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  const reopened = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await reopened
    .getByLabel("Effect time start", { exact: true })
    .selectOption("presentation");
  await page.keyboard.press("Control+s");
  await expect(reopened).toHaveCount(0);
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("presentation");
  await effects
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  await expect(
    reopened.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("presentation");
  await reopened
    .getByLabel("Effect time start", { exact: true })
    .selectOption("slide");
  await page.keyboard.press("Control+s");
  await expect(reopened).toHaveCount(0);
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("slide");
  await effects
    .getByLabel("Effect time start", { exact: true })
    .selectOption("presentation");
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("presentation");
  await effects
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  await expect(
    reopened.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("presentation");
  await reopened
    .getByRole("button", { name: "Close Effect Editor", exact: true })
    .click();
  await expect(reopened).toHaveCount(0);
  await expect(
    effects.getByLabel("Effect time start", { exact: true }),
  ).toHaveValue("presentation");
  await expect(
    page.getByText("Templates cannot own notes or Motion", { exact: true }),
  ).toHaveCount(0);
});

test("Click-linked Text Scramble bypasses, runs, completes and reconstructs backward in the timeline and Studio", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator(".sidebar-mode-rail")
    .getByRole("button", { name: "Effects", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Add Effect", exact: true }).click();
  await page
    .getByRole("button", { name: "Text Scramble", exact: true })
    .click();
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  await effects
    .getByRole("button", { name: "Click Timeline", exact: true })
    .click();
  const dock = page.getByRole("region", {
    name: "Click Timeline",
    exact: true,
  });
  await dock.getByRole("button", { name: "Add Click", exact: true }).click();
  await dock
    .getByRole("button", { name: "Text Scramble animation", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move to next click", exact: true })
    .click();
  await effects
    .getByLabel("Effect stop", { exact: true })
    .selectOption("next-click");
  await dock.getByRole("button", { name: "Add Click", exact: true }).click();
  const node = page.locator("[data-editor-canvas] [data-effect-id]");
  const output = node.locator("[data-effect-text-output]");
  const original = page.locator("[data-editor-canvas] [data-text-content]");
  const text = (await original.textContent())!;
  const slider = dock.getByRole("slider", { name: "Click Timeline playhead" });
  const seek = async (label: string) => {
    const column = (await dock
      .getByRole("button", { name: label, exact: true })
      .boundingBox())!;
    const handle = (await slider.boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(column.x + 1, handle.y + handle.height / 2);
    await page.mouse.up();
    await slider.focus();
    await slider.press("Home");
  };
  await seek("Slide start");
  await expect(node).toHaveAttribute("data-effect-started", "false");
  await expect(original).toBeVisible();
  await expect(output).toBeHidden();
  await seek("Click 1");
  await expect(node).toHaveAttribute("data-effect-started", "true");
  await expect(output).toBeVisible();
  await expect(output).not.toHaveText(text);
  const first = await output.textContent();
  await slider.press("End");
  await expect.poll(() => output.textContent()).not.toBe(first);
  await seek("Click 2");
  await expect(output).toHaveText(text);
  await seek("Click 1");
  await expect(output).not.toHaveText(text);
  await seek("Slide start");
  await expect(output).toBeHidden();
  await expect(original).toBeVisible();
  await effects
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  const studio = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await studio.getByRole("button", { name: "Reset time", exact: true }).click();
  const preview = studio.locator("[data-effect-id]");
  await expect(preview).toHaveAttribute("data-effect-started", "false");
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 0.00",
  );
  await studio
    .getByRole("button", { name: "Preview click", exact: true })
    .click();
  await expect(preview).toHaveAttribute("data-effect-started", "true");
  await expect(preview.locator("[data-effect-text-output]")).not.toHaveText(
    text,
  );
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 0.00",
  );
  await studio
    .getByRole("button", { name: "Preview click", exact: true })
    .click();
  await expect(studio.getByLabel("Effect preview progress")).toHaveText(
    "p = 1.00",
  );
  await expect(preview.locator("[data-effect-text-output]")).toHaveText(text);
});

test("Future Effect stages bypass independently for every target and preserve earlier shader output", async ({
  page,
}) => {
  await page.goto("/");
  await readyEditor(page);
  const results = await page.evaluate(async () => {
    const path = "/tests/helpers/effectBypassHarness.tsx";
    const {
      checkEffectBypass,
    }: typeof import("../../helpers/effectBypassHarness") = await import(
      /* @vite-ignore */ path
    );
    return checkEffectBypass();
  });
  for (const result of results) {
    for (const snapshot of [result.before, result.delayed, result.backward]) {
      expect(snapshot.error, result.kind).toBeUndefined();
      expect(snapshot.started, result.kind).toBe("false");
      expect(snapshot.opacity, result.kind).toBe("1");
      if (snapshot.pixel) expect(snapshot.pixel[3], result.kind).toBe(0);
      if (result.kind === "content" || result.kind === "stack")
        expect(snapshot.sourceOpacity, result.kind).toBe("");
      if (result.kind === "text") {
        expect(snapshot.originalOpacity).toBe("");
        expect(snapshot.outputVisibility).toBe("hidden");
      }
      if (result.kind === "stack")
        expect(snapshot.firstPixel).toEqual([0, 255, 0, 255]);
      if (result.kind === "text-stack") {
        expect(snapshot.firstText).toBe("A(Original)");
        expect(snapshot.firstTextOpacity).toBe("");
        expect(snapshot.outputVisibility).toBe("hidden");
      }
    }
    expect(result.waiting.error, result.kind).toBeUndefined();
    expect(result.waiting.started, result.kind).toBe("true");
    expect(result.waiting.t, result.kind).toBe(
      result.kind === "background" ? "2" : "1",
    );
    expect(result.waiting.p, result.kind).toBe("0");
    expect(result.final.started, result.kind).toBe("true");
    expect(result.final.t, result.kind).toBe(
      result.kind === "background" ? "5" : "2.5",
    );
    expect(result.final.p, result.kind).toBe("1");
    if (result.kind === "css") expect(result.waiting.opacity).toBe("0.25");
    if (result.kind === "text-stack") {
      expect(result.waiting.text).toBe("A(Original):1:0");
      expect(result.final.text).toBe("A(Original):2.5:1");
      expect(result.waiting.firstTextOpacity).toBe("0");
    }
    if (result.kind === "text") {
      expect(result.waiting.text).toBe("Original:1:0");
      expect(result.final.text).toBe("Original:2.5:1");
    }
    if (["content", "backdrop"].includes(result.kind))
      expect(result.waiting.pixel).toEqual([0, 255, 0, 255]);
    if (["background", "overlay", "stack"].includes(result.kind))
      expect(result.waiting.pixel).toEqual([0, 0, 255, 255]);
  }
});
