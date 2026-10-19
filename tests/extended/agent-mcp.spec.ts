import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { newPresentationDocument } from "../../src/core/document";
import { createTextElement } from "../../src/core/text";
import { readyEditor } from "../helpers/startup";
import { bridgeRead, ShowMeClient } from "../../mcp/showmeClient";
import type { BridgeDescriptor } from "../../electron/agentBridge";
import type { AgentContext } from "../../src/core/agentContext";
import { DocumentStorage } from "../../electron/storage";
import { advertisedApplySchema } from "../../mcp/applyTransport";
import { AGENT_CONTRACT_VERSION } from "../../src/core/agentProtocol";
import { SHOWME_MCP_SERVER_VERSION } from "../../src/core/agentRead";

const helperPath = () =>
  path.resolve(process.env.SHOWME_MCP_HELPER ?? "dist-electron/showme-mcp.cjs");

async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-mcp-"));
  const root = path.join(folder, "root"),
    user = path.join(folder, "user"),
    file = path.join(root, "MCP.sme");
  await mkdir(path.join(root, "ShowMe Library"), { recursive: true });
  await mkdir(user);
  const model = newPresentationDocument("MCP fixture"),
    slide = model.slides[model.deck.slideIds[0]];
  const title = createTextElement("title");
  if (title.content?.type === "text")
    title.content.text = "Read-only MCP title";
  slide.nodes[0].children = [title];
  slide.notes = "PRIVATE_NOTES";
  await writeFile(file, JSON.stringify(model));
  await writeFile(
    path.join(user, "settings.json"),
    JSON.stringify({
      showMeRootPath: root,
      libraryLifecycleMode: "keep-all",
      storageWarningSeen: true,
    }),
  );
  return { folder, root, user, file };
}
async function launch(user: string, file: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        ![
          "ELECTRON_RUN_AS_NODE",
          "SHOWME_DOCUMENT_DIR",
          "SHOWME_DEV_URL",
        ].includes(key) && value !== undefined,
    ),
  ) as Record<string, string>;
  const app = await electron.launch({
    ...(process.env.SHOWME_MCP_PACKAGED_EXE
      ? { executablePath: path.resolve(process.env.SHOWME_MCP_PACKAGED_EXE) }
      : {}),
    args: [
      ...(process.env.SHOWME_MCP_PACKAGED_EXE ? [] : [path.resolve(".")]),
      file,
      `--user-data-dir=${user}`,
    ],
    env,
  });
  const startupErrors: string[] = [];
  app.process().stderr?.on("data", (data) => startupErrors.push(String(data)));
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    return { app, page };
  } catch (error) {
    // A native startup error dialog can block main-process evaluation. Terminate
    // only this fixture's process instead of waiting on app.exit through IPC.
    app.process().kill();
    await app.close().catch(() => {});
    throw new Error(
      `Electron fixture failed to start: ${startupErrors.join("")}`,
      { cause: error },
    );
  }
}
async function close(app: ElectronApplication | undefined) {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}
async function settings(page: Page) {
  await page
    .getByRole("button", { name: "Presentation menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings…", exact: true }).click();
}
async function connect(user: string, cwd: string) {
  const client = new Client({ name: "showme-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [helperPath(), "--user-data", user],
    cwd,
    stderr: "pipe",
    maxBufferSize: 32 * 1024 * 1024,
  });
  const errors: string[] = [],
    stderr: string[] = [];
  transport.onerror = (error) => errors.push(error.message);
  transport.stderr?.on("data", (data) => stderr.push(String(data)));
  await client.connect(transport);
  return { client, transport, errors, stderr };
}
async function context(client: Client): Promise<AgentContext> {
  const result = await client.callTool({
    name: "showme.context",
    arguments: {},
  });
  expect(result.isError).toBe(false);
  return (result.structuredContent as { data: AgentContext }).data;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring to access testInfo.
test("raw SDK tools list advertises compact envelopes with strict canonical admission", async ({}, testInfo) => {
  const f = await fixture();
  const { client } = await connect(f.user, f.folder);
  try {
    const catalog = await client.listTools();
    const raw = catalog.tools.find((tool) => tool.name === "showme.apply")!;
    expect(raw.inputSchema).toEqual({
      ...advertisedApplySchema(),
      type: "object",
    });
    const bytes = Buffer.byteLength(JSON.stringify(raw.inputSchema));
    expect(bytes).toBeLessThanOrEqual(6144);
    const envelope = { documentId: "document", epoch: "epoch", expectedRevision: 0, mutationId: "invalid", slideId: "slide" };
    for (const operations of [
      [{ type: "no.such_operation" }],
      [{ type: "deck.rename", name: "Name", unexpected: true }],
      [{ type: "element.insert_text", parentId: "layer", text: "Invalid", frame: { x: 0, y: 0, width: -1, height: 80 } }],
    ]) {
      const rejected = await client.callTool({ name: "showme.apply", arguments: { ...envelope, operations } });
      expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", details: { issues: expect.any(Array) } } });
    }
    await writeFile(
      testInfo.outputPath("tools-list.json"),
      JSON.stringify(catalog, null, 2),
    );
    await testInfo.attach("schema-size", {
      body: `${bytes} bytes`,
      contentType: "text/plain",
    });
  } finally {
    await client.close();
    await rm(f.folder, { recursive: true, force: true });
  }
});

async function coldRuntime(first: "measure" | "shader" | "css" | "text-js") {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    await launched.page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });
    client = (await connect(f.user, f.folder)).client;
    const initial = await context(client);
    // Startup thumbnails may have their own surface; no agent runtime request has run.
    const existingSurfaces = new Set(app.windows());
    const identity = {
      documentId: initial.document!.id,
      epoch: initial.document!.epoch,
    };
    const request =
      first === "measure"
        ? {
            name: "showme.measure_text",
            arguments: {
              ...identity,
              revision: initial.document!.revision,
              items: [{ text: "Cold production layout", width: 400 }],
            },
          }
        : {
            name: "showme.apply",
            arguments: {
              ...identity,
              expectedRevision: initial.document!.revision,
              mutationId: `cold-${first}`,
              slideId: initial.editor!.page.id,
              operations: [
                {
                  type: "effect.apply_code",
                  elementId: "title",
                  name: "Cold effect",
                  effectType: first,
                  affects:
                    first === "shader"
                      ? "generated"
                      : first === "css"
                        ? "element"
                        : "text",
                  source:
                    first === "shader"
                      ? "#version 300 es\nprecision highp float;\nin vec2 v_uv; out vec4 outColor;\nvoid main() { outColor = vec4(1.0, 0.2, 0.0, 1.0); }"
                      : first === "css"
                        ? ":scope { opacity: 0.9; }"
                        : "function render({ text }) { return text.toUpperCase(); }",
                },
              ],
            },
          };
    const result = await client.callTool(request);
    expect(result.isError, JSON.stringify(result)).toBe(false);
    const after = await context(client);
    expect(after.editor!.page).toEqual(initial.editor!.page);
    expect(after.editor!.selectionIds).toEqual(initial.editor!.selectionIds);
    if (first === "measure") {
      expect(result.structuredContent).toMatchObject({
        ok: true,
        measurements: [
          { width: expect.any(Number), height: expect.any(Number) },
        ],
      });
      expect(after.document!.revision).toBe(initial.document!.revision);
    }
    const runtime = app
      .windows()
      .find(
        (page) =>
          page.url().includes("slidePreview=1") && !existingSurfaces.has(page),
      )!;
    await runtime.close();
    const next = await client.callTool({
      name: "showme.measure_text",
      arguments: {
        ...identity,
        revision: after.document!.revision,
        items: [{ text: "Recovered layout", width: 400 }],
      },
    });
    expect(next.isError, JSON.stringify(next.structuredContent)).toBe(false);
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
}

test("cold runtime measures text without insertion or preview and recovers after renderer loss", async () => {
  await coldRuntime("measure");
});
test("cold runtime validates shader as its first renderer mutation", async () => {
  await coldRuntime("shader");
});
test("cold runtime validates CSS as its first renderer mutation", async () => {
  await coldRuntime("css");
});
test("cold runtime validates text-JS as its first renderer mutation", async () => {
  await coldRuntime("text-js");
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring to access testInfo.
test("MCP page batching and font fit feedback use the native document and layout services", async ({}, testInfo) => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    await launched.page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });
    client = (await connect(f.user, f.folder)).client;
    const initial = await context(client);
    const identity = {
      documentId: initial.document!.id,
      epoch: initial.document!.epoch,
    };
    const measured = await client.callTool({
      name: "showme.measure_text",
      arguments: {
        ...identity,
        revision: initial.document!.revision,
        items: [
          {
            text: "First line\nSecond line",
            width: 200,
            height: 10,
            typography: { fontFamily: "Arial", fontSize: 32 },
          },
          {
            text: "Fallback",
            width: 200,
            typography: { fontFamily: "ShowMe-Missing-Font-829148" },
          },
        ],
      },
    });
    expect(measured.isError, JSON.stringify(measured.structuredContent)).toBe(
      false,
    );
    expect(measured.structuredContent).toMatchObject({
      measurements: [
        {
          overflow: { vertical: true },
          font: {
            availability: "available",
            source: "platform",
            resolvedFamily: null,
          },
        },
        {
          font: {
            availability: "unavailable",
            fallback: "possible",
            resolvedFamily: null,
          },
        },
      ],
    });
    const discovery: Record<string, number> = {};
    for (const family of [
      "slide",
      "deck",
      "element",
      "motion",
      "presence",
      "effect",
      "timeline",
    ]) {
      const result = await client.callTool({
        name: "showme.authoring",
        arguments: { kind: "operations", family, detail: "compact" },
      });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      discovery[family] = Buffer.byteLength(
        JSON.stringify(result.structuredContent),
      );
    }
    const full = await client.callTool({
      name: "showme.authoring",
      arguments: { kind: "background-shader", detail: "full" },
    });
    discovery.fullShaderPrompt = Buffer.byteLength(
      JSON.stringify(full.structuredContent),
    );
    await testInfo.attach("discovery-bytes", {
      body: JSON.stringify(discovery),
      contentType: "application/json",
    });
    await writeFile(
      testInfo.outputPath("discovery-bytes.json"),
      JSON.stringify(discovery),
    );
    const outline = await client.callTool({
      name: "showme.inspect",
      arguments: {
        ...identity,
        revision: 0,
        target: { type: "slide", slideId: initial.editor!.page.id },
      },
    });
    const parentId = (outline.structuredContent as any).data.layers[0].id;
    const request = {
      ...identity,
      expectedRevision: 0,
      mutationId: "native-pages",
      slideId: initial.editor!.page.id,
      pages: Array.from({ length: 7 }, (_, index) => ({
        slideId: `native-page-${index}`,
        operations: [
          {
            type: "slide.create",
            id: `native-page-${index}`,
            afterId: index
              ? `native-page-${index - 1}`
              : initial.editor!.page.id,
            name: `Native page ${index}`,
          },
          {
            type: "element.insert_text",
            id: `native-copy-${index}`,
            parentId,
            frame: { x: 80, y: 100, width: 800, height: 100 },
            text: `Native page ${index}`,
          },
        ],
      })),
    };
    const started = performance.now();
    const result = await client.callTool({
      name: "showme.apply",
      arguments: request,
    });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(result.structuredContent).toMatchObject({
      revision: 1,
      createdSlideIds: request.pages.map(({ slideId }) => slideId),
      pageResults: expect.any(Array),
    });
    await testInfo.attach("page-batch", {
      body: JSON.stringify({
        elapsedMs: performance.now() - started,
        requestBytes: Buffer.byteLength(JSON.stringify(request)),
        pages: 7,
        calls: 1,
      }),
      contentType: "application/json",
    });
    expect((await context(client)).editor!.page).toEqual(initial.editor!.page);
    const replay = await client.callTool({
      name: "showme.apply",
      arguments: request,
    });
    expect(replay.structuredContent).toMatchObject({
      replayed: true,
      revision: 1,
      currentObservation: { revision: 1 },
    });
    expect(
      (
        await client.callTool({
          name: "showme.deliver",
          arguments: { ...identity, expectedRevision: 0, action: "save" },
        })
      ).structuredContent,
    ).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const saved = await client.callTool({
      name: "showme.deliver",
      arguments: { ...identity, expectedRevision: 1, action: "save" },
    });
    expect(saved.isError, JSON.stringify(saved.structuredContent)).toBe(false);
    expect(saved.structuredContent).toMatchObject({
      ok: true,
      data: {
        revision: 1,
        written: true,
        cancelled: false,
        destination: f.file,
        format: "sme",
        preservesAnimation: true,
        overwritten: true,
      },
    });
    await expect
      .poll(async () => (await context(client!)).editor?.page.id)
      .toBe(initial.editor!.page.id);
    expect((await context(client)).editor!.selectionIds).toEqual(
      initial.editor!.selectionIds,
    );
    await close(app);
    const reopened = await launch(f.user, f.file);
    app = reopened.app;
    const fresh = await context(client);
    expect(fresh.document!.dirty).toBe(false);
    const deck = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: fresh.document!.id,
        epoch: fresh.document!.epoch,
        revision: fresh.document!.revision,
        target: { type: "deck" },
      },
    });
    expect(
      (deck.structuredContent as any).data.deck.slides.map(
        ({ id }: { id: string }) => id,
      ),
    ).toEqual([
      initial.editor!.page.id,
      ...request.pages.map(({ slideId }) => slideId),
    ]);
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

test("MCP builds multiple styled slides with production text measurement and real pixels after capture resizing", async () => {
  const f = await fixture();
  const mediaBytes = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 70, g: 120, b: 200, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const mediaId = createHash("sha256").update(mediaBytes).digest("hex");
  const fixtureStorage = new DocumentStorage(
    path.join(f.root, "ShowMe Library"),
    path.join(f.folder, "fixture-cache"),
    "keep-all",
  );
  await fixtureStorage.init();
  const imported = await fixtureStorage.importAssetData(
    "mcp-sample.png",
    mediaBytes,
  );
  await fixtureStorage.updateAsset({ ...imported, width: 64, height: 64 });
  await fixtureStorage.dispose();

  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    const page = launched.page;
    // Dimensions are runtime-derived metadata, not persisted by updateAsset across
    // storage instances. Model the native imported-media enrichment in this host.
    await page.evaluate(async (assetId) => {
      const asset = await window.desktop!.getAsset(assetId);
      await window.desktop!.updateAsset({ ...asset, width: 64, height: 64 });
    }, mediaId);
    client = (await connect(f.user, f.folder)).client;
    await page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });
    const initial = await context(client);
    const assets = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: initial.document!.revision,
        target: { type: "assets", query: "mcp-sample", limit: 10 },
      },
    });
    expect(assets.isError, JSON.stringify(assets.structuredContent)).toBe(
      false,
    );
    expect(assets.structuredContent).toMatchObject({
      data: {
        assets: {
          items: [
            {
              assetId: mediaId,
              name: "mcp-sample.png",
              type: "image",
              width: 64,
              height: 64,
            },
          ],
        },
      },
    });

    const apply = async (
      slideId: string,
      operations: unknown[],
      mutationId = crypto.randomUUID(),
    ) => {
      const current = await context(client!);
      const result = await client!.callTool({
        name: "showme.apply",
        arguments: {
          documentId: current.document!.id,
          epoch: current.document!.epoch,
          expectedRevision: current.document!.revision,
          mutationId,
          slideId,
          operations,
        },
      });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      return result.structuredContent as any;
    };
    const anchor = initial.editor!.page.id;
    const anchorInspect = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: initial.document!.revision,
        target: { type: "slide", slideId: anchor },
      },
    });
    const parentId = (anchorInspect.structuredContent as any).data.layers[0].id;
    const first = await apply(anchor, [
      {
        type: "slide.create",
        id: "mcp-title-slide",
        afterId: anchor,
        name: "A local creative partner",
        background: "#152F32",
      },
      { type: "deck.rename", name: "ShowMe MCP deck" },
      {
        type: "element.insert_text",
        id: "mcp-title",
        parentId,
        frame: { x: 160, y: 220, width: 960, height: 150 },
        autoSize: "none",
        text: "Create locally.",
        typography: { fontSize: 100, color: "#F6F3EB", bold: true },
      },
      {
        type: "element.insert_text",
        id: "mcp-subtitle",
        parentId,
        frame: { x: 160, y: 400, width: 820, height: 90 },
        autoSize: "none",
        text: "A complete slide authored through MCP.",
        typography: { fontSize: 42, color: "#F6F3EB" },
      },
      {
        type: "element.insert_shape",
        id: "mcp-rule",
        parentId,
        shape: "rectangle",
        frame: { x: 160, y: 520, width: 720, height: 4 },
        appearance: { fill: "#F6F3EB", strokeWidth: 0 },
      },
      {
        type: "element.insert_shape",
        id: "mcp-accent",
        parentId,
        shape: "rectangle",
        frame: { x: 1200, y: 200, width: 400, height: 600 },
        appearance: { fill: "#D6ED88", strokeWidth: 0 },
      },
      {
        type: "element.insert_media",
        id: "mcp-media",
        parentId,
        assetId: mediaId,
        frame: { x: 920, y: 820, width: 220, height: 120 },
        name: "Managed MCP image",
      },
      {
        type: "elements.group",
        id: "mcp-copy",
        elementIds: ["mcp-title", "mcp-subtitle", "mcp-rule"],
      },
    ]);
    expect(first).toMatchObject({
      createdSlideIds: ["mcp-title-slide"],
      createdIds: expect.arrayContaining([
        "mcp-title",
        "mcp-subtitle",
        "mcp-rule",
        "mcp-accent",
        "mcp-media",
        "mcp-copy",
      ]),
    });
    const firstId = "mcp-title-slide";
    const second = await apply(anchor, [
      {
        type: "slide.create",
        afterId: firstId,
        name: "Keep a way back",
        background: "#F6F3EB",
      },
    ]);
    const secondId = second.createdSlideIds[0];
    const styled = await apply(secondId, [
      {
        type: "slide.update",
        name: "Your edits stay recoverable",
        background: "#007F73",
      },
      {
        type: "element.insert_text",
        parentId,
        frame: { x: 520, y: 300, width: 800, height: 180 },
        autoSize: "both",
        text: "Keep a way back.",
        typography: { fontSize: 90, color: "#FFFFFF" },
      },
    ]);
    const after = await context(client);
    expect(after.editor!.page).toEqual(initial.editor!.page);
    expect(after.editor!.selectionIds).toEqual(initial.editor!.selectionIds);
    const capture = async (
      slideId: string,
      width: number,
      height: number,
      point: [number, number],
      expected: number[],
    ) => {
      const result = await client!.callTool({
        name: "showme.preview",
        arguments: {
          documentId: after.document!.id,
          epoch: after.document!.epoch,
          revision: styled.revision,
          slideId,
          width,
          height,
        },
      });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      const image = result.content.find((item) => item.type === "image");
      if (!image || image.type !== "image")
        throw new Error("Missing preview image");
      const { data, info } = await sharp(Buffer.from(image.data, "base64"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([width, height]);
      const start = (point[1] * width + point[0]) * 4;
      expect([...data.subarray(start, start + 4)]).toEqual(expected);
      return data;
    };
    const data = await capture(
      firstId,
      960,
      540,
      [700, 200],
      [214, 237, 136, 255],
    );
    expect([
      ...data.subarray((10 * 960 + 10) * 4, (10 * 960 + 10) * 4 + 4),
    ]).toEqual([21, 47, 50, 255]);
    expect(
      [...data].some(
        (v, i) =>
          i % 4 === 0 && v > 230 && data[i + 1] > 230 && data[i + 2] > 220,
      ),
    ).toBe(true);
    const mediaPixel = (410 * 960 + 500) * 4;
    expect([...data.subarray(mediaPixel, mediaPixel + 4)]).toEqual([
      70, 120, 200, 255,
    ]);
    await capture(secondId, 480, 270, [10, 10], [0, 127, 115, 255]);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => !win.webContents.getURL().includes("slidePreview=1"))
        ?.minimize();
    });
    await capture(firstId, 720, 405, [525, 150], [214, 237, 136, 255]);
    const deck = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: after.document!.id,
        epoch: after.document!.epoch,
        revision: styled.revision,
        target: { type: "deck" },
      },
    });
    expect((deck.structuredContent as any).data.deck).toMatchObject({
      name: "ShowMe MCP deck",
      slideCount: 3,
    });

    const beforeDashboard = await context(client);
    const measured = await client.callTool({
      name: "showme.measure_text",
      arguments: {
        documentId: beforeDashboard.document!.id,
        epoch: beforeDashboard.document!.epoch,
        revision: beforeDashboard.document!.revision,
        items: [
          {
            text: "Three signals, one system.",
            width: 1080,
            typography: {
              fontFamily: "Arial",
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: 0,
            },
          },
          {
            text: "Each card is one structural component, not a pile of independently animated children.",
            width: 1080,
            typography: {
              fontFamily: "Arial",
              fontSize: 30,
              fontWeight: 400,
              lineHeight: 1.2,
              letterSpacing: 0,
            },
          },
        ],
      },
    });
    expect(measured.isError, JSON.stringify(measured.structuredContent)).toBe(
      false,
    );
    const dashboardMeasurements = (measured.structuredContent as any)
      .measurements;
    expect(dashboardMeasurements).toHaveLength(2);
    expect(dashboardMeasurements.every((value: any) => value.height > 0)).toBe(
      true,
    );

    const dashboardId = "mcp-dashboard-slide";
    const dashboard = await apply(secondId, [
      {
        type: "slide.create",
        id: dashboardId,
        afterId: secondId,
        name: "Composite dashboard",
        background: "#101820",
      },
      {
        type: "element.insert_text",
        id: "dashboard-title",
        parentId,
        frame: {
          x: 120,
          y: 80,
          width: 1080,
          height: Math.ceil(dashboardMeasurements[0].height) + 8,
        },
        autoSize: "none",
        text: "Three signals, one system.",
        typography: {
          fontFamily: "Arial",
          fontSize: 68,
          fontWeight: 700,
          color: "#FFFFFF",
          lineHeight: 1.05,
        },
      },
      {
        type: "element.insert_text",
        id: "dashboard-subtitle",
        parentId,
        frame: {
          x: 120,
          y: 166,
          width: 1080,
          height: Math.ceil(dashboardMeasurements[1].height) + 8,
        },
        autoSize: "none",
        text: "Each card is one structural component, not a pile of independently animated children.",
        typography: {
          fontFamily: "Arial",
          fontSize: 30,
          color: "#BFC7CE",
          lineHeight: 1.2,
        },
      },
      ...["a", "b", "c"].flatMap((suffix, index) => {
        const cardId = `dashboard-card-${suffix}`;
        return [
          {
            type: "element.insert_frame",
            id: cardId,
            parentId,
            frame: {
              x: 120 + index * 540,
              y: 300,
              width: 480,
              height: 360,
            },
            name: `Dashboard card ${index + 1}`,
          },
          {
            type: "element.insert_shape",
            id: `${cardId}-background`,
            parentId: cardId,
            shape: "rectangle",
            frame: { x: 0, y: 0, width: 480, height: 360 },
            appearance: { fill: "#F5F6F7", strokeWidth: 0, radius: 22 },
          },
          {
            type: "element.insert_text",
            id: `${cardId}-label`,
            parentId: cardId,
            frame: { x: 32, y: 30, width: 416, height: 44 },
            autoSize: "none",
            text: `Signal ${index + 1}`,
            typography: { fontSize: 24, color: "#58636C" },
          },
          {
            type: "element.insert_text",
            id: `${cardId}-metric`,
            parentId: cardId,
            frame: { x: 32, y: 105, width: 416, height: 90 },
            autoSize: "none",
            text: `${28 + index * 17}%`,
            typography: {
              fontSize: 64,
              fontWeight: 700,
              color: "#101820",
            },
          },
          {
            type: "element.insert_shape",
            id: `${cardId}-progress`,
            parentId: cardId,
            shape: "rectangle",
            frame: {
              x: 32,
              y: 270,
              width: 150 + index * 95,
              height: 12,
            },
            appearance: { fill: "#007F73", strokeWidth: 0, radius: 6 },
          },
        ];
      }),
      {
        type: "presence.add",
        stageIndex: 1,
        elementIds: [
          "dashboard-card-a",
          "dashboard-card-b",
          "dashboard-card-c",
        ],
        transition: "move",
        direction: "Up",
        distance: 48,
        durationMs: 400,
        easing: "Ease Out",
      },
    ]);
    expect(dashboard).toMatchObject({
      ok: true,
      createdSlideIds: [dashboardId],
      createdIds: expect.arrayContaining([
        "dashboard-card-a",
        "dashboard-card-b",
        "dashboard-card-c",
      ]),
    });

    const cardIds = [
      "dashboard-card-a",
      "dashboard-card-b",
      "dashboard-card-c",
    ];
    const cardInspection = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: beforeDashboard.document!.id,
        epoch: beforeDashboard.document!.epoch,
        revision: dashboard.revision,
        target: {
          type: "elements",
          slideId: dashboardId,
          elementIds: [...cardIds, ...cardIds.map((id) => `${id}-label`)],
          includeMotion: true,
          includePresence: true,
        },
      },
    });
    expect(
      cardInspection.isError,
      JSON.stringify(cardInspection.structuredContent),
    ).toBe(false);
    const cardDetails = (cardInspection.structuredContent as any).data.elements;
    for (const cardId of cardIds) {
      const card = cardDetails.find((value: any) => value.id === cardId);
      const label = cardDetails.find(
        (value: any) => value.id === `${cardId}-label`,
      );
      expect(card).toMatchObject({
        parentId,
        container: true,
        childCount: 4,
        hasPresence: true,
        hasMotion: false,
        presenceStageIndices: [1],
      });
      expect(card.presence).toHaveLength(1);
      expect(card.presence[0]).toMatchObject({
        stageIndex: 1,
        schedule: {
          enterTransition: {
            kind: "move",
            direction: "Up",
            distance: 48,
            durationMs: 400,
          },
        },
      });
      expect(label).toMatchObject({
        parentId: cardId,
        depth: 1,
        hasPresence: false,
        hasMotion: false,
      });
      expect(label.presence).toEqual([]);
      expect(label.motion).toEqual([]);
    }

    const dashboardPreview = await client.callTool({
      name: "showme.preview",
      arguments: {
        documentId: beforeDashboard.document!.id,
        epoch: beforeDashboard.document!.epoch,
        revision: dashboard.revision,
        slideId: dashboardId,
        width: 640,
        height: 360,
      },
    });
    expect(
      dashboardPreview.isError,
      JSON.stringify(dashboardPreview.structuredContent),
    ).toBe(false);
    expect(
      dashboardPreview.content.some((value) => value.type === "image"),
    ).toBe(true);

    const dashboardDeck = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: beforeDashboard.document!.id,
        epoch: beforeDashboard.document!.epoch,
        revision: dashboard.revision,
        target: { type: "deck" },
      },
    });
    expect((dashboardDeck.structuredContent as any).data.deck).toMatchObject({
      name: "ShowMe MCP deck",
      slideCount: 4,
    });
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

test("local opt-in enables atomic MCP editing with production text sizing explicit targets preview and separate human agent undo", async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    const page = launched.page;
    const connected = await connect(f.user, f.folder);
    client = connected.client;
    await settings(page);
    const editing = page.getByLabel("Allow agent editing", { exact: true });
    await expect(editing).not.toBeChecked();
    await expect(editing).toBeDisabled();
    await page.getByLabel("Enable MCP", { exact: true }).check();
    await expect(editing).toBeEnabled();
    const disabled = await context(client);
    const input = {
      documentId: disabled.document!.id,
      epoch: disabled.document!.epoch,
      slideId: disabled.editor!.page.id,
      expectedRevision: disabled.document!.revision,
      mutationId: "disabled",
      operations: [{ type: "text.set", elementId: "title", text: "Not yet" }],
    };
    expect(
      (await client.callTool({ name: "showme.apply", arguments: input }))
        .structuredContent,
    ).toMatchObject({ error: { code: "EDITING_DISABLED" } });
    await editing.check();
    await expect
      .poll(() => context(client!).then((value) => value.editing?.available))
      .toBe(true);
    expect(
      JSON.parse(await readFile(path.join(f.user, "settings.json"), "utf8"))
        .mcpEditingEnabled,
    ).toBe(true);
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    // A separate human edit establishes actor-local history and selection.
    await page.getByRole("button", { name: "Frame", exact: true }).click();
    await expect
      .poll(() =>
        context(client!).then((value) => value.editor!.selectionIds.length),
      )
      .toBe(1);
    const before = await context(client);
    const original = await page.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      before.document!.id,
    );
    const root = original.slide.nodes[0].id;
    const request = {
      ...input,
      expectedRevision: before.document!.revision,
      mutationId: "atomic-edit",
      operations: [
        {
          type: "text.set",
          elementId: "title",
          text: "A longer agent title\nwith a second line",
        },
        {
          type: "element.insert_text",
          parentId: root,
          frame: { x: 500, y: 400, width: 800, height: 180 },
          autoSize: "both",
          text: "Native measured label",
          name: "Agent label",
        },
        {
          type: "element.insert_shape",
          parentId: root,
          shape: "ellipse",
          frame: { x: 100, y: 400, width: 160, height: 90 },
          appearance: { fill: "#ff0000" },
        },
      ],
    };
    const result = await client.callTool({
      name: "showme.apply",
      arguments: request,
    });
    expect(result.isError).toBe(false);
    const receipt = result.structuredContent as any;
    expect(receipt).toMatchObject({
      ok: true,
      changed: true,
      previousRevision: before.document!.revision,
      revision: before.document!.revision + 1,
      createdIds: [expect.any(String), expect.any(String)],
      changedIds: ["title"],
    });
    const after = await context(client);
    expect(after.editor!.selectionIds).toEqual(before.editor!.selectionIds);
    expect(after.editor!.page).toEqual(before.editor!.page);
    expect(after.editor!.timeline).toEqual(before.editor!.timeline);
    const inspected = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: after.document!.id,
        epoch: after.document!.epoch,
        revision: after.document!.revision,
        target: {
          type: "elements",
          slideId: input.slideId,
          elementIds: ["title", ...receipt.createdIds],
        },
      },
    });
    expect(inspected.isError).toBe(false);
    const detail = (inspected.structuredContent as any).data.elements;
    expect(detail.find((value: any) => value.id === "title").content.text).toBe(
      request.operations[0].text,
    );
    expect(
      detail.find((value: any) => value.id === receipt.createdIds[0]),
    ).toMatchObject({
      name: "Agent label",
      content: { text: "Native measured label", autoSize: "both" },
    });
    expect(
      detail.find((value: any) => value.id === receipt.createdIds[0]).frame
        .width,
    ).toBeGreaterThan(100);
    expect(
      detail.find((value: any) => value.id === receipt.createdIds[0]).frame
        .width,
    ).toBeLessThan(800);
    const preview = await client.callTool({
      name: "showme.preview",
      arguments: {
        documentId: input.documentId,
        epoch: input.epoch,
        revision: receipt.revision,
        slideId: input.slideId,
        width: 320,
        height: 180,
      },
    });
    expect(preview.isError).toBe(false);
    expect(preview.content.some((value) => value.type === "image")).toBe(true);
    await expect(
      page.getByRole("button", { name: "Undo agent edit", exact: true }),
    ).toBeVisible();
    // A second helper recovers the same receipt without inserting again.
    const reconnect = await connect(f.user, f.folder);
    try {
      expect(
        (
          await reconnect.client.callTool({
            name: "showme.apply",
            arguments: request,
          })
        ).structuredContent,
      ).toEqual({
        ...receipt,
        replayed: true,
        currentObservation: {
          epoch: before.document!.epoch,
          revision: receipt.revision,
        },
      });
    } finally {
      await reconnect.client.close();
    }
    await expect(
      page.getByRole("button", { name: "Undo agent edit", exact: true }),
    ).toBeVisible();
    await settings(page);
    await editing.uncheck();
    await page.getByLabel("Enable MCP", { exact: true }).uncheck();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    // User recovery is still available while both external permissions are off.
    await page
      .getByRole("button", { name: "Undo agent edit", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .evaluate(
            (id) => window.desktop!.documentProjection!(id),
            input.documentId,
          )
          .then((value) =>
            value.slide.nodes[0].children.some(
              (element) => element.id === receipt.createdIds[0],
            ),
          ),
      )
      .toBe(false);
    await page
      .getByRole("button", { name: "Redo agent edit", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .evaluate(
            (id) => window.desktop!.documentProjection!(id),
            input.documentId,
          )
          .then((value) =>
            value.slide.nodes[0].children.some(
              (element) => element.id === receipt.createdIds[0],
            ),
          ),
      )
      .toBe(true);
    // Human history remains actor-local. Changing the common parent structure can
    // legitimately prevent undoing older insertions; retain that authority guard.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(() =>
        page
          .evaluate(
            (id) => window.desktop!.documentProjection!(id),
            input.documentId,
          )
          .then((value) =>
            value.slide.nodes[0].children.some(
              (element) => element.id === before.editor!.selectionIds[0],
            ),
          ),
      )
      .toBe(false);
    const guarded = await page.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      input.documentId,
    );
    expect(
      guarded.slide.nodes[0].children.some(
        (element) => element.id === receipt.createdIds[0],
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        (documentId) => window.desktop!.agentUndo!({ documentId, redo: false }),
        input.documentId,
      ),
    ).toMatchObject({ ok: false, error: { code: "HISTORY_CONFLICT" } });
    expect(
      await page.evaluate(
        (id) => window.desktop!.documentProjection!(id),
        input.documentId,
      ),
    ).toEqual(guarded);
    expect(connected.errors).toEqual([]);
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

test("real stdio client reads context inspection and production PNG with Settings configuration and revocation", async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    const page = launched.page;
    const connected = await connect(f.user, f.folder);
    client = connected.client;
    expect(
      (await client.callTool({ name: "showme.context", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ error: { code: "APP_UNAVAILABLE" } });
    const catalog = await client.listTools();
    expect(catalog.tools.map((value) => value.name)).toEqual([
      "showme.workspace",
      "showme.context",
      "showme.authoring",
      "showme.inspect",
      "showme.measure_text",
      "showme.apply",
      "showme.deliver",
      "showme.preview",
    ]);
    expect(
      catalog.tools.every(
        (value) =>
          value.outputSchema &&
          value.annotations?.readOnlyHint ===
            !["showme.apply", "showme.deliver", "showme.workspace"].includes(
              value.name,
            ),
      ),
    ).toBe(true);
    await settings(page);
    await page.getByLabel("Enable MCP", { exact: true }).check();
    await expect(
      page.getByText("Local connection is ready.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Copy for MCP clients (JSON)", exact: true })
      .click();
    const configuration = JSON.parse(
      await page.evaluate(() => window.desktop!.readTextClipboard!()),
    );
    expect(configuration.mcpServers.showme).toEqual({
      command: "node",
      args: [helperPath(), "--user-data", f.user],
    });
    expect(JSON.stringify(configuration)).not.toContain("token");
    await expect(page.getByText("MCP clients (JSON) configuration copied. Add it to your client, then reconnect.")).toBeVisible();
    await page.getByRole("button", { name: "Copy for VS Code (JSON)", exact: true }).click();
    expect(JSON.parse(await page.evaluate(() => window.desktop!.readTextClipboard!()))).toEqual({
      servers: { showme: { type: "stdio", ...configuration.mcpServers.showme } },
    });
    await expect(page.getByText("VS Code (JSON) configuration copied. Add it to your client, then reconnect.")).toBeVisible();
    await page.getByRole("button", { name: "Copy for Codex (TOML)", exact: true }).click();
    const toml = await page.evaluate(() => window.desktop!.readTextClipboard!());
    expect(toml.split("\n")[0]).toBe("[mcp_servers.showme]");
    expect(JSON.parse(toml.split("\n")[1].replace("command = ", ""))).toBe("node");
    expect(JSON.parse(toml.split("\n")[2].replace("args = ", ""))).toEqual(configuration.mcpServers.showme.args);
    await expect(page.getByText("Codex (TOML) configuration copied. Add it to your client, then reconnect.")).toBeVisible();
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Frame", exact: true }).click();
    await expect
      .poll(() =>
        page
          .evaluate(() => window.desktop!.agentContext!())
          .then((value) => value.editor?.selectionIds.length),
      )
      .toBe(1);
    const initial = await context(client);
    const before = await page.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      initial.document!.id,
    );
    const scope = {
      documentId: initial.document!.id,
      epoch: initial.document!.epoch,
      revision: initial.document!.revision,
    };
    const inspected = await client.callTool({
      name: "showme.inspect",
      arguments: {
        ...scope,
        target: { type: "slide", slideId: initial.editor!.page.id },
      },
    });
    expect(inspected.isError).toBe(false);
    expect(JSON.stringify(inspected)).toContain("Read-only MCP title");
    expect(JSON.stringify(inspected)).not.toContain("PRIVATE_NOTES");
    const selection = await client.callTool({
      name: "showme.inspect",
      arguments: {
        ...scope,
        target: { type: "selection", uiEpoch: initial.uiEpoch },
      },
    });
    expect(selection.structuredContent).toMatchObject({
      ok: true,
      data: { elements: [{ id: initial.editor!.selectionIds[0] }] },
    });
    const args = {
      ...scope,
      slideId: initial.editor!.page.id,
      width: 320,
      height: 180,
    };
    const image = await client.callTool({
      name: "showme.preview",
      arguments: args,
    });
    expect(image.isError).toBe(false);
    expect(image.structuredContent).toMatchObject({
      ok: true,
      ...args,
      state: "base",
      mimeType: "image/png",
    });
    expect(image.structuredContent).not.toHaveProperty("pngDataUrl");
    const png = image.content.find((block) => block.type === "image");
    if (!png || png.type !== "image") throw new Error("Missing MCP image");
    expect(
      await sharp(Buffer.from(png.data, "base64")).metadata(),
    ).toMatchObject({ format: "png", width: 320, height: 180 });
    expect(
      await page.evaluate(
        (id) => window.desktop!.documentProjection!(id),
        scope.documentId,
      ),
    ).toEqual(before);
    expect((await context(client)).editor).toEqual(initial.editor);
    expect((await context(client)).uiEpoch).toBe(initial.uiEpoch);
    const directory = path.join(f.user, "mcp", "instances");
    const old = JSON.parse(
      await readFile(
        path.join(directory, (await readdir(directory))[0]),
        "utf8",
      ),
    ) as BridgeDescriptor;
    // Hold the real native composer to put the stdio call in flight across revocation.
    const preview = app
      .windows()
      .find((window) => window.url().includes("slidePreview=1"))!;
    await preview.evaluate(() => {
      const compose = window.composeSlidePreview!;
      Object.assign(window, { entered: false, release: null });
      window.composeSlidePreview = async (...args) => {
        Object.assign(window, { entered: true });
        await new Promise<void>((resolve) =>
          Object.assign(window, { release: resolve }),
        );
        return compose(...args);
      };
    });
    const pending = client.callTool({
      name: "showme.preview",
      arguments: args,
    });
    await expect
      .poll(() => preview.evaluate(() => (window as any).entered))
      .toBe(true);
    const measuredWhilePreviewBlocked = await client.callTool({
      name: "showme.measure_text",
      arguments: {
        ...scope,
        items: [
          {
            text: "A paragraph that should wrap over several lines at this narrow width.",
            width: 220,
            typography: {
              fontFamily: "Arial",
              fontSize: 32,
              fontWeight: 400,
              lineHeight: 1.2,
              letterSpacing: 0,
            },
          },
          {
            text: "Short line",
            width: 800,
            typography: {
              fontFamily: "Arial",
              fontSize: 32,
              fontWeight: 400,
              lineHeight: 1.2,
              letterSpacing: 0,
            },
          },
        ],
      },
    });
    expect(
      measuredWhilePreviewBlocked.isError,
      JSON.stringify(measuredWhilePreviewBlocked.structuredContent),
    ).toBe(false);
    const measurements = (measuredWhilePreviewBlocked.structuredContent as any)
      .measurements;
    expect(measurements).toHaveLength(2);
    expect(measurements[0].height).toBeGreaterThan(measurements[1].height);
    expect(measurements.every((value: any) => value.width > 0)).toBe(true);
    await settings(page);
    await page.getByLabel("Enable MCP", { exact: true }).uncheck();
    expect((await pending).structuredContent).toMatchObject({
      ok: false,
      error: { code: "APP_UNAVAILABLE" },
    });
    await expect.poll(() => preview.isClosed()).toBe(true);
    await page.getByLabel("Enable MCP", { exact: true }).check();
    await expect(
      page.getByText("Local connection is ready.", { exact: true }),
    ).toBeVisible();
    await expect(
      bridgeRead(old, { command: "context", params: {} }),
    ).rejects.toThrow();
    expect((await context(client)).enabled).toBe(true);
    expect(connected.errors).toEqual([]);
    expect(connected.stderr.join("")).not.toContain(old.token);
    await client.close();
    client = undefined;
    await expect
      .poll(() => {
        try {
          process.kill(connected.transport.pid!, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

test("MCP creative authoring validates live GLSL CSS text-JS and native Effect Motion", async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    const page = launched.page;
    client = (await connect(f.user, f.folder)).client;
    await page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });

    const initial = (await context(client)) as AgentContext & {
      serverVersion?: string;
      effectApiVersion?: number;
      capabilities?: Record<string, boolean>;
    };
    expect(initial.serverVersion).toBe(SHOWME_MCP_SERVER_VERSION);
    expect(initial).not.toHaveProperty("effectApiVersion");
    expect(initial).not.toHaveProperty("capabilities");
    expect(initial).toHaveProperty("contractVersion", AGENT_CONTRACT_VERSION);


    const guide = await client.callTool({
      name: "showme.authoring",
      arguments: { kind: "background-shader" },
    });
    expect(guide.isError).toBe(false);
    expect(guide.structuredContent).toMatchObject({
      ok: true,
      data: {
        kind: "background-shader",
        effectApiVersion: 1,
        contract: { effectKind: "fragment-glsl", affects: "generated" },
        operationTemplate: { type: "background.shader.create" },
      },
    });
    expect(JSON.stringify(guide.structuredContent)).toContain(
      "#version 300 es",
    );

    const discovery = await Promise.all([
      { kind: "protocol" },
      { kind: "operations", operations: ["background.shader.create", "effect.apply_code", "presence.add", "element.insert_text", "element.insert_frame"] },
      { kind: "css-effect" },
    ].map((arguments_) => client!.callTool({ name: "showme.authoring", arguments: arguments_ })));
    for (const result of [guide, ...discovery]) {
      expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
      const text = result.content.find((item) => item.type === "text");
      expect(text?.type === "text" && JSON.parse(text.text)).toEqual(result.structuredContent);
    }
    expect(discovery[0].structuredContent).toMatchObject({ ok: true, data: { contractVersion: AGENT_CONTRACT_VERSION, limits: { nativeOperations: 256 } } });
    expect((discovery[0].structuredContent as any).data.capabilities).toMatchObject({ effectApiVersion: 1, features: { shaderEffects: true, cssEffects: true, presence: true }, runtime: { capacity: 8 } });
    expect(initial).toHaveProperty("services.agentRuntime.state");
    expect(initial).toHaveProperty("services.agentRuntime.pending");
    const contracts = (discovery[1].structuredContent as any).data;
    expect(contracts.operations).toHaveLength(5);
    expect(contracts).not.toHaveProperty("request");
    expect(contracts.rules.join(" ")).toContain("slide-end stop requires Exit None");
    expect((discovery[2].structuredContent as any).data.runtime.environment).toContain("nested @supports");
    const invalidDiscovery = await client.callTool({ name: "showme.authoring", arguments: { kind: "operations", operations: ["no.such_operation"] } });
    expect(invalidDiscovery.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", details: { issues: [{ path: "operations.0" }] } } });

    const slideId = initial.editor!.page.id;
    const slide = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: initial.document!.revision,
        target: { type: "slide", slideId },
      },
    });
    const root = (slide.structuredContent as any).data.layers[0].id;
    expect(root).toBeTruthy();

    const shader = `#version 300 es
precision highp float;
uniform float brightness; // @param 0.8 [0, 1]
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = vec4(0.1 * brightness, 0.7 * brightness, 0.3 * brightness, 1.0);
}`;
    const authored = await client.callTool({
      name: "showme.apply",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        expectedRevision: initial.document!.revision,
        mutationId: crypto.randomUUID(),
        slideId,
        operations: [
          {
            type: "deck.stylesheet.set",
            source: ".agent-accent { opacity: 0.95; }",
          },
          {
            type: "elements.css_classes.set",
            elementIds: ["title"],
            classes: ["agent-accent"],
          },
          {
            type: "effect.apply_code",
            elementId: "title",
            name: "Soft CSS",
            effectType: "css",
            affects: "element",
            source: ":scope { filter: brightness(0.95); }",
          },
          {
            type: "effect.apply_code",
            elementId: "title",
            name: "Uppercase",
            effectType: "text-js",
            affects: "text",
            source: "function render({ text }) { return text.toUpperCase(); }",
          },
          {
            type: "background.shader.create",
            name: "Green field",
            source: shader,
          },
        ],
      },
    });
    expect(authored.isError, JSON.stringify(authored.structuredContent)).toBe(
      false,
    );
    const receipt = authored.structuredContent as any;
    expect(receipt).toMatchObject({
      ok: true,
      createdIds: [expect.any(String)],
      createdEffectInstanceIds: [
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
    });
    const backgroundId = receipt.createdIds[0];

    const title = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: receipt.revision,
        target: {
          type: "elements",
          slideId,
          elementIds: ["title"],
          includeEffectSource: true,
        },
      },
    });
    const titleDetail = (title.structuredContent as any).data.elements[0];
    expect(titleDetail.cssClasses).toEqual(["agent-accent"]);
    expect(
      titleDetail.effects.map((effect: any) => effect.kind).sort(),
    ).toEqual(["css", "text-js"]);
    expect(
      titleDetail.effects.some(
        (effect: any) =>
          effect.kind === "text-js" && effect.source.includes("toUpperCase"),
      ),
    ).toBe(true);

    const background = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: receipt.revision,
        target: {
          type: "elements",
          slideId,
          elementIds: [backgroundId],
          includeEffectSource: true,
        },
      },
    });
    const backgroundDetail = (background.structuredContent as any).data
      .elements[0];
    const shaderEffect = backgroundDetail.effects[0];
    expect(shaderEffect.parameterContract).toMatchObject([
      {
        key: "brightness",
        type: "number",
        default: 0.8,
        min: 0,
        max: 1,
      },
    ]);
    expect(shaderEffect.source).toBe(shader);
    const property = shaderEffect.motionProperties[0];
    expect(property).toBe(`effects.${shaderEffect.id}.parameters.brightness`);

    const motion = await client.callTool({
      name: "showme.apply",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        expectedRevision: receipt.revision,
        mutationId: crypto.randomUUID(),
        slideId,
        operations: [
          {
            type: "motion.animate",
            stageIndex: 0,
            elementId: backgroundId,
            property,
            from: 0.8,
            to: 0.4,
            durationMs: 400,
            ease: "Ease Out",
          },
        ],
      },
    });
    expect(motion.isError, JSON.stringify(motion.structuredContent)).toBe(
      false,
    );
    const motionReceipt = motion.structuredContent as any;
    const animated = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: motionReceipt.revision,
        target: {
          type: "elements",
          slideId,
          elementIds: [backgroundId],
          includeMotion: true,
          includeEffectSource: true,
        },
      },
    });
    expect(
      (animated.structuredContent as any).data.elements[0].motion[0].properties,
    ).toContain(property);

    const existingGuide = await client.callTool({
      name: "showme.authoring",
      arguments: {
        kind: "background-shader",
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: motionReceipt.revision,
        slideId,
        elementId: backgroundId,
        effectInstanceId: shaderEffect.id,
      },
    });
    expect(existingGuide.structuredContent).toMatchObject({
      ok: true,
      data: {
        editing: true,
        operationTemplate: {
          source: shader,
          type: "effect.apply_code",
          elementId: backgroundId,
          existingInstanceId: shaderEffect.id,
        },
      },
    });

    const deck = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: motionReceipt.revision,
        target: { type: "deck", includeStylesheet: true },
      },
    });
    expect((deck.structuredContent as any).data.deck.stylesheet).toContain(
      ".agent-accent",
    );

    const preview = await client.callTool({
      name: "showme.preview",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: motionReceipt.revision,
        slideId,
        width: 320,
        height: 180,
      },
    });
    expect(preview.isError, JSON.stringify(preview.structuredContent)).toBe(
      false,
    );
    expect((preview.structuredContent as any).warnings).toEqual([]);
    const image = preview.content.find((item) => item.type === "image");
    if (!image || image.type !== "image")
      throw new Error("Missing creative preview");
    const { data, info } = await sharp(Buffer.from(image.data, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = ((info.height - 10) * info.width + (info.width - 10)) * 4;
    expect(data[offset + 1]).toBeGreaterThan(data[offset]);
    expect(data[offset + 1]).toBeGreaterThan(data[offset + 2]);

    const broken = await client.callTool({
      name: "showme.apply",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        expectedRevision: motionReceipt.revision,
        mutationId: crypto.randomUUID(),
        slideId,
        operations: [
          {
            type: "background.shader.create",
            name: "Broken shader",
            source:
              "#version 300 es\nprecision highp float;\nout vec4 outColor;\nvoid main(){ outColor = ; }",
          },
        ],
      },
    });
    expect(broken.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "EFFECT_VALIDATION_ERROR",
        details: {
          kind: "fragment-glsl",
          diagnostics: [expect.objectContaining({ severity: "error" })],
        },
      },
    });
    expect((await context(client)).document!.revision).toBe(
      motionReceipt.revision,
    );
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

test("stdio discovery survives an app crash restart and explicit document replacement without serving old content", async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    let launched = await launch(f.user, f.file);
    app = launched.app;
    await launched.page.evaluate(() => window.desktop!.setMcpEnabled!(true));
    const connected = await connect(f.user, f.folder);
    client = connected.client;
    const previous = await context(client);
    await close(app);
    app = undefined;
    expect(
      (await client.callTool({ name: "showme.context", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ error: { code: "APP_UNAVAILABLE" } });
    launched = await launch(f.user, f.file);
    app = launched.app;
    const current = await context(client);
    expect(current.document!.epoch).not.toBe(previous.document!.epoch);
    expect(
      (
        await client.callTool({
          name: "showme.inspect",
          arguments: {
            documentId: previous.document!.id,
            epoch: previous.document!.epoch,
            revision: previous.document!.revision,
            target: { type: "deck" },
          },
        })
      ).structuredContent,
    ).toMatchObject({ error: { code: "EPOCH_CONFLICT" } });
    const quitting = await launched.page.evaluate(() =>
      window.desktop!.getMcpConnection!(),
    );
    await launched.page.evaluate(
      (id) => window.desktop!.saveDocument!(id),
      current.document!.id,
    );
    const exited = app.waitForEvent("close", { timeout: 10000 });
    const closing = launched.page
      .evaluate((id) => window.desktop!.requestClose!(id), current.document!.id)
      .catch(() => {});
    await exited;
    await closing;
    app = undefined;
    expect(await readdir(path.join(f.user, "mcp", "instances"))).not.toContain(
      `${quitting.instanceId}.json`,
    );
    launched = await launch(f.user, f.file);
    app = launched.app;
    await launched.page.evaluate(() =>
      window.desktop!.createDocument("Replacement"),
    );
    await expect
      .poll(() =>
        launched.page
          .evaluate(() => window.desktop!.agentContext!())
          .then((value) => value.document?.name),
      )
      .toBe("Replacement");
    expect(
      (
        await client.callTool({
          name: "showme.inspect",
          arguments: {
            documentId: current.document!.id,
            epoch: current.document!.epoch,
            revision: current.document!.revision,
            target: { type: "deck" },
          },
        })
      ).structuredContent,
    ).toMatchObject({ error: { code: "DOCUMENT_NOT_ACTIVE" } });
    const own = await launched.page.evaluate(() =>
      window.desktop!.getMcpConnection!(),
    );
    await launched.page.evaluate(() => window.desktop!.setMcpEnabled!(false));
    expect(
      (await readdir(path.join(f.user, "mcp", "instances"))).some(
        (file) => file === `${own.instanceId}.json`,
      ),
    ).toBe(false);
    expect(
      await new ShowMeClient(f.user).read({ command: "context", params: {} }),
    ).toMatchObject({ error: { code: "APP_UNAVAILABLE" } });
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

test("MCP native templates shared resources recipes and workspace lifecycle", async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    await launched.page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });
    client = (await connect(f.user, f.folder)).client;
    const initial = await context(client);
    let revision = initial.document!.revision;
    const identity = {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
      },
      slideId = initial.editor!.page.id;
    const inspect = await client.callTool({
      name: "showme.inspect",
      arguments: { ...identity, revision, target: { type: "slide", slideId } },
    });
    const layerId = (inspect.structuredContent as any).data.layers[0].id;
    for (const operation of [
      { type: "deck.transition_defaults.set", kind: "fade" },
      { type: "unknown.operation" },
    ]) {
      const invalid = await client.callTool({
        name: "showme.apply",
        arguments: {
          ...identity,
          expectedRevision: revision,
          mutationId: crypto.randomUUID(),
          slideId,
          operations: [operation],
        },
      });
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { code: "INVALID_REQUEST" } },
      });
      expect(JSON.stringify(invalid).length).toBeLessThan(2500);
    }
    const apply = async (operations: unknown[], pageId = slideId) => {
      const result = await client!.callTool({
        name: "showme.apply",
        arguments: {
          ...identity,
          expectedRevision: revision,
          mutationId: crypto.randomUUID(),
          slideId: pageId,
          operations,
        },
      });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      revision = (result.structuredContent as any).revision;
      return result.structuredContent as any;
    };
    const created = await apply([
      { type: "template.create", id: "native-theme", background: "#101020" },
      {
        type: "element.insert_text",
        id: "native-label",
        parentId: layerId,
        text: "One shared theme",
        frame: { x: 40, y: 30, width: 700, height: 90 },
      },
      {
        type: "effect.apply_code",
        elementId: "native-label",
        effectType: "css",
        affects: "element",
        name: "Supports CSS",
        source:
          ":scope {opacity:0.9} @supports (color: color(display-p3 1 0 0)) { :scope { color: #aaffdd; } }",
      },
    ]);
    expect(created.createdTemplateIds).toEqual(["native-theme"]);
    const templ = await client.callTool({
      name: "showme.inspect",
      arguments: {
        ...identity,
        revision,
        target: {
          type: "slide",
          slideId: "native-theme",
          includeEffectResources: true,
        },
      },
    });
    expect(templ.isError, JSON.stringify(templ.structuredContent)).toBe(false);
    expect((templ.structuredContent as any).data.slide.background).toBe(
      "#101020",
    );
    await apply([
      { type: "slide.template.apply", templateId: "native-theme" },
      {
        type: "text.style.define",
        styleId: "native-style",
        name: "Modern heading",
        typography: { fontSize: 90, color: "#aaffdd" },
      },
      {
        type: "text.style.apply",
        elementIds: ["title"],
        styleId: "native-style",
      },
    ]);
    const duplicate = await apply([
      {
        type: "slide.duplicate",
        id: "native-recipe",
        name: "Recipe",
        textReplacements: { title: "New content" },
      },
    ]);
    expect(duplicate.createdSlideIds).toEqual(["native-recipe"]);
    const preview = await client.callTool({
      name: "showme.preview",
      arguments: {
        ...identity,
        revision,
        slideId: "native-recipe",
        width: 640,
        height: 360,
      },
    });
    expect(preview.isError, JSON.stringify(preview.structuredContent)).toBe(
      false,
    );
    const dirty = await client.callTool({
      name: "showme.workspace",
      arguments: {
        ...identity,
        expectedRevision: revision,
        action: "create",
        name: "Blocked dirty switch",
      },
    });
    expect(dirty.structuredContent).toMatchObject({
      error: { code: "DOCUMENT_DIRTY" },
    });
    expect(
      (
        await client.callTool({
          name: "showme.deliver",
          arguments: {
            ...identity,
            expectedRevision: revision,
            action: "save",
          },
        })
      ).isError,
    ).toBe(false);
    const media = path.join(f.root, "workspace-image.png");
    await sharp({
      create: { width: 24, height: 24, channels: 4, background: "#80ffcc" },
    })
      .png()
      .toFile(media);
    const svg = path.join(f.root, "workspace-vector.svg");
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="45"><rect width="90" height="45" fill="red"/></svg>',
    );
    const video = path.join(f.root, "prepared-red.webm");
    await fsCopyFixture(video);
    const oriented = path.join(f.root, "oriented.jpg");
    await sharp({
      create: { width: 120, height: 60, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(oriented);
    const undecodable = path.join(f.root, "undecodable.png");
    await writeFile(undecodable, "not a decodable image");
    const imported = await client.callTool({
      name: "showme.workspace",
      arguments: {
        ...identity,
        expectedRevision: revision,
        action: "import-assets",
        paths: [
          media,
          svg,
          video,
          oriented,
          undecodable,
          path.join(f.root, "missing.png"),
        ],
      },
    });
    expect(imported.structuredContent).toMatchObject({
      ok: true,
      data: {
        result: {
          atomic: false,
          assets: [
            { mediaType: "image", width: 24, height: 24 },
            { type: "svg", width: 90, height: 45 },
            {
              type: "video",
              width: 160,
              height: 90,
              duration: expect.any(Number),
            },
            { type: "image", width: 60, height: 120 },
            { type: "image", id: expect.any(String) },
          ],
          items: [
            { status: "imported", preparation: "prepared" },
            { status: "imported", preparation: "prepared" },
            { status: "imported", preparation: "prepared" },
            { status: "imported", preparation: "prepared" },
            {
              status: "imported",
              preparation: "unsupported",
              error: { code: "MEDIA_PREPARATION_UNSUPPORTED" },
            },
            { status: "failed", preparation: "not-attempted" },
          ],
        },
      },
    });
    const assetId = (imported.structuredContent as any).data.result.assets[0]
      .id;
    await apply([
      {
        type: "element.insert_media",
        id: "native-imported",
        assetId,
        parentId: layerId,
        frame: { x: 500, y: 400, width: 120, height: 120 },
      },
    ]);
    const videoId = (imported.structuredContent as any).data.result.assets[2]
      .id;
    const poster = await sharp(
      await readFile(path.join(f.user, "cache", "assets", videoId + ".jpg")),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    const center = (45 * poster.info.width + 80) * poster.info.channels;
    expect(poster.data[center]).toBeGreaterThan(220);
    expect(poster.data[center + 1]).toBeLessThan(35);
    await apply([
      {
        type: "element.insert_media",
        id: "native-video",
        assetId: videoId,
        parentId: layerId,
        frame: { x: 700, y: 400, width: 160, height: 90 },
      },
    ]);
    const mediaPreview = await client.callTool({
      name: "showme.preview",
      arguments: { ...identity, revision, slideId, width: 640, height: 360 },
    });
    expect(
      mediaPreview.isError,
      JSON.stringify(mediaPreview.structuredContent),
    ).toBe(false);
    expect(
      await client.callTool({
        name: "showme.deliver",
        arguments: { ...identity, expectedRevision: revision, action: "save" },
      }),
    ).toMatchObject({ isError: false });
    await app.evaluate((_electron, root) => {
      process.env.SHOWME_DOCUMENT_DIR = root;
    }, f.root);
    const packaged = await client.callTool({
      name: "showme.deliver",
      arguments: {
        ...identity,
        expectedRevision: revision,
        action: "package",
        packageOptions: { mediaLocked: false, speakerNotes: "remove" },
      },
    });
    expect(packaged.structuredContent, JSON.stringify(packaged)).toMatchObject({
      ok: true,
      data: {
        written: true,
        format: "smp",
        packageOptions: { mediaLocked: false, speakerNotes: "remove" },
      },
    });
    const packagePath = (packaged.structuredContent as any).data.destination;
    await launched.page
      .getByRole("button", { name: "Speaker Notes", exact: true })
      .click();
    const notesEditor = launched.page.getByLabel("Presenter notes", {
      exact: true,
    });
    await notesEditor.focus();
    const humanNotes = await notesEditor.inputValue();
    const busySwitch = await client.callTool({
      name: "showme.workspace",
      arguments: {
        ...identity,
        expectedRevision: revision,
        action: "create",
        name: "Must preserve focused editing",
      },
    });
    expect(busySwitch.structuredContent).toMatchObject({
      ok: false,
      error: { code: "EDITOR_BUSY" },
    });
    expect(await notesEditor.inputValue()).toBe(humanNotes);
    expect((await context(client)).document!.id).toBe(identity.documentId);
    await launched.page
      .getByRole("button", { name: "Speaker Notes", exact: true })
      .click();
    const createdDoc = await client.callTool({
      name: "showme.workspace",
      arguments: {
        ...identity,
        expectedRevision: revision,
        action: "create",
        name: "Native MCP creation",
      },
    });
    expect(
      createdDoc.isError,
      JSON.stringify(createdDoc.structuredContent),
    ).toBe(false);
    expect(createdDoc.structuredContent).toMatchObject({
      data: {
        result: {
          document: {
            id: expect.any(String),
            epoch: expect.any(String),
            revision: 0,
            savedRevision: 0,
            dirty: false,
          },
          initialPageIds: {
            slides: [expect.any(String)],
            templates: [expect.any(String)],
          },
          readiness: { authority: "ready", editor: "poll-context" },
        },
      },
    });
    await expect
      .poll(async () => (await context(client!)).availability)
      .toBe("ready");
    const current = await context(client);
    const opened = await client.callTool({
      name: "showme.workspace",
      arguments: {
        documentId: current.document!.id,
        epoch: current.document!.epoch,
        expectedRevision: current.document!.revision,
        action: "open",
        path: f.file,
      },
    });
    expect(opened.isError, JSON.stringify(opened.structuredContent)).toBe(
      false,
    );
    await expect
      .poll(async () => (await context(client!)).document?.id)
      .toBe(identity.documentId);
    const reopened = await context(client);
    const closed = await client.callTool({
      name: "showme.workspace",
      arguments: {
        documentId: reopened.document!.id,
        epoch: reopened.document!.epoch,
        expectedRevision: reopened.document!.revision,
        action: "close",
      },
    });
    expect(closed.isError, JSON.stringify(closed.structuredContent)).toBe(
      false,
    );
    await client.close();
    client = undefined;
    await close(app);
    app = undefined;
    const freshRoot = path.join(f.folder, "fresh-root"),
      freshUser = path.join(f.folder, "fresh-user");
    await mkdir(path.join(freshRoot, "ShowMe Library"), { recursive: true });
    await mkdir(freshUser);
    await writeFile(
      path.join(freshUser, "settings.json"),
      JSON.stringify({
        showMeRootPath: freshRoot,
        libraryLifecycleMode: "keep-all",
        storageWarningSeen: true,
      }),
    );
    const cold = await launch(freshUser, packagePath);
    app = cold.app;
    await cold.page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });
    client = (await connect(freshUser, f.folder)).client;
    const coldContext = await context(client);
    expect(coldContext.document!.id).not.toBe(identity.documentId);
    const coldIdentity = {
      documentId: coldContext.document!.id,
      epoch: coldContext.document!.epoch,
      revision: coldContext.document!.revision,
    };
    const coldSlide = await client.callTool({
      name: "showme.inspect",
      arguments: {
        ...coldIdentity,
        target: { type: "slide", slideId, includeNotes: true },
      },
    });
    expect(coldSlide.structuredContent).toMatchObject({
      ok: true,
      data: { slide: { notes: "" } },
    });
    const coldPreview = await client.callTool({
      name: "showme.preview",
      arguments: { ...coldIdentity, slideId, width: 640, height: 360 },
    });
    expect(coldPreview.structuredContent).toMatchObject({
      ok: true,
      warnings: [],
    });
    const image = coldPreview.content.find((c) => c.type === "image")!;
    const decoded = await sharp(Buffer.from((image as any).data, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (148 * decoded.info.width + 260) * decoded.info.channels;
    expect(decoded.data[pixel]).toBeGreaterThan(220);
    expect(decoded.data[pixel + 1]).toBeLessThan(35);
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});

async function fsCopyFixture(destination: string) {
  await writeFile(
    destination,
    await readFile(path.resolve("tests/fixtures/media/prepared-red.webm")),
  );
}


test("native media revocation during a held second decoder retains exact import receipts", async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const launched = await launch(f.user, f.file);
    app = launched.app;
    const page = launched.page;
    await page.evaluate(async () => {
      await window.desktop!.setMcpEnabled!(true);
      await window.desktop!.setMcpEditingEnabled!(true);
    });
    client = (await connect(f.user, f.folder)).client;
    const initial = await context(client);
    const before = await page.evaluate(id => window.desktop!.documentProjection!(id), initial.document!.id);
    const priorSurfaces = new Set(app.windows());
    const primed = await client.callTool({ name: "showme.measure_text", arguments: {
      documentId: initial.document!.id, epoch: initial.document!.epoch, revision: initial.document!.revision,
      items: [{ text: "Initialize media runtime", width: 400 }],
    } });
    expect(primed.isError, JSON.stringify(primed.structuredContent)).toBe(false);
    const runtime = app.windows().find(surface => surface.url().includes("slidePreview=1") && !priorSurfaces.has(surface))!;
    await runtime.evaluate(() => {
      const w = window as any;
      const prepare = w.prepareAgentMedia;
      w.mediaTestCalls = 0;
      w.prepareAgentMedia = async (asset: unknown) => {
        if (++w.mediaTestCalls === 2) {
          w.mediaTestHeld = true;
          await new Promise<void>(resolve => w.releaseMediaTest = resolve);
        }
        return prepare(asset);
      };
    });
    const paths: string[] = [];
    for (const color of ["red", "green", "blue"]) {
      const file = path.join(path.dirname(f.file), color + ".png");
      await sharp({ create: { width: 20, height: 20, channels: 3, background: color } }).png().toFile(file);
      paths.push(file);
    }
    const pending = client.callTool({ name: "showme.workspace", arguments: {
      documentId: initial.document!.id, epoch: initial.document!.epoch, expectedRevision: initial.document!.revision,
      action: "import-assets", paths,
    } });
    await expect.poll(() => runtime.evaluate(() => (window as any).mediaTestHeld)).toBe(true);
    await page.evaluate(() => window.desktop!.setMcpEditingEnabled!(false));
    await runtime.evaluate(() => (window as any).releaseMediaTest());
    const response = await pending;
    expect(response.isError, JSON.stringify(response.structuredContent)).toBe(false);
    expect(response.structuredContent).toMatchObject({ ok: true, data: { result: {
      atomic: false, assets: [{ id: expect.any(String) }, { id: expect.any(String) }],
      items: [
        { index: 0, status: "imported", preparation: "prepared" },
        { index: 1, status: "imported", preparation: "pending", error: { code: "MCP_ACCESS_CHANGED" } },
        { index: 2, status: "not-attempted", preparation: "not-attempted" },
      ],
    } } });
    expect(await runtime.evaluate(() => (window as any).mediaTestCalls)).toBe(2);
    expect(await page.evaluate(id => window.desktop!.documentProjection!(id), initial.document!.id)).toEqual(before);
    const after = await context(client);
    expect(after.document).toEqual(initial.document);
  } finally {
    await client?.close();
    await close(app);
    await rm(f.folder, { recursive: true, force: true });
  }
});
