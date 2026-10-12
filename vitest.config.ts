import { defineConfig } from "vitest/config";
import registry from "./tests/registry.json" with { type: "json" };
const include: string[] = process.env.SHOWME_TEST_FILES
  ? JSON.parse(process.env.SHOWME_TEST_FILES)
  : registry
      .filter(
        (entry) =>
          entry.tier === "core" &&
          entry.status === "active" &&
          entry.runtime === "unit",
      )
      .map((entry) => entry.path);
export default defineConfig({ test: { include } });
