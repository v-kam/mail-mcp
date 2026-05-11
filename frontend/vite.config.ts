// Vite config for the mail-mcp admin UI.
//
// Builds into ./dist which is then embedded into the Rust binary at
// compile time via the `rust-embed` crate (see src/admin/static_files.rs).
// In development, the dev server proxies `/api/*` to the Rust admin
// server on 127.0.0.1:8080 so hot-reload works against a real backend.

import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
