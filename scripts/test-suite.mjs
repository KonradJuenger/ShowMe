import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  root,
  readRegistry,
  audit,
  statistics,
  select,
  runtimes,
} from "./test-registry.mjs";

function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Verification failed (${result.status ?? result.signal}): ${script} ${args.join(" ")}`,
    );
}
function npm(script) {
  run(process.env.npm_execpath, ["run", script]);
}
try {
  const [command = "core", area, ...extra] = process.argv.slice(2);
  if (
    ![
      "audit",
      "stats",
      "core",
      "feature",
      "extended",
      "full",
      "release",
      "deprecated",
    ].includes(command) ||
    extra.length ||
    (command !== "feature" && area)
  )
    throw new Error("Unknown test command/arguments");
  const registry = readRegistry();
  const counts = audit(registry);
  const stats = statistics(registry, counts);
  if (command === "audit") {
    const expected = JSON.stringify(stats, null, 2) + "\n";
    if (
      fs
        .readFileSync(`${root}/tests/stats.json`, "utf8")
        .replaceAll("\r\n", "\n") !== expected
    )
      throw new Error(
        "Stats are stale. Run npm run test:stats and commit tests/stats.json.",
      );
    console.log(
      `Registry valid: ${stats.activeTests} active tests in ${stats.activeGroups} groups.`,
    );
  } else if (command === "stats") {
    fs.writeFileSync(
      `${root}/tests/stats.json`,
      JSON.stringify(stats, null, 2) + "\n",
    );
    console.log(
      `ShowMe test suite\n\nActive tests: ${stats.activeTests} (${stats.activeGroups} groups)`,
    );
    for (const key of ["byTier", "byArea", "byRuntime"]) {
      console.log(`\n${key}:`);
      for (const [label, count] of Object.entries(stats[key]))
        console.log(`  ${label.padEnd(14)} ${count}`);
    }
    console.log(
      `\nDeprecated records: ${stats.deprecatedCount}\nQuarantined records: ${stats.quarantinedCount}`,
    );
  } else {
    const selected = select(registry, command, area);
    if (!selected.length)
      console.log(`No executable tests selected for ${command}.`);
    if (command === "release") {
      npm("build");
      npm("verify:build");
    } else if (
      selected.some(
        (entry) => entry.runtime === "electron" || entry.runtime === "packaged",
      )
    )
      npm("build");
    for (const runtime of runtimes) {
      const entries = selected.filter((entry) => entry.runtime === runtime);
      if (!entries.length) continue;
      if (runtime === "packaged") {
        if (!["win32", "darwin"].includes(process.platform))
          throw new Error(
            "Packaged release verification requires Windows or macOS; run on a supported host.",
          );
        // Build already ran above. Do not rebuild before packaging.
        run(`${root}/node_modules/electron-builder/cli.js`, [
          "--publish",
          "never",
        ]);
      }
      const env = {
        SHOWME_TEST_FILES: JSON.stringify(entries.map((entry) => entry.path)),
      };
      console.log(
        `\n${command}${area ? `/${area}` : ""}: ${entries.length} ${runtime} groups`,
      );
      if (runtime === "unit")
        run(`${root}/node_modules/vitest/vitest.mjs`, ["run"], env);
      else if (runtime === "electron") {
        // Each native group owns Electron processes and may host a Vite server.
        // Do not retain compiler/automation state across unrelated native groups.
        for (const entry of entries) {
          console.log(`\nNative group: ${entry.id}`);
          run(
            `${root}/node_modules/@playwright/test/cli.js`,
            [
              "test",
              "--config",
              "playwright.electron.config.ts",
              "--output",
              `test-results-electron/${entry.id}`,
            ],
            { SHOWME_TEST_FILES: JSON.stringify([entry.path]) },
          );
        }
      } else
        run(
          `${root}/node_modules/@playwright/test/cli.js`,
          [
            "test",
            "--config",
            runtime === "browser"
              ? "playwright.config.ts"
              : `playwright.${runtime}.config.ts`,
          ],
          env,
        );
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
