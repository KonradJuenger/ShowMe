import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const html = await readFile(path.join(dist, "index.html"), "utf8");

if (!html.includes('http-equiv="Content-Security-Policy"')) {
  throw new Error("Production CSP is missing from dist/index.html");
}
if (html.includes('/src/main.tsx')) {
  throw new Error("Development entrypoint leaked into the production build");
}

const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((url) => !url.startsWith("data:"));

if (!assetUrls.some((url) => /\.js(?:\?|$)/.test(url))) {
  throw new Error("No renderer JavaScript bundle referenced by dist/index.html");
}

for (const url of assetUrls) {
  if (url.startsWith("/") || /^[a-z]+:/i.test(url)) {
    throw new Error(`Production asset URL is not relative: ${url}`);
  }
  const clean = url.split(/[?#]/, 1)[0].replace(/^\.\//, "");
  await access(path.join(dist, clean));
}

for (const file of [
  "dist-electron/main.cjs",
  "dist-electron/main.cjs.map",
  "dist-electron/preload.cjs",
  "dist-electron/preload.cjs.map",
]) {
  await access(path.join(root, file));
}

console.log("Build invariants verified");
