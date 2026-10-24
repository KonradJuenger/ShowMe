import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  publicDir: false,
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2022",
    outDir: "dist-html-export",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(
        new URL("./src/export/html/runtime.tsx", import.meta.url),
      ),
      name: "ShowMeHtmlRuntime",
      formats: ["iife"],
      fileName: () => "showme-html-runtime.js",
      cssFileName: "showme-html-runtime",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
