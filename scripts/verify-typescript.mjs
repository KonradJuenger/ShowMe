import { execSync } from "node:child_process";

const version = (command) =>
  execSync(`${command} --version`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const ts7 = version("tsc");
const ts6 = version("tsc6");

if (!/^Version 7\./.test(ts7)) {
  throw new Error(`Expected TypeScript 7 from tsc, got: ${ts7}`);
}
if (!/^Version 6\./.test(ts6)) {
  throw new Error(`Expected TypeScript 6 from tsc6, got: ${ts6}`);
}

console.log(`${ts7}; ${ts6}`);
