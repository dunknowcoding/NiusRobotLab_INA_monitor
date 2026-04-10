import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use TypeScript sources so `npm run dev` works without a prior `ina-monitor-core` build (`dist/`).
    alias: {
      "@niusrobotlab/ina-monitor-core": path.resolve(__dirname, "../ina-monitor-core/src/index.ts")
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist-renderer",
    sourcemap: true
  }
});

