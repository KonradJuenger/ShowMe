import { app, BrowserWindow } from "electron";
import path from "node:path";
import { windowOptions, secureWindow } from "../windowing";
import type {
  OutlineLayout,
  OutlineLayoutRequest,
} from "../../src/export/html/textOutlines";

/** Both export formats measure text on the existing native preview surface. */
export class ExportTextLayoutSurface {
  private window: BrowserWindow | undefined;
  async layout(request: OutlineLayoutRequest): Promise<OutlineLayout> {
    if (!this.window) {
      this.window = new BrowserWindow({
        ...windowOptions(),
        show: false,
        webPreferences: {
          ...windowOptions().webPreferences,
          backgroundThrottling: false,
        },
      });
      secureWindow(this.window);
      const devUrl = process.env.SHOWME_DEV_URL;
      if (devUrl && !app.isPackaged)
        await this.window.loadURL(devUrl + "?slidePreview=1");
      else
        await this.window.loadFile(path.join(__dirname, "../dist/index.html"), {
          query: { slidePreview: "1" },
        });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.window.webContents.executeJavaScript(
          `window.layoutHtmlExportText(${JSON.stringify(request)})`,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Text layout timed out")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  dispose() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}
