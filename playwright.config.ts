import { defineConfig } from "@playwright/test";
import registry from "./tests/registry.json" with { type: "json" };
const port = process.env.SHOWME_TEST_PORT ?? "5173";
const selected: string[] = process.env.SHOWME_TEST_FILES
  ? JSON.parse(process.env.SHOWME_TEST_FILES)
  : registry
      .filter(
        (entry) =>
          entry.status === "active" &&
          entry.tier === "extended" &&
          entry.runtime === "browser",
      )
      .map((entry) => entry.path);
export default defineConfig({
  testDir: "tests",
  testMatch: selected.map((file) => "**/" + file.slice("tests/".length)),
  timeout: 60000,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "test-results-browser",
  use: {
    launchOptions: { args: ["--enable-blink-features=CanvasDrawElement"] },
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
