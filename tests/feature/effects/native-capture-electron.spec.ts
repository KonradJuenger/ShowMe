import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let origin: string;
let app: ElectronApplication | undefined;
let page: Page;
let folder: string;

test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw new Error("Missing smoke server address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "showme-native-capture-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  Object.assign(env, {
    SHOWME_TESTING: "1",
    SHOWME_TEST_ROOT_SELECTION: folder,
    SHOWME_DEV_URL: origin + "/tests/helpers/effects-harness.html",
  });
  // Use ShowMe's built Electron entrypoint and its shipping feature switches.
  // The test does not enable CanvasDrawElement itself.
  app = await electron.launch({
    args: [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`],
    env,
  });
  page = await app.firstWindow();
  await page.waitForURL("**/tests/helpers/effects-harness.html");
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function smoke(kind: "content" | "backdrop", info: TestInfo) {
  const runtime = await app!.evaluate(({ app }) => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    enabledFeatures: app.commandLine.getSwitchValue("enable-blink-features"),
    gpuFeatures: app.getGPUFeatureStatus(),
  }));
  const result = await page.evaluate(async (kind) => {
    const harnessPath = "/tests/helpers/mixedEffectsHarness.tsx";
    const texturePath = "/src/components/sceneTexture.ts";
    const {
      mountMixedEffectsHarness,
    }: typeof import("../../helpers/mixedEffectsHarness") = await import(
      /* @vite-ignore */ harnessPath
    );
    const {
      sceneTextureDiagnostics,
    }: typeof import("../../../src/components/sceneTexture") = await import(
      /* @vite-ignore */ texturePath
    );
    const capabilities = {
      drawElementImage:
        typeof (
          CanvasRenderingContext2D.prototype as CanvasRenderingContext2D & {
            drawElementImage?: unknown;
          }
        ).drawElementImage === "function",
      requestPaint:
        typeof (
          HTMLCanvasElement.prototype as HTMLCanvasElement & {
            requestPaint?: unknown;
          }
        ).requestPaint === "function",
    };
    const before = sceneTextureDiagnostics();
    const harness = await mountMixedEffectsHarness(undefined, 0, undefined, {
      configure(model) {
        const slide = model.slides[model.deck.slideIds[0]];
        const [text, glass] = slide.nodes[0].children;
        if (kind === "content") {
          text.effects = [text.effects![2]];
          slide.nodes[0].children = [text];
        } else {
          text.effects = [];
          slide.nodes[0].children = [text, glass];
        }
      },
    });
    try {
      const diagnostics = () =>
        [...harness.host.querySelectorAll<HTMLElement>("[data-effect-id]")].map(
          (node) => ({
            id: node.dataset.effectId,
            error: node.dataset.effectError,
            ready: node.dataset.effectReady,
            backend: node.dataset.effectSourceBackend,
          }),
        );
      let state: ReturnType<typeof harness.inspect>;
      try {
        state = await harness.stage(0);
      } catch (error) {
        return {
          capabilities,
          errors: [String(error)],
          backend: undefined,
          coloredPixels: 0,
          captures: sceneTextureDiagnostics().captures - before.captures,
          diagnostics: diagnostics(),
        };
      }
      const surface = state.surfaces[0];
      return {
        capabilities,
        errors: state.errors,
        backend: surface.backend,
        coloredPixels: kind === "content" ? surface.green : surface.red,
        captures: sceneTextureDiagnostics().captures - before.captures,
        diagnostics: diagnostics(),
      };
    } finally {
      harness.dispose();
    }
  }, kind);
  const report = { kind, runtime, ...result };
  await writeFile(
    info.outputPath("native-capture-smoke.json"),
    JSON.stringify(report, null, 2),
  );
  await info.attach("native-capture-smoke", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  expect(result.capabilities).toEqual({
    drawElementImage: true,
    requestPaint: true,
  });
  expect(result.errors).toEqual([]);
  expect(result.backend).toBe("scene-texture");
  expect(result.captures).toBeGreaterThan(0);
  expect(result.coloredPixels).toBeGreaterThan(1000);
}

test("shipping Electron captures styled native content for content GLSL", async ({
  browserName: _browserName,
}, info) => {
  await smoke("content", info);
});

test("shipping Electron captures styled native pixels for backdrop GLSL", async ({
  browserName: _browserName,
}, info) => {
  await smoke("backdrop", info);
});
