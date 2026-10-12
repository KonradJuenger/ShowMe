import { readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const targets = (await readdir(root, { withFileTypes: true }))
  .filter(
    (entry) =>
      (entry.isDirectory() &&
        /^(test-results(?:-.*)?|playwright-report(?:-.*)?)$/.test(
          entry.name,
        )) ||
      (entry.isFile() && entry.name.endsWith(".log")),
  )
  .map((entry) => path.resolve(root, entry.name));

// Only immediate generated output under this checkout is eligible. Never follow
// directory links or accept caller-supplied paths.
for (const target of targets) {
  if (path.dirname(target) !== root || (await lstat(target)).isSymbolicLink())
    throw new Error(`Refusing cleanup outside the checkout: ${target}`);
}
for (const target of targets)
  await rm(target, { recursive: true, force: true });
console.log(
  `Removed ${targets.length} generated report directories/log files.`,
);
