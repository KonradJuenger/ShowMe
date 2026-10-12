import { app, BrowserWindow } from "electron";
import path from "node:path";

export function windowOptions() {
  const icon = path.join(__dirname, "../dist/app-icon.png");
  if (process.platform === "darwin") app.dock?.setIcon(icon);
  return {
    icon,
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#ededeb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export function loadWindow(
  window: BrowserWindow,
  role?: "audience" | "console",
) {
  const url = process.env.SHOWME_DEV_URL;
  const query = new URLSearchParams({
    ...(role ? { present: role } : {}),
    ...(process.env.SHOWME_PERF === "1" ? { showmePerf: "1" } : {}),
  });
  if (url && !app.isPackaged)
    return window.loadURL(url + (query.size ? "?" + query : ""));
  return window.loadFile(path.join(__dirname, "../dist/index.html"), {
    query: Object.fromEntries(query),
  });
}

export function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}
