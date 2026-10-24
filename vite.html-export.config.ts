import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    outDir: "dist-html-export",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, "src/export/html/runtime.tsx"),
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
