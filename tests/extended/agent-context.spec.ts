import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readyEditor } from "../helpers/startup";

async function launch() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "showme-agent-context-"));
  const root = path.join(folder, "root");
  await mkdir(path.join(root, "ShowMe Library"), { recursive: true });
  await mkdir(path.join(folder, "user"));
  await writeFile(
    path.join(folder, "user", "settings.json"),
    JSON.stringify({
      showMeRootPath: root,
      libraryLifecycleMode: "keep-all",
      storageWarningSeen: true,
    }),
  );
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
    args: [path.resolve("."), `--user-data-dir=${path.join(folder, "user")}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await readyEditor(page);
    return { app, page, folder };
  } catch (error) {
    await close(app, folder);
    throw error;
  }
}
async function close(app: ElectronApplication, folder: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  await rm(folder, { recursive: true, force: true });
}
async function settings(page: Page) {
  await page
    .getByRole("button", { name: "Presentation menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings…", exact: true }).click();
}
const read = (page: Page) =>
  page.evaluate(() => window.desktop!.agentContext!());

test("MCP setting gates live editor context, persists and survives UI replacement without stale selection", async () => {
  const { app, page, folder } = await launch();
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    expect(await read(page)).toMatchObject({
      enabled: false,
      availability: "disabled",
      editor: null,
      document: null,
    });
    await settings(page);
    const toggle = page.getByLabel("Enable MCP", { exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect
      .poll(async () => (await read(page)).availability)
      .toBe("ready");
    await page.screenshot({ path: "test-results-electron/mcp-settings.png" });
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    const initial = await read(page);
    await page.getByRole("button", { name: "Frame", exact: true }).click();
    await expect
      .poll(async () => (await read(page)).editor?.selectionIds.length)
      .toBe(1);
    const selected = await read(page);
    expect(selected.uiEpoch).toBeGreaterThan(initial.uiEpoch);
    expect(selected.editor!.page).toEqual(initial.editor!.page);
    await page
      .locator(".sidebar-mode-rail")
      .getByRole("button", { name: "Motion", exact: true })
      .click();
    await page
      .getByRole("button", { name: "+ Add Motion", exact: true })
      .click();
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await page
      .getByRole("button", { name: "Click Timeline", exact: true })
      .last()
      .click();
    await expect
      .poll(async () => (await read(page)).editor?.timeline?.stageIndex)
      .toBe(0);
    const dock = page.getByRole("region", {
      name: "Click Timeline",
      exact: true,
    });
    const more = dock.getByRole("button", {
      name: "More Click Timeline controls",
      exact: true,
    });
    if (await more.isVisible()) await more.click();
    const beforeAdd = await read(page);
    await dock.getByRole("button", { name: "Add Click", exact: true }).click();
    // Stage selection and seek are UI state; creating the Click above is a native edit.
    await expect
      .poll(async () => {
        const value = await read(page);
        return value.document!.revision > beforeAdd.document!.revision;
      })
      .toBe(true);
    const beforeSeek = await read(page);
    await dock.getByRole("button", { name: "Click 1", exact: true }).click();
    await expect
      .poll(async () => (await read(page)).editor?.timeline?.selectedStageIndex)
      .toBe(1);
    const sought = await read(page);
    expect(sought.uiEpoch).toBeGreaterThan(beforeSeek.uiEpoch);
    expect(sought.editor!.mode).toBe("motion-preview");
    expect(sought.document!.revision).toBe(beforeSeek.document!.revision);
    const revision = sought.document!.revision;
    await page.getByRole("button", { name: /Templates$/ }).click();
    await page
      .getByRole("button", { name: "Edit Template A", exact: true })
      .click();
    await expect
      .poll(async () => (await read(page)).editor?.page.kind)
      .toBe("template");
    const template = await read(page);
    expect(template.document!.revision).toBe(revision);
    expect(template.editor!.selectionIds).toEqual([]);
    expect(template.uiEpoch).toBeGreaterThan(selected.uiEpoch);
    await page.getByRole("button", { name: "Add slide", exact: true }).click();
    await expect
      .poll(async () => (await read(page)).editor?.page.kind)
      .toBe("slide");
    const next = await read(page);
    expect(next.editor!.page.id).not.toBe(initial.editor!.page.id);
    expect(next.editor!.selectionIds).toEqual([]);

    await page.reload();
    await readyEditor(page);
    await expect
      .poll(async () => (await read(page)).availability)
      .toBe("ready");
    const reloaded = await read(page);
    expect(reloaded.uiEpoch).toBeGreaterThan(next.uiEpoch);
    expect(reloaded.editor!.selectionIds).toEqual([]);
    expect(
      JSON.parse(
        await readFile(path.join(folder, "user", "settings.json"), "utf8"),
      ).mcpEnabled,
    ).toBe(true);
    const beforeDisable = reloaded.document!.revision;
    await settings(page);
    await page.getByLabel("Enable MCP", { exact: true }).uncheck();
    await expect
      .poll(async () => (await read(page)).availability)
      .toBe("disabled");
    expect((await read(page)).editor).toBeNull();
    const projection = await page.evaluate(
      (id) => window.desktop!.documentProjection!(id),
      reloaded.document!.id,
    );
    expect(projection.revision).toBe(beforeDisable);
    expect(
      JSON.parse(
        await readFile(path.join(folder, "user", "settings.json"), "utf8"),
      ).mcpEnabled,
    ).toBe(false);
    // All app preference writers share the settings queue, preserving simultaneous changes.
    await page.evaluate(() =>
      Promise.all([
        window.desktop!.setMcpEnabled!(true),
        window.desktop!.setImageCacheFormat!("jpg"),
      ]),
    );
    expect(
      JSON.parse(
        await readFile(path.join(folder, "user", "settings.json"), "utf8"),
      ),
    ).toMatchObject({ mcpEnabled: true, imageCacheFormat: "jpg" });
  } finally {
    await close(app, folder);
  }
});

test("context IPC validates strict payloads and does not grant other windows or subframes access", async () => {
  const { app, page, folder } = await launch();
  try {
    await page.evaluate(() => window.desktop!.setMcpEnabled!(true));
    await expect
      .poll(async () => (await read(page)).availability)
      .toBe("ready");
    const before = await read(page);
    const malformed = await page.evaluate(async () => {
      try {
        await window.desktop!.editorAgentContext!({
          type: "attach",
          documentId: "../outside",
          documentEpoch: "epoch",
        });
        return "allowed";
      } catch {
        return "rejected";
      }
    });
    expect(malformed).toBe("rejected");
    expect(
      await page.evaluate(() =>
        window.desktop!.editorAgentContext!({
          type: "attach",
          documentId: "notActive",
          documentEpoch: "epoch",
        }),
      ),
    ).toMatchObject({ accepted: false, token: null });
    const otherWindow = await app.evaluate(
      async ({ BrowserWindow }, preload) => {
        const other = new BrowserWindow({
          show: false,
          webPreferences: { preload, contextIsolation: true, sandbox: false },
        });
        try {
          await other.loadURL("about:blank");
          return await other.webContents.executeJavaScript(
            "window.desktop.agentContext().then(() => 'allowed', error => String(error))",
          );
        } finally {
          other.destroy();
        }
      },
      path.resolve("dist-electron/preload.cjs"),
    );
    expect(otherWindow).toContain("Unauthorized window");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.name = "agent-context-subframe";
      frame.srcdoc = "<p>Unprivileged frame</p>";
      document.body.append(frame);
    });
    await expect
      .poll(() =>
        page
          .frameLocator('iframe[name="agent-context-subframe"]')
          .locator("body")
          .evaluate(() => typeof window.desktop),
      )
      .toBe("undefined");
    const after = await read(page);
    expect(after.editor).toEqual(before.editor);
    expect(after.document!.revision).toBe(before.document!.revision);
  } finally {
    await close(app, folder);
  }
});
