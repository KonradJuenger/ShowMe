import { defineConfig } from "@playwright/test";
import registry from "./tests/registry.json" with { type: "json" };
const selected: string[] = process.env.SHOWME_TEST_FILES
  ? JSON.parse(process.env.SHOWME_TEST_FILES)
  : registry
      .filter(
        (entry) =>
          entry.status === "active" &&
          entry.tier === "release" &&
          entry.runtime === "electron",
      )
      .map((entry) => entry.path);
export default defineConfig({
  testDir: "tests",
  testMatch: selected.map((file) => "**/" + file.slice("tests/".length)),
  timeout: 60000,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "test-results-electron",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
