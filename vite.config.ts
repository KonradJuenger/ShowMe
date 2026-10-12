import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command }) => ({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: ["index.html"],
    },
  },
  plugins: [
    react(),
    {
      name: "development-csp",
      transformIndexHtml(html) {
        return command === "serve"
          ? html.replace(
              /<meta http-equiv="Content-Security-Policy"[^>]*\/>/,
              "",
            )
          : html;
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/release/**",
        "**/test-results*/**",
        "**/playwright-report*/**",
      ],
    },
  },
}));
