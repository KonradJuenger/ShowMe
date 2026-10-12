import { expect, test } from "@playwright/test";
import { readyEditor } from "../../helpers/startup";

test("production multi-state scramble reconstructs forward and backward clicks and preview", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/tests/helpers/typedContextHarness.tsx";
    const module: typeof import("../../helpers/typedContextHarness") =
      await import(/* @vite-ignore */ path);
    (
      window as unknown as {
        contextSample: Awaited<
          ReturnType<typeof module.mountTypedContextHarness>
        >;
      }
    ).contextSample = await module.mountTypedContextHarness("scramble");
  });
  const sample = (step: number, seconds: number, preview = false) =>
    page.evaluate(
      async ({ step, seconds, preview }) => {
        const fn = (
          window as unknown as {
            contextSample: (
              step: number,
              seconds: number,
              preview: boolean,
            ) => Promise<{
              text: string | null;
              error: string | null;
              stepIndex: string;
              stepTime: string;
            }>;
          }
        ).contextSample;
        return fn(step, seconds, preview);
      },
      { step, seconds, preview },
    );
  expect(await sample(0, 4)).toMatchObject({
    text: "Alpha",
    stepIndex: "0",
    error: null,
  });
  const first = await sample(1, 0.1);
  expect(first.text).not.toBe("Beta");
  expect(first).toMatchObject({ stepIndex: "1", stepTime: "0.1", error: null });
  expect(await sample(1, 0.5)).toMatchObject({ text: "Beta", error: null });
  const second = await sample(2, 0.1);
  expect(second.text).not.toBe("Gamma");
  expect(second.error).toBeNull();
  expect(await sample(2, 0.5)).toMatchObject({ text: "Gamma", error: null });
  expect(await sample(3, 0.1)).toMatchObject({ text: "Gamma", error: null });
  expect(await sample(1, 0.5, true)).toMatchObject({
    text: "Beta",
    error: null,
  });
  expect(await sample(1, 0.1, true)).toEqual(first);
  expect(await sample(0, 0, true)).toMatchObject({
    text: "Alpha",
    error: null,
  });
});
test("typed JS and CSS delivery retains native values and safely serializes strings", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const path = "/tests/helpers/typedContextHarness.tsx";
    const module: typeof import("../../helpers/typedContextHarness") =
      await import(/* @vite-ignore */ path);
    const sample = await module.mountTypedContextHarness("typed");
    return [await sample(0, 0, false, false), await sample(0, 0, false, true)];
  });
  expect(results[0]).toMatchObject({
    text: "Hello Alpha",
    uppercase: "0",
    color: "rgb(18, 52, 86)",
    error: null,
  });
  expect(results[1]).toMatchObject({
    text: "HELLO Alpha",
    uppercase: "1",
    color: "rgb(18, 52, 86)",
    error: null,
  });
  expect(results[1].textC).toContain("background: red");
});
test("step-only code updates immediately without continuous redraw", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const path = "/tests/helpers/typedContextHarness.tsx";
    const module: typeof import("../../helpers/typedContextHarness") =
      await import(/* @vite-ignore */ path);
    const sample = await module.mountTypedContextHarness("step-only");
    const start = await sample(0, 0);
    const click = await sample(2, 0);
    const node = document.querySelector<HTMLElement>("[data-effect-id]")!;
    const before = node.dataset.effectRevision;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { start, click, unchanged: before === node.dataset.effectRevision };
  });
  expect(results.start.text).toBe("0");
  expect(results.click.text).toBe("2");
  expect(results.unchanged).toBe(true);
});
test("Boolean/Text authoring and sidebar values reset and save with native types", async ({
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
  await page.getByRole("button", { name: "+ New Effect", exact: true }).click();
  const studio = page.getByRole("dialog", {
    name: "Effect Editor",
    exact: true,
  });
  await studio
    .getByLabel("Effect type", { exact: true })
    .selectOption("css-js");
  await studio
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Typed Text");
  await studio
    .getByRole("button", { name: "+ Parameter", exact: true })
    .click();
  await studio.getByLabel("Parameter 1 name").fill("Uppercase");
  await studio.getByLabel("Parameter 1 name").press("Tab");
  await studio.getByLabel("Uppercase type").selectOption("boolean");
  await studio
    .getByRole("button", { name: "+ Parameter", exact: true })
    .click();
  await studio.getByLabel("Parameter 2 name").fill("Prefix");
  await studio.getByLabel("Parameter 2 name").press("Tab");
  await studio.getByLabel("Prefix type").selectOption("string");
  await studio.getByLabel("Prefix default", { exact: true }).fill("Hello ");
  await studio.getByLabel("Effect affects").selectOption("text");
  await studio.getByRole("button", { name: "JS", exact: true }).click();
  await studio
    .getByLabel("Effect code")
    .fill(
      "function render({ text, parameters }) { return parameters.prefix + (parameters.uppercase ? text.toUpperCase() : text); }",
    );
  await studio
    .getByLabel("Effect code")
    .fill("function render({ stepIndex }) { return String(stepIndex); }");
  const preview = studio.locator("[data-effect-text-output]");
  await expect(preview).toHaveText("0");
  await expect(
    studio.getByRole("button", { name: /^(Play time|Pause)$/ }),
  ).toHaveCount(0);
  await expect(
    studio.getByRole("button", { name: "Reset", exact: true }),
  ).toBeVisible();
  await studio
    .getByRole("button", { name: "Preview click", exact: true })
    .click();
  await expect(preview).toHaveText("1");
  await studio
    .getByRole("button", { name: "Preview click", exact: true })
    .click();
  await expect(preview).toHaveText("2");
  await studio.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(preview).toHaveText("0");
  await studio
    .getByLabel("Effect code")
    .fill(
      "function render({ stepIndex, stepTime }) { return stepIndex + ':' + stepTime.toFixed(2); }",
    );
  await studio.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    studio.getByRole("button", { name: "Reset time", exact: true }),
  ).toBeVisible();
  const clock = studio.getByLabel("Effect preview time", { exact: true });
  const pausedTime = await clock.textContent();
  await studio.getByRole("button", { name: "Play time", exact: true }).click();
  await expect.poll(() => clock.textContent()).not.toBe(pausedTime);
  await studio
    .getByLabel("Effect code")
    .fill(
      "function render({ text, parameters }) { return parameters.prefix + (parameters.uppercase ? text.toUpperCase() : text); }",
    );
  await page.keyboard.press("Control+s");
  await expect(studio).toHaveCount(0);
  const effects = page.getByRole("region", {
    name: "Applied Effects",
    exact: true,
  });
  await expect(
    effects.getByLabel("Typed Text Uppercase", { exact: true }),
  ).not.toBeChecked();
  await expect(
    effects.getByLabel("Typed Text Prefix", { exact: true }),
  ).toHaveValue("Hello ");
  const output = page.locator("[data-editor-canvas] [data-effect-text-output]");
  const original = await page
    .locator("[data-editor-canvas] [data-text-content]")
    .textContent();
  await expect(output).toHaveText("Hello " + original);
  await effects.getByLabel("Typed Text Uppercase", { exact: true }).check();
  await effects
    .getByLabel("Typed Text Prefix", { exact: true })
    .fill("Changed ");
  await effects.getByLabel("Typed Text Prefix", { exact: true }).press("Enter");
  await expect(output).toHaveText("Changed " + original!.toUpperCase());
  await effects
    .getByRole("button", { name: "Reset parameters", exact: true })
    .click();
  await expect(
    effects.getByLabel("Typed Text Uppercase", { exact: true }),
  ).not.toBeChecked();
  await expect(output).toHaveText("Hello " + original);
  await page
    .getByRole("button", { name: "Edit definition…", exact: true })
    .click();
  await expect(studio.getByLabel("Uppercase type")).toHaveValue("boolean");
  await expect(studio.getByLabel("Prefix type")).toHaveValue("string");
  await expect(
    studio.getByLabel("Prefix default", { exact: true }),
  ).toHaveValue("Hello ");
});

test("GLSL and CSS receive logical step context while float parameters remain numeric", async ({
  page,
}) => {
  await page.goto("/");
  const sampled = await page.evaluate(async () => {
    const runtimePath = "/src/components/effectRuntime.ts",
      corePath = "/src/core/effects.ts";
    const { mountEffectSurface, effectSurface } = (await import(
      /* @vite-ignore */ runtimePath
    )) as typeof import("../../../src/components/effectRuntime");
    const {
      effectDefinitionSchema,
      newEffectInstance,
      effectTiming,
      reconcileShaderSource,
    } = (await import(
      /* @vite-ignore */ corePath
    )) as typeof import("../../../src/core/effects");
    const base = effectDefinitionSchema.parse({
      apiVersion: 1,
      name: "Step Shader",
      category: "effect",
      kind: "fragment-glsl",
      target: "overlay",
      input: "none",
      parameters: [],
      source: "void main() {}",
    });
    const definition = reconcileShaderSource(
      base,
      "#version 300 es\nprecision highp float; uniform float u_stepIndex; uniform float u_stepTime;\nuniform float strength; // @param 12 [0,60]\nout vec4 outColor; void main(){outColor=vec4(u_stepIndex/4.0, u_stepTime, strength/60.0, 1.0);}",
    );
    const node = document.createElement("div"),
      canvas = document.createElement("canvas");
    node.append(canvas);
    document.body.append(node);
    const unmount = mountEffectSurface(
      node,
      canvas,
      definition,
      newEffectInstance("shader", definition, "overlay"),
      { width: 4, height: 4 },
    );
    const timing = effectTiming(undefined, 2, 500, "e", "i");
    effectSurface(node)!.setTiming(timing);
    await effectSurface(node)!.flush();
    const pixel = Array.from(
      canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data,
    );
    unmount();
    const css = {
      ...definition,
      kind: "css" as const,
      input: undefined,
      source: ":scope { opacity: calc(var(--stepIndex) / 4); }",
      parameters: [],
    };
    const unmountCss = mountEffectSurface(
      node,
      null,
      css,
      newEffectInstance("css", css, "overlay"),
      { width: 4, height: 4 },
    );
    effectSurface(node)!.setTiming(timing);
    await effectSurface(node)!.flush();
    const opacity = getComputedStyle(node).opacity;
    unmountCss();
    return { pixel, opacity, parameter: definition.parameters[0] };
  });
  expect(sampled.parameter).toMatchObject({
    type: "number",
    default: 12,
    min: 0,
    max: 60,
  });
  expect(sampled.opacity).toBe("0.5");
  expect(sampled.pixel[0]).toBeGreaterThanOrEqual(127);
  expect(sampled.pixel[0]).toBeLessThanOrEqual(128);
  expect(sampled.pixel[1]).toBeGreaterThanOrEqual(127);
  expect(sampled.pixel[1]).toBeLessThanOrEqual(128);
  expect(sampled.pixel.slice(2)).toEqual([51, 255]);
});
