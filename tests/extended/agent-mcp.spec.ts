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
import { newPresentationDocument } from "../../src/core/document";
import { createTextElement } from "../../src/core/text";
import { readyEditor } from "../helpers/startup";
import { bridgeRead, ShowMeClient } from "../../mcp/showmeClient";
import type { BridgeDescriptor } from "../../electron/agentBridge";
import type { AgentContext } from "../../src/core/agentContext";

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
  return { folder, user, file };
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
  const page = await app.firstWindow();
  await readyEditor(page);
  return { app, page };
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

test("MCP builds multiple styled slides with production text measurement and real pixels after capture resizing", async () => {
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
    const initial = await context(client);
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
      expect(result.isError, JSON.stringify(result.structuredContent)).toBe(
        false,
      );
      return result.structuredContent as any;
    };
    const anchor = initial.editor!.page.id;
    const first = await apply(anchor, [
      {
        type: "slide.create",
        afterId: anchor,
        name: "A local creative partner",
        background: "#152F32",
      },
    ]);
    const firstId = first.createdSlideIds[0];
    const second = await apply(anchor, [
      {
        type: "slide.create",
        afterId: firstId,
        name: "Keep a way back",
        background: "#F6F3EB",
      },
    ]);
    const secondId = second.createdSlideIds[0];
    const inspect = await client.callTool({
      name: "showme.inspect",
      arguments: {
        documentId: initial.document!.id,
        epoch: initial.document!.epoch,
        revision: second.revision,
        target: { type: "slide", slideId: firstId },
      },
    });
    const parentId = (inspect.structuredContent as any).data.layers[0].id;
    await apply(firstId, [
      { type: "deck.rename", name: "ShowMe MCP deck" },
      {
        type: "element.insert_text",
        parentId,
        frame: { x: 520, y: 300 , width: 800, height: 180 },\n        autoSize: "both",
        text: "Create locally.",
        typography: { fontSize: 100, color: "#F6F3EB", bold: true },
      },
      {
        type: "element.insert_shape",
        parentId,
        shape: "rectangle",
        frame: { x: 1200, y: 200, width: 400, height: 600 },
        appearance: { fill: "#D6ED88" },
      },
    ]);
    const styled = await apply(secondId, [
      {
        type: "slide.update",
        name: "Your edits stay recoverable",
        background: "#007F73",
      },
      {
        type: "element.insert_text",
        parentId,
        frame: { x: 520, y: 300 , width: 800, height: 180 },\n        autoSize: "both",
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
      expect(result.isError, JSON.stringify(result.structuredContent)).toBe(
        false,
      );
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
          frame: { x: 500, y: 400 , width: 800, height: 180 },\n        autoSize: "both",
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
      ).toEqual({ ...receipt, replayed: true });
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
      "showme.context",
      "showme.authoring",
      "showme.inspect",
      "showme.apply",
      "showme.preview",
    ]);
    expect(
      catalog.tools.every(
        (value) =>
          value.outputSchema &&
          value.annotations?.readOnlyHint === (value.name !== "showme.apply"),
      ),
    ).toBe(true);
    await settings(page);
    await page.getByLabel("Enable MCP", { exact: true }).check();
    await expect(
      page.getByText("Local connection is ready.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Copy client configuration", exact: true })
      .click();
    const configuration = JSON.parse(
      await page.evaluate(() => window.desktop!.readTextClipboard!()),
    );
    expect(configuration.mcpServers.showme).toEqual({
      command: "node",
      args: [helperPath(), "--user-data", f.user],
    });
    expect(JSON.stringify(configuration)).not.toContain("token");
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
    await settings(page);
    await page.getByLabel("Enable MCP", { exact: true }).uncheck();
    expect((await pending).structuredContent).toMatchObject({
      ok: false,
      error: { code: "APP_UNAVAILABLE" },
    });
    await preview.evaluate(() => (window as any).release());
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
