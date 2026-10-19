import { build } from "esbuild";
await build({
  entryPoints: {
    main: "electron/bootstrap.ts",
    preload: "electron/preload.ts",
    imageWorker: "electron/imageWorker.ts",
    "showme-mcp": "mcp/stdio.ts",
  },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "sharp"],
  sourcemap: true,
});
